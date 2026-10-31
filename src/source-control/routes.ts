/**
 * dsh-source-control 宿主路由：以 POST /dsh-source-control/gg/api 暴露 git 命令集。
 *
 * 数据层由本目录的本地实现提供：提交图与仓库信息见 ./git-query.ts，各类操作见
 * ./git-actions.ts，工作区变更见 ./working-tree.ts。前端是主文档内的 React 面板。
 */
import type http from 'node:http';
import { onRepositoryWrite } from './git-exec.js';
import { AI_COMMIT_PROMPTS, fillPrompt } from './ai-commit-prompts.js';
import { clearDiscoveryCache } from './repo-discovery.js';
import { closeRepositoryWatchers, onRepositoryTreeChange } from './repo-watcher.js';
import { resolveGitDir } from './worktree-branches.js';
import { logError, logInfo, logWarn } from './logger.js';
import { recordCommandCost } from './api/cost.js';
import { collectDiff } from './commit-diff.js';
import { coalesceKeyOf, readBody, sendBadRequest, sendJson } from './api/http.js';
import { broadcastRepositoryTree, broadcastRepositoryWrite, handleEvents } from './api/events.js';
import type { AiCommitDeps } from './ai-deps.js';
import type { ApiContext } from './api/context.js';
import { handleWorkspaceCommand } from './api/workspace.js';
import { handleStateCommand } from './api/state.js';
import { handleRepoCommand } from './api/repos.js';
import { handleGraphCommand } from './api/graph.js';
import { handleHistoryCommand } from './api/history.js';
import { handleMiscCommand } from './api/misc.js';

/** 不要求会话仓库的命令：日志位置、反馈与客户端日志与仓库无关。 */
const REPO_FREE_COMMANDS: ReadonlySet<string> = new Set(['feedbackInfo', 'submitFeedback', 'logEvent']);

/*
 * 并发请求合并：同一仓库、同一命令、同一参数的请求同时到达时只执行一轮，其余等它的结果。
 *
 * 多个面板同时打开同一仓库时（多标签页、多窗口），一次写事件会让它们同时重取；不合并的话
 * 每个面板各起一遍 git 与解析。命中缓存的请求很便宜，因此只合并真正可能要取数的命令。
 */

/** 可以合并的只读命令。 */
const COALESCABLE_COMMANDS: ReadonlySet<string> = new Set(['loadCommits', 'loadWorkingTreeSnapshot', 'loadRepoInfo']);

/**
 * 合并等待的上限（毫秒）。
 *
 * 超过它按超时回投，不无限等待：某个请求的处理体异常退出而没回投时，后来者不能一直挂着。
 */
const COALESCE_TIMEOUT_MS = 30_000;

/** 在飞的合并项：键为命令 + 仓库 + 参数，值为最终回投的载荷。 */
const inFlightPayloads = new Map<string, Promise<Record<string, unknown>>>();
/** 仓库判定结果的缓存有效期（毫秒）。
 *
 * 判定要逐级向上找 `.git`，每次刷新对同一路径反复判会重复读盘。仓库被创建或删除属于结构变化，
 * 由仓库监视经 `invalidateCache` 之外的事件流通知，因此短有效期足够。
 */
const REPO_PATH_TTL_MS = 5000;

/** 仓库判定缓存：规范化路径 → 结果与过期时刻。 */
const repoPathChecks = new Map<string, { value: boolean; expiresAt: number }>();
/**
 * 处理一条 API 命令。
 *
 * @param req - 请求。
 * @param res - 响应。
 * @param aiDeps - AI 与翻译依赖面；翻译服务可选装载，缺失时相关命令降级。
 */
async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, aiDeps?: AiCommitDeps): Promise<void> {
	let msg: Record<string, unknown>;
	try {
		msg = await readBody(req);
	} catch {
		sendBadRequest(res, '请求体不是合法 JSON');
		return;
	}
	const repo = typeof msg.repo === 'string' ? msg.repo : '';
	const command = typeof msg.command === 'string' ? msg.command : '';
	// 单条命令只在失败时记日志；成功路径的耗时按「一次刷新」汇总。
	const started = Date.now();
	/**
	 * 客户端给出的轮次编号；0 与缺失都按「未给出」处理。
	 *
	 * 0 是旧版客户端的缺省值，与真实轮次 0 无法区分，因此统一当成没有编号。
	 */
	const refreshIdParam = typeof msg.refreshId === 'number' && msg.refreshId !== 0 ? msg.refreshId : null;
	// 日志与反馈与仓库无关：面板未选中仓库时也要能用。
	if (!repo && !REPO_FREE_COMMANDS.has(command)) {
		sendBadRequest(res, '缺少 repo');
		return;
	}

	/*
	 * 并发合并：同一键已有请求在飞时直接等它的载荷，不再执行一遍。
	 *
	 * 只合并能整份复用结果的只读命令；发送本身仍按各自的响应对象进行，因此两个面板都拿到
	 * 完整响应，只是背后只取了一次数。
	 */
	const coalesceKey = COALESCABLE_COMMANDS.has(command) ? coalesceKeyOf(command, repo, msg) : null;
	if (coalesceKey !== null) {
		const inFlight = inFlightPayloads.get(coalesceKey);
		if (inFlight !== undefined) {
			const shared = await inFlight;
			sendJson(res, 200, shared);
			recordCommandCost(command, Date.now() - started, repo, refreshIdParam);
			return;
		}
	}

	/** 本轮结果的落定函数；非合并命令为 null。 */
	let settleShared: ((payload: Record<string, unknown>) => void) | null = null;
	if (coalesceKey !== null) {
		let resolveShared: (payload: Record<string, unknown>) => void = () => { /* 先占位，随后覆盖 */ };
		const shared = new Promise<Record<string, unknown>>((resolve) => { resolveShared = resolve; });
		inFlightPayloads.set(coalesceKey, shared);
		const timer = setTimeout(() => {
			inFlightPayloads.delete(coalesceKey);
			resolveShared({ command, error: '并发合并超时' });
		}, COALESCE_TIMEOUT_MS);
		if (typeof timer.unref === 'function') timer.unref();
		settleShared = (payload) => {
			clearTimeout(timer);
			inFlightPayloads.delete(coalesceKey);
			resolveShared(payload);
		};
	}

	const str = (k: string): string => (typeof msg[k] === 'string' ? msg[k] : '');
	const strOrNull = (k: string): string | null => (typeof msg[k] === 'string' ? msg[k] : null);
	const bool = (k: string, dflt = false): boolean => (typeof msg[k] === 'boolean' ? msg[k] : dflt);
	const num = (k: string, dflt = 0): number => (typeof msg[k] === 'number' ? msg[k] : dflt);
	const arr = <T>(k: string): T[] => (Array.isArray(msg[k]) ? (msg[k] as T[]) : []);

	/**
	 * 判定目标路径是否在 git 仓库内。
	 *
	 * 只读命令在非仓库路径上必然失败：一次刷新会起五六个必定失败的子进程，日志也被错误填满。
	 * 判据用文件系统（逐级向上找 `.git`），不起子进程；结果按路径缓存，反复判只读一次盘。
	 *
	 * @param target - 目标路径。
	 * @returns 在仓库内时为 true。
	 */
	const isRepoPath = async (target: string): Promise<boolean> => {
		if (target === '') return false;
		const key = target.replace(/[\\/]+$/, '').toLowerCase();
		const cached = repoPathChecks.get(key);
		if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
		const value = await resolveGitDir(target) !== null;
		repoPathChecks.set(key, { value, expiresAt: Date.now() + REPO_PATH_TTL_MS });
		return value;
	};


	const respond = (payload: Record<string, unknown>): void => {
		// 所有命令级失败都经这里回投，因此错误日志只需挂在这一处。
		const error = payload.error;
		const failed = typeof payload.command === 'string' ? payload.command : command;
		if (typeof error === 'string' && error !== '') logError('api', `命令 ${failed} 执行失败：${error}`);
		// 先放行在等的合并请求：它们要的是载荷，与本请求的响应对象无关。
		settleShared?.(payload);
		sendJson(res, 200, payload);
	};
	/** 同步回投一条命令结果（无需等待异步操作）。 */
	const respondResultSync = (cmd: string, payload: Record<string, unknown>): void => {
		respond({ command: cmd, ...payload, error: null });
	};
	const respondError = async (cmd: string, fn: () => Promise<unknown>): Promise<void> => {
		respond({ command: cmd, error: await fn() });
	};

	/**
	 * 执行一条工作区操作：成功时把返回值并入响应，失败时以 `error` 回投。
	 *
	 * 与 `respondError` 的区别是后者的函数本身返回错误值；这里的函数返回数据或抛错。
	 *
	 * @param cmd - 命令名，原样回投。
	 * @param fn - 执行体，返回值会并入响应载荷。
	 */
	const respondResult = async (cmd: string, fn: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<void> => {
		try {
			respond({ command: cmd, ...(await fn()), error: null });
		} catch (error) {
			respond({ command: cmd, error: error instanceof Error ? error.message : String(error) });
		}
	};

	/** 各命令域；按声明顺序依次尝试，命中即结束。 */
	const ctx: ApiContext = {
		msg, repo, command, res, aiDeps,
		str, strOrNull, bool, num, arr, isRepoPath,
		respond, respondResultSync, respondError, respondResult,
		sendBadRequest: (message: string) => { sendBadRequest(res, message); },
	};
	/** 各命令域；按声明顺序依次尝试，命中即结束。 */
	const domains = [handleWorkspaceCommand, handleStateCommand, handleRepoCommand, handleGraphCommand, handleHistoryCommand, handleMiscCommand];
	for (const handle of domains) {
		if (await handle(ctx)) {
			recordCommandCost(command, Date.now() - started, repo, refreshIdParam);
			return;
		}
	}
	sendBadRequest(res, '未知命令: ' + String(msg.command));
	recordCommandCost(command, Date.now() - started, repo, refreshIdParam);
}

export interface GgRouteContext {
	register(spec: {
		kind: 'exact' | 'prefix';
		path: string;
		handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
	}): () => void;
}


/**
 * 语言提示词：告知模型用哪种语言写提交信息。
 *
 * 模型带提示词缓存，改语言会命中不同缓存；因此只在调用方给出语言时追加，
 * 未给出（空串）时提示词与以往完全一致，不破坏既有缓存。
 *
 * @param language - 语言标签，如 `zh-CN`；空串表示不指定。
 * @returns 追加到系统提示词末尾的一段文本；不指定时为空串。
 */
function languageDirective(language: string): string {
	if (language === '') return '';
	return '\n\n' + fillPrompt(AI_COMMIT_PROMPTS.language, { language });
}


/**
 * 查模型是否声明了 `off` 推理档位。
 * @param llm - llm 服务。
 * @param provider - 供应商 id。
 * @param model - 模型 id。
 * @returns 是否可安全发送 `reasoningEffort: 'off'`。
 */
async function canDisableReasoning(llm: unknown, provider: string, model: string): Promise<boolean> {
	const svc = llm as { resolveModelInfo?: (p: string, m: string) => Promise<unknown> };
	if (!provider || !model || typeof svc.resolveModelInfo !== 'function') return false;
	try {
		const info = await svc.resolveModelInfo(provider, model) as { reasoning?: { efforts?: Array<{ id?: string }> } };
		const efforts = info.reasoning?.efforts;
		if (!Array.isArray(efforts)) return false;
		return efforts.some((e) => e.id === 'off');
	} catch {
		return false;
	}
}

/**
 * 取 agent 当前默认模型选择。
 * @param getAgentDefaultModel - `ctx.get('agentDefaultModel')`。
 * @returns `{ provider, model }` 或 null。
 */
function getAgentDefaultSelection(getAgentDefaultModel?: () => unknown): { provider: string; model: string } | null {
	if (typeof getAgentDefaultModel !== 'function') return null;
	try {
		const svc = getAgentDefaultModel() as { currentSelection?: () => unknown };
		const sel = svc.currentSelection?.() as { provider?: string; model?: string } | null;
		if (sel === null || typeof sel !== 'object') return null;
		const provider = typeof sel.provider === 'string' ? sel.provider : '';
		const model = typeof sel.model === 'string' ? sel.model : '';
		return provider !== '' && model !== '' ? { provider, model } : null;
	} catch {
		return null;
	}
}

export function registerGgRoutes(webServer: GgRouteContext, aiDeps?: AiCommitDeps): Array<() => void> {
	const disposers: Array<() => void> = [];

	/**
	 * 注册一条只接受单一 HTTP 方法的精确路由。
	 *
	 * 方法不符时回 405 并给出 `allow`；符合时执行 `handler`。
	 *
	 * @param path - 路由路径。
	 * @param method - 允许的方法。
	 * @param handler - 方法符合时的处理函数。
	 * @returns 无。
	 */
	const registerMethodRoute = (
		path: string,
		method: 'GET' | 'POST',
		handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
	): void => {
		disposers.push(
			webServer.register({
				kind: 'exact',
				path,
				handler: (req, res) => {
					if (req.method !== method) {
						res.writeHead(405, { allow: method });
						res.end();
						return;
					}
					handler(req, res);
				},
			}),
		);
	};

	logInfo('source-control', '开始登记仓库监视：写事件、结构变化与事件流');

	// 仓库写操作（含别的会话、别的工作区与外部进程触发的）推给所有面板。
	disposers.push(onRepositoryWrite(broadcastRepositoryWrite));

	// 工作树登记、子模块目录与 `.gitmodules` 的变化推给所有面板：这类变化不经过执行层。
	disposers.push(onRepositoryTreeChange((repo) => {
		// 结构已变：发现结果缓存立即作废，重取才能看到新增或消失的工作树与子模块。
		clearDiscoveryCache();
		broadcastRepositoryTree(repo);
	}));
	disposers.push(closeRepositoryWatchers);
	logInfo('source-control', '仓库监视已登记，正在注册事件流与命令路由');

	// 事件流（GET）：面板据此即时反映别处的写操作。
	registerMethodRoute('/dsh-source-control/gg/events', 'GET', (req, res) => { handleEvents(req, res); });

	// 消息 API（POST）：前端面板与宿主之间的唯一通道。
	registerMethodRoute('/dsh-source-control/gg/api', 'POST', (req, res) => {
		void handleApi(req, res, aiDeps).catch((e: unknown) => {
			// 兜底：处理函数自身抛错时响应还没写，这里的错误以前只回给前端。
			const message = e instanceof Error ? e.message : String(e);
			logError('api', `处理请求时抛出未捕获的错误：${message}`);
			sendJson(res, 500, { error: message });
		});
	});

	// AI 模型目录（GET）：供应商列表 + 每供应商的模型 id。
	registerMethodRoute('/dsh-source-control/gg/ai-models', 'GET', (req, res) => {
		const llm = aiDeps?.getLlm?.() as { listProviders?: () => unknown[]; listModels?: (p: string) => Promise<unknown[]> } | undefined;
		if (!llm || typeof llm.listProviders !== 'function') {
			logWarn('ai', 'LLM 服务不可用，无法提供模型目录');
			sendJson(res, 200, { providers: [], modelsByProvider: {} });
			return;
		}
		const providers: Array<{ id: string; name: string }> = [];
		try {
			const raw = llm.listProviders();
			for (const p of (Array.isArray(raw) ? raw : [])) {
				const id = (p as { id?: string }).id ?? '';
				if (id.length > 0) providers.push({ id, name: (p as { name?: string }).name ?? id });
			}
		} catch { /* 目录不可用 */ }
		void (async () => {
			const modelsByProvider: Record<string, string[]> = {};
			for (const p of providers) {
				try {
					const list = typeof llm.listModels === 'function' ? await llm.listModels(p.id) : [];
					modelsByProvider[p.id] = (Array.isArray(list) ? list : [])
						.map((m) => (m as { id?: string }).id ?? '')
						.filter((id) => id.length > 0);
				} catch { modelsByProvider[p.id] = []; }
			}
			const fallback = getAgentDefaultSelection(aiDeps?.getAgentDefaultModel);
			sendJson(res, 200, { providers, modelsByProvider, fallback });
		})();
	});

	// AI 提交信息生成（POST，SSE 流式）：取暂存 diff → 调 llm.stream → 逐 chunk 推送。
	registerMethodRoute('/dsh-source-control/gg/ai-commit', 'POST', (req, res) => {
		void (async () => {
			const body = await readBody(req);
			const repo = typeof body.repo === 'string' ? body.repo : '';
			if (!repo) { sendJson(res, 400, { error: '缺少 repo' }); return; }
			const llm = aiDeps?.getLlm?.() as { stream?: (opts: unknown) => AsyncIterable<{ content?: string }> } | undefined;
			if (!llm || typeof llm.stream !== 'function') { sendJson(res, 503, { error: 'llm 服务不可用' }); return; }

			// 模型解析：请求指定 > agent 默认（附警告）
			let provider = typeof body.provider === 'string' ? body.provider : '';
			let model = typeof body.model === 'string' ? body.model : '';
			let warning = '';
			if (provider === '' || model === '') {
				const fallback = getAgentDefaultSelection(aiDeps?.getAgentDefaultModel);
				if (fallback !== null) { provider = fallback.provider; model = fallback.model; warning = '未配置专用模型，使用当前会话模型'; }
				else { sendJson(res, 400, { error: '未配置模型且无法获取当前会话模型' }); return; }
			}

			// 修补上一次提交时，把上一提交的改动一并纳入 diff。
			const amend = body.amend === true;
			const diff = await collectDiff(repo, amend);
			if (diff.trim() === '') {
				sendJson(res, 400, { error: amend ? '无 diff 可生成提交信息（上一次提交与工作区均无改动）' : '无 diff 可生成提交信息（暂存区与工作区均为空）' });
				return;
			}

			logInfo('ai', `开始生成提交信息：${provider}/${model}${amend ? '（修补）' : ''}，diff ${String(diff.length)} 字符`);
			const rules = typeof body.rules === 'string' ? body.rules.trim() : '';
			// 语言由前端给出（取自 DSH 当前界面语言）；空串时提示词与以往一致。
			const language = typeof body.language === 'string' ? body.language.trim() : '';
			const systemPrompt = AI_COMMIT_PROMPTS.system
				+ languageDirective(language)
				+ (rules.length > 0 ? '\n\n' + rules : '');
			const off = await canDisableReasoning(llm, provider, model);
			const request = fillPrompt(amend ? AI_COMMIT_PROMPTS.requestAmend : AI_COMMIT_PROMPTS.request, { diff });
			const streamOpts: Record<string, unknown> = {
				provider,
				model,
				system: systemPrompt,
				messages: [{ role: 'user', content: [{ type: 'text', text: request }] }],
				maxTokens: 512,
				temperature: 0,
			};
			if (off) streamOpts.reasoningEffort = 'off';

			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				'connection': 'keep-alive',
			});
			const sse = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
			if (warning !== '') sse('warning', warning);

			const startTime = Date.now();
			/*
			 * 首个输出增量到达的时刻，作为 tok/s 的计时起点。
			 *
			 * 起点不含请求上传与提示词处理时间。`text-delta` 与 `reasoning-delta` 都算
			 * 输出：`usage.outputTokens` 包含推理 token。
			 */
			let firstOutputTime: number | null = null;
			let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null = null;
			try {
				const stream = llm.stream(streamOpts) as AsyncIterable<{ type?: string; text?: string; reason?: { kind?: string; failure?: { code?: string; status?: number; message?: string } }; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>;
				for await (const chunk of stream) {
					if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
						if (firstOutputTime === null) firstOutputTime = Date.now();
						sse('chunk', chunk.text);
					} else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
						if (firstOutputTime === null) firstOutputTime = Date.now();
					} else if (chunk.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage;
					else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
						const f = chunk.reason.failure;
						const parts = [f?.code, f?.status === undefined ? undefined : `HTTP ${f.status}`, f?.message].filter((x): x is string => typeof x === 'string' && x.length > 0);
						sse('error', parts.length > 0 ? parts.join(' ') : '模型返回错误');
					}
				}
				const endTime = Date.now();
				const totalSec = (endTime - startTime) / 1000;
				/*
				 * 时长拆两段：`elapsed` 为解码时长（总时长扣除首 token 延迟），
				 * `ttft` 为首 token 延迟。全程无输出时 ttft 为 0、elapsed 为总时长。
				 */
				const ttftSec = firstOutputTime === null ? 0 : (firstOutputTime - startTime) / 1000;
				const elapsedSec = totalSec - ttftSec;
				const outTok = usage?.outputTokens ?? 0;
				const tps = elapsedSec > 0 && outTok > 0 ? Math.round(outTok / elapsedSec) : 0;
				sse('stats', {
					tps,
					elapsed: elapsedSec.toFixed(1) + 's',
					ttft: ttftSec.toFixed(1) + 's',
					inputTokens: usage?.inputTokens ?? 0,
					outputTokens: outTok,
					cacheReadTokens: usage?.cacheReadTokens ?? 0,
					cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
				});
				sse('done', '');
				logInfo('ai', `AI 提交信息生成完成：${provider}/${model}，${String(outTok)} token，${String(tps)} tok/s，耗时 ${totalSec.toFixed(1)}s`);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				logError('ai', `生成提交信息失败（${provider}/${model}）：${message}`);
				sse('error', message);
			}
			res.end();
		})().catch((e: unknown) => {
			/*
			 * 响应头发出前的失败（读请求体、取 diff、解析模型）按 JSON 回 500；此时没有
			 * 可用的 SSE 通道，不能走 `sse()`。响应头已发出时只结束响应。
			 */
			const message = e instanceof Error ? e.message : String(e);
			logError('ai', `AI 提交信息请求失败：${message}`);
			if (res.headersSent) {
				res.end();
				return;
			}
			sendJson(res, 500, { error: message });
		});
	});

	return disposers;
}