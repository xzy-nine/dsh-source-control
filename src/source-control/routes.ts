/**
 * dsh-source-control 宿主路由：以 POST /dsh-source-control/gg/api 暴露 git 命令集。
 *
 * 数据层由本目录的本地实现提供：提交图与仓库信息见 ./git-query.ts，各类操作见
 * ./git-actions.ts，工作区变更见 ./working-tree.ts。前端是主文档内的 React 面板。
 */
import type http from 'node:http';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {
	getBranchBase, getCommitComparison, getCommitDetails, getCommits, getConfig, getRefSummaries, getRepoInfo, getStashDetails,
	getRemoteNames, getStashes, getUncommittedDetails, getWorkingTreeSnapshot, repoRoot,
} from './git-query.js';
import {
	addRemote, addTag, applyStash, branchFromStash, checkoutBranch, checkoutCommit, cherrypickCommit,
	abortMerge, cleanUntrackedFiles, createBranch, deleteBranch, deleteRemote, deleteRemoteBranch, deleteTag,
	dropCommit, dropStash, editRemote, fetch, fetchIntoLocalBranch, merge, mergeCurrentIntoBranch, popStash,
	pruneRemote, pullBranch, pushBranchToMultipleRemotes, pushStash, pushTag, pushUpstream, rebase, renameBranch,
	resetFileToRevision, resetToCommit, revertCommit, setConfigValue, unsetConfigValue,
} from './git-actions.js';
import { commitStaged, discardPaths, gitOrThrow, gitSpawnCount, initSubmodule, loadWorkingTree, notifyRepositoryWrite, onRepositoryWrite, removeWorktree, runGit, stagePaths, unstagePaths, whenGitIdle, whenWorktreeIdle } from './working-tree.js';
import { collectDiff } from './commit-diff.js';
import { parseUnifiedDiffHunks, type DiffHunkText } from './diff-hunks.js';
import { branchesOfOtherWorktrees, clearDiscoveryCache, discoverWorkspace, enrichRepositories, loadRepoSync, loadReposSync, type RepoNode } from './repo-discovery.js';
import { closeRepositoryWatchers, onRepositoryTreeChange, watchRepositories, watchWorkspace } from './repo-watcher.js';
import { ghAccount, ghCreatePullRequest, ghCreateRepo, ghOwners, ghRepoInfo } from './gh-cli.js';
import { detectHooks } from './hooks.js';
import { addToGitignore, addToLocalExclude, localExcludeState } from './ignore.js';
import {
	invalidateRepo, readGraph, readHooksPath, readRepoInfo, readSnapshot, writeGraph, writeHooksPath,
	writeRepoInfo, writeSnapshot,
} from './host-cache.js';
import { sshStatus } from './ssh-status.js';
import { AI_COMMIT_PROMPTS, fillPrompt } from './ai-commit-prompts.js';
import { readEntries, readRepoLocations, writeEntry, writeRepoLocations } from './state-store.js';
import { repoHead, repoHeadHash } from './repo-facts.js';
import { resolveGitDir } from './worktree-branches.js';
import { currentLogFile, flushSync, log, logDebug, logError, logInfo, logRoot, logWarn, recentLogFiles, type LogLevel } from './logger.js';
import { submitFeedback } from './feedback.js';
import { formatBytes } from './feedback-text.js';
import type { StashEntry } from './git-types.js';

/** 不要求会话仓库的命令：日志位置、反馈与客户端日志与仓库无关。 */
const REPO_FREE_COMMANDS: ReadonlySet<string> = new Set(['feedbackInfo', 'submitFeedback', 'logEvent']);

/** 一次客户端日志上报接受的条数上限。 */
const MAX_CLIENT_LOG_ENTRIES = 200;

/**
 * 客户端给的级别归一化：只有调试、警告、错误三档与信息档，其余一律按信息处理。
 *
 * @param value - 客户端给出的级别字符。
 * @returns logcat 级别。
 */
function clientLogLevel(value: unknown): LogLevel {
	const level = typeof value === 'string' ? value.toUpperCase() : '';
	return level === 'D' || level === 'W' || level === 'E' ? level : 'I';
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}

function sendBadRequest(res: http.ServerResponse, message: string): void {
	logWarn('api', `请求被拒绝（400）：${message}`);
	sendJson(res, 400, { error: message });
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			try {
				resolve(chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {});
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
		req.on('error', reject);
	});
}

/** 事件流连接的保活间隔（毫秒）。 */
const EVENTS_HEARTBEAT_MS = 25000;

/** 事件流连接数上限：每个连接占一个响应流，不设上限时页面反复重连会累积。 */
const MAX_EVENT_STREAMS = 16;

/** 当前打开的事件流连接。 */
const eventStreams = new Set<http.ServerResponse>();

/**
 * 取节点树里全部可用节点的路径。
 *
 * 只有磁盘上确实存在的节点才纳入：目录已删除的工作树与子模块留在监视集合里，会让此后每一条
 * 名字缺失的事件都判定为仓库集合变化。
 *
 * @param nodes - 仓库节点列表。
 * @returns 全部可用路径，含工作树与子模块。
 */
function flattenRepoPaths(nodes: readonly RepoNode[]): string[] {
	const paths: string[] = [];
	const walk = (list: readonly RepoNode[]): void => {
		for (const node of list) {
			if (node.available) paths.push(node.path);
			walk(node.children);
		}
	};
	walk(nodes);
	return paths;
}

/**
 * 向所有事件流连接推送一条仓库变更。
 *
 * @param repo - 发生变更的仓库路径。
 * @returns 无。
 */
function broadcastRepositoryWrite(repo: string): void {
	broadcastEvent('repository-write', repo);
}

/**
 * 向所有事件流连接推送一条仓库结构变更。
 *
 * 结构变更指工作树登记、子模块目录或 `.gitmodules` 的变化；接收方据此重新枚举仓库树。
 *
 * @param repo - 结构发生变化的仓库路径。
 * @returns 无。
 */
function broadcastRepositoryTree(repo: string): void {
	broadcastEvent('repository-tree', repo);
}

/**
 * 向所有事件流连接推送一条事件帧。
 *
 * @param event - 事件名。
 * @param repo - 仓库路径。
 * @returns 无。
 */
function broadcastEvent(event: string, repo: string): void {
	// 事件本身即状态变化：写操作与结构变化的唯一记录点，同时记下发给了几个面板。
	const receivers = eventStreams.size;
	const suffix = receivers === 0 ? '（当前没有面板在监听，事件已丢弃）' : `（推送给 ${String(receivers)} 个面板）`;
	if (event === 'repository-tree') logInfo('watcher', `仓库结构已变化，通知面板重扫仓库树：${repo}${suffix}`);
	else logInfo('repo', `仓库已被写入，通知面板刷新工作区与提交图：${repo}${suffix}`);
	const frame = `event: ${event}\ndata: ${JSON.stringify({ repo })}\n\n`;
	for (const stream of eventStreams) {
		try {
			stream.write(frame);
		} catch {
			/* 连接已断开时由 close 事件清理 */
		}
	}
}

/**
 * 处理一条事件流连接。
 *
 * 通道只做一件事：把本进程里任何**成功**的仓库写操作推给所有面板，让别的会话、别的工作区与
 * 外部进程造成的改动也能即时反映。推送不携带数据，接收方自行重读。
 *
 * @param req - 请求。
 * @param res - 响应。
 * @returns 无。
 */
function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
	if (eventStreams.size >= MAX_EVENT_STREAMS) {
		logWarn('api', `事件流连接数已达上限 ${String(MAX_EVENT_STREAMS)} 条，拒绝新连接`);
		sendJson(res, 503, { error: '事件流连接数已达上限' });
		return;
	}
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-store',
		'connection': 'keep-alive',
	});
	res.write(': connected\n\n');
	eventStreams.add(res);
	logDebug('api', `面板已连接事件流，当前共 ${String(eventStreams.size)} 条连接`);
	const heartbeat = setInterval(() => {
		try {
			res.write(': ping\n\n');
		} catch {
			/* 写失败由 close 事件清理 */
		}
	}, EVENTS_HEARTBEAT_MS);
	// 保活不应阻止宿主退出。
	if (typeof heartbeat.unref === 'function') heartbeat.unref();
	/*
	 * `req` 与 `res` 的 close 都会触发，且同一次断开两者都会发；不幂等的话一条断开会被记两遍。
	 */
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		eventStreams.delete(res);
		logDebug('api', `面板已断开事件流，当前还剩 ${String(eventStreams.size)} 条连接`);
	};
	req.on('close', close);
	res.on('close', close);
}

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

/**
 * 生成合并键。
 *
 * `refreshId` 不参与：它是客户端各自的轮次编号，不影响取数结果。
 *
 * @param command - 命令名。
 * @param repo - 仓库路径。
 * @param msg - 请求体。
 * @returns 合并键。
 */
function coalesceKeyOf(command: string, repo: string, msg: Record<string, unknown>): string {
	const params: Record<string, unknown> = {};
	for (const key of Object.keys(msg).sort()) {
		if (key === 'command' || key === 'repo' || key === 'refreshId') continue;
		params[key] = msg[key];
	}
	return `${command}\u0000${repo.toLowerCase()}\u0000${JSON.stringify(params)}`;
}

/**
 * 读全部引用的签名。
 *
 * 抓取只改动引用与 `FETCH_HEAD`；签名前后一致即表示本次抓取没有拉回任何东西，
 * 不必让面板重取，也不必作废缓存。
 *
 * @param repo - 仓库路径。
 * @returns 引用名与哈希的拼接串；读取失败时为空串。
 */
async function refsSignature(repo: string): Promise<string> {
	const result = await runGit(['for-each-ref', '--format=%(refname)%00%(objectname)'], repo);
	return result.code === 0 ? result.stdout : '';
}
/**
 * 拼提交图窗口取数参数的可读描述。
 *
 * 键里含全部影响结果的参数，日志也要含它们：只给 skip 与 limit 时，同一秒内几次未命中
 * 无法判断是重复请求还是不同窗口。
 *
 * @param params - 取数参数。
 * @returns 一段可直接接在仓库路径后的描述。
 */
function graphParamsLog(params: {
	readonly head: string | null;
	readonly maxCommits: number;
	readonly skip: number;
	readonly ordering: string;
	readonly showTags: boolean;
	readonly showRemoteBranches: boolean;
	readonly showStashes: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly hideRemotes: readonly string[];
	readonly branches: readonly string[] | null;
	readonly remotes: readonly string[];
	readonly stashes: readonly string[];
}): string {
	const flags: string[] = [];
	if (params.skip !== 0) flags.push(`skip=${String(params.skip)}`);
	flags.push(`limit=${String(params.maxCommits)}`);
	if (params.ordering !== 'topo') flags.push(`排序=${params.ordering}`);
	if (!params.showTags) flags.push('无标签');
	if (!params.showRemoteBranches) flags.push('无远程分支');
	if (!params.showStashes) flags.push('无贮藏');
	if (params.onlyFollowFirstParent) flags.push('只跟第一个父提交');
	if (params.includeCommitsMentionedByReflogs) flags.push('含 reflog 提及');
	if (params.hideRemotes.length > 0) flags.push(`隐藏远程 ${params.hideRemotes.join(',')}`);
	if (params.branches !== null) flags.push(`引用 ${params.branches.length > 0 ? params.branches.join(',') : '（空）'}`);
	if (params.remotes.length > 0) flags.push(`远程 ${params.remotes.join(',')}`);
	// 贮藏键在调用方未给列表时是 `*`：与「确实没有贮藏」不是同一批提交行。
	if (params.stashes.length > 0) flags.push(`贮藏 ${params.stashes.join(',')}`);
	const head = params.head === null ? '分离头指针或未提交' : params.head.slice(0, 8);
	return `（HEAD ${head}，${flags.join('，')}）`;
}
/** 仓库判定结果的缓存有效期（毫秒）。
 *
 * 判定要逐级向上找 `.git`，每次刷新对同一路径反复判会重复读盘。仓库被创建或删除属于结构变化，
 * 由仓库监视经 `invalidateCache` 之外的事件流通知，因此短有效期足够。
 */
const REPO_PATH_TTL_MS = 5000;

/** 仓库判定缓存：规范化路径 → 结果与过期时刻。 */
const repoPathChecks = new Map<string, { value: boolean; expiresAt: number }>();
/** 非仓库路径上返回的空工作区快照。 */
const EMPTY_SNAPSHOT = {
	entries: [] as unknown[],
	head: null,
	branch: null,
	upstream: null,
	ahead: 0,
	behind: 0,
	merging: false,
	error: null,
};
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

	switch (msg.command as string) {
		/* --- 工作区变更（DSH 版新增：变更列表 / 暂存 / 提交 / 丢弃） --- */
		case 'loadWorkingTree':
			await respondResult('loadWorkingTree', async () => {
				// 写操作（暂存/提交/检出等）未结束时先等它结束：否则会读到写了一半的工作区。
				// 抓取不算：它不改工作区，等它会让面板在抓取期间白等几秒。
				await whenWorktreeIdle(repo);
				return { repo, entries: await loadWorkingTree(repo) };
			});
			break;
		case 'loadWorkingTreeSnapshot': {
			// 结果自带 error 字段，因此不经 respondResult —— 它会在展开后再写一次 error: null。
			// 只读工作区：抓取期间照常读，不必等它结束。
			await whenWorktreeIdle(repo);
			/*
			 * 非仓库路径直接回空快照，不起子进程：工作区根常常只是一层目录，对它取数会让
			 * 每条 git 命令都以 `not a git repository` 失败。
			 */
			if (!(await isRepoPath(repo))) {
				logDebug('repo', `目标路径不是 git 仓库，按空工作区返回：${repo}`);
				respond({ command: 'loadWorkingTreeSnapshot', repo, ...EMPTY_SNAPSHOT });
				break;
			}
			/*
			 * 快照键含 HEAD：外部进程的提交不产生写事件，缓存无从主动作废；带上 HEAD 后
			 * 那次提交不会命中提交前的条目。HEAD 由文件与分支引用解析，不起子进程。
			 *
			 * `noCache` 用于兜底轮询：它靠「读到当前值」发现插件之外的改动，命中缓存会让条目
			 * 签名永远不变，外部保存再也检测不到。写操作已失效缓存，写后重读不受本开关影响。
			 */
			const cachedSnapshot = bool('noCache') ? undefined : readSnapshot(repo, await repoHeadHash(repo));
			if (cachedSnapshot !== undefined) {
				logDebug('cache', `工作区快照命中缓存：${repo}`);
				respond({ command: 'loadWorkingTreeSnapshot', repo, ...cachedSnapshot });
				break;
			}
			const snapshot = await getWorkingTreeSnapshot(repo);
			// 失败结果同样缓存：紧接着的重试会命中，避免连续失败反复起 git。
			writeSnapshot(repo, snapshot);
			respond({ command: 'loadWorkingTreeSnapshot', repo, ...snapshot });
			break;
		}
		case 'stagePaths':
			await respondResult('stagePaths', async () => {
				const paths = arr<string>('paths');
				await stagePaths(repo, paths);
				logInfo('repo', `已暂存 ${String(paths.length)} 个路径：${paths.slice(0, 5).join('、')}${paths.length > 5 ? ' 等' : ''}`);
				return { repo };
			});
			break;
		case 'unstagePaths':
			await respondResult('unstagePaths', async () => {
				const paths = arr<string>('paths');
				await unstagePaths(repo, paths);
				logInfo('repo', `已取消暂存 ${String(paths.length)} 个路径：${paths.slice(0, 5).join('、')}${paths.length > 5 ? ' 等' : ''}`);
				return { repo };
			});
			break;
		case 'discardPaths':
			await respondResult('discardPaths', async () => {
				const paths = arr<string>('paths');
				const untracked = bool('untracked');
				const outcome = await discardPaths(repo, paths, untracked);
				logInfo('repo', `已丢弃 ${String(paths.length)} 个${untracked ? '未跟踪' : '已跟踪'}路径的改动`);
				return { repo, ...outcome };
			});
			break;
		case 'commitStaged':
			await respondResult('commitStaged', async () => {
				const amend = bool('amend');
				const skipHooks = bool('skipHooks');
				const hash = await commitStaged(repo, str('message'), amend, skipHooks);
				logInfo('repo', `提交成功${amend ? '（修补上一次提交）' : ''}${skipHooks ? '（已跳过钩子）' : ''}：${hash}`);
				return { repo, hash };
			});
			break;
		case 'addToGitignore':
			await respondResult('addToGitignore', async () => ({ result: await addToGitignore(repo, str('path')) }));
			break;
		case 'addToLocalExclude':
			await respondResult('addToLocalExclude', async () => ({ state: await addToLocalExclude(repo, str('path')) }));
			break;
		case 'localExcludeState':
			await respondResult('localExcludeState', async () => {
				// 非仓库路径没有本地排除文件：直接回空，不起 git rev-parse。
				if (!(await isRepoPath(repo))) return { state: null };
				return { state: await localExcludeState(repo) };
			});
			break;
		case 'removeWorktree':
			await respondResult('removeWorktree', async () => {
				const worktreePath = str('worktreePath');
				const force = bool('force');
				await removeWorktree(repo, worktreePath, force);
				logInfo('repo', `已移除工作树${force ? '（强制）' : ''}：${worktreePath}`);
				return { repo, worktreePath };
			});
			break;
		case 'initSubmodule':
			await respondResult('initSubmodule', async () => {
				const submodulePath = str('submodulePath');
				await initSubmodule(repo, submodulePath);
				logInfo('repo', `已初始化子模块：${submodulePath}`);
				return { repo, submodulePath };
			});
			break;
		case 'hooksState':
			await respondResult('hooksState', async () => {
				// 非仓库路径没有钩子目录：直接回空，不起 git config 与文件系统探测。
				if (!(await isRepoPath(repo))) return { repo, commit: false, push: false, directory: null };
				/*
				 * `core.hooksPath` 由 git 解析（含 includeIf 等条件），因此读它的取值而不是只看
				 * `.git/hooks`；读取失败时按未配置处理，退回默认钩子目录。
				 *
				 * 取值缓存 60s：同一仓库反复切换不必每次起一个 `git config`。钩子文件是否存在仍现读，
				 * 因此增删钩子文件立刻可见；配置本身的变化不走写事件，由 `invalidateCache` 作废。
				 */
				let hooksPath = readHooksPath(repo);
				if (hooksPath === undefined) {
					const configured = await runGit(['config', '--get', 'core.hooksPath'], repo);
					hooksPath = configured.code === 0 ? configured.stdout.trim() : '';
					writeHooksPath(repo, hooksPath);
				}
				const state = await detectHooks(repo, hooksPath);
				// 钩子决定提交与推送是否要带 --no-verify，判定结果值得留一条记录。
				logInfo('hooks', `钩子探测：${repo} 提交钩子=${state.commit ? '有' : '无'}、推送钩子=${state.push ? '有' : '无'}，目录 ${state.directory ?? '（无法定位）'}`);
				return { repo, commit: state.commit, push: state.push, directory: state.directory };
			});
			break;
		case 'branchesContaining':
			// 分支只由尖端提交标识，中间提交的 heads 为空；按包含关系查询才能列出所属分支。
			await respondResult('branchesContaining', async () => {
				const hash = str('commitHash');
				const localOut = await gitOrThrow(['branch', '--contains', hash, '--format=%(refname:short)'], repo);
				// 别的工作树占用的分支不可删除，不作为删除候选；`foreign` 另行回投，供调用方禁用相关操作。
				const foreign = await branchesOfOtherWorktrees(repo);
				const local = localOut.split('\n').map((line) => line.trim())
					.filter((line) => line !== '' && !foreign.has(line));
				const remoteOut = await gitOrThrow(['branch', '-r', '--contains', hash, '--format=%(refname:short)'], repo);
				// 远程 HEAD 是符号引用，短名只显示远程名本身（如 `origin`），须排除。
				const remoteNames = new Set((await gitOrThrow(['remote'], repo)).split('\n').map((line) => line.trim()));
				const remote = remoteOut.split('\n').map((line) => line.trim())
					.filter((line) => line !== '' && !line.endsWith('/HEAD') && !remoteNames.has(line));
				return { repo, local, remote, foreign: [...foreign] };
			});
			break;

		/* --- 仓库发现（DSH 版新增：≤3 层递归 + 工作树/子模块权威枚举） --- */
		/* --- 插件状态持久化：设置、布局、引用筛选、仓库位置缓存（落 $DSH_HOME/dsh-source-control/） --- */
		case 'readState':
			await respondResult('readState', () => ({ entries: readEntries() }));
			break;
		case 'writeState':
			await respondResult('writeState', () => {
				writeEntry(str('key'), msg.value === undefined ? null : msg.value);
				return { repo };
			});
			break;
		case 'readRepoLocations':
			await respondResult('readRepoLocations', () => ({ repos: readRepoLocations(repo) }));
			break;
		case 'writeRepoLocations':
			await respondResult('writeRepoLocations', () => {
				const repos = arr<{ path?: unknown; name?: unknown }>('repos')
					.filter((item) => typeof item.path === 'string' && item.path !== '')
					.map((item) => ({ path: item.path as string, name: typeof item.name === 'string' ? item.name : '' }));
				writeRepoLocations(repo, repos);
				return { repo };
			});
			break;
		case 'discoverRepositories':
			await respondResult('discoverRepositories', async () => {
				// knownRepos 命中时走快路径：只核对已知路径，不逐层扫描目录。
				const knownRepos = arr<string>('knownRepos').filter((path) => typeof path === 'string' && path !== '');
				const result = await discoverWorkspace(repo, {
					shallow: bool('shallow'),
					fullScan: bool('fullScan'),
					maxDepth: num('maxDepth', 3),
					knownRepos: knownRepos.length > 0 ? knownRepos : undefined,
				});
				// 顶层仓库纳入结构监视：工作树与子模块的增删由此即时反映。
				watchRepositories(result.nodes.filter((node) => node.kind === 'repo').map((node) => node.path));
				// 工作区根本身纳入监视：新建或删除的仓库此前没有任何句柄，只能由这一层发现。
				watchWorkspace(repo);
				return { root: repo, nodes: result.nodes, truncated: result.truncated, usedCache: result.usedCache };
			});
			break;
		case 'enrichRepositories':
			await respondResult('enrichRepositories', async () => {
				// 入参为空时不扫目录：nodes 为空数组。
				const repos = arr<string>('repos').filter((path) => typeof path === 'string' && path !== '');
				if (repos.length === 0) return { nodes: [] };
				const nodes = await enrichRepositories(repos);
				// 补齐结果里的工作树与子模块同样纳入监视：它们的登记项增删要即时反映。
				watchRepositories(flattenRepoPaths(nodes));
				return { nodes };
			});
			break;
		case 'loadRepoSync':
			await respondResult('loadRepoSync', async () => {
				// 读引用，不碰工作区：抓取期间照常读。
				await whenWorktreeIdle(repo);
				const sync = await loadRepoSync(repo);
				return { repo, branch: sync.branch, upstream: sync.upstream, ahead: sync.ahead, behind: sync.behind };
			});
			break;
		case 'loadReposSync':
			await respondResult('loadReposSync', async () => {
				// 入参路径逐个回显：结果按 path 与入参一一对应。
				const repos = arr<string>('repos').filter((path) => typeof path === 'string' && path !== '');
				// 空列表不读仓库：results 为空数组。
				if (repos.length === 0) return { repo, results: [] };
				await whenWorktreeIdle(repo);
				return { repo, results: await loadReposSync(repos) };
			});
			break;

		/* --- 数据查询 --- */
		case 'loadRepoInfo': {
			// 读远程与贮藏列表：不碰工作区，抓取期间照常读。
			await whenWorktreeIdle(repo);
			/*
			 * 非仓库路径直接回空信息，不起子进程。原先靠 getRepoInfo 失败后再启一次
			 * `git rev-parse` 反判，等于先失败一遍再确认。
			 */
			if (!(await isRepoPath(repo))) {
				logDebug('repo', `目标路径不是 git 仓库，按空仓库信息返回：${repo}`);
				respond({
					command: 'loadRepoInfo', refreshId: num('refreshId'),
					branches: [], head: null, remotes: [], stashes: [], error: null, isRepo: false,
				});
				break;
			}
			const showRemoteBranches = bool('showRemoteBranches', true);
			const showStashes = bool('showStashes', true);
			const hideRemotes = arr<string>('hideRemotes');
			let repoInfo = readRepoInfo(repo, { showRemoteBranches, showStashes, hideRemotes });
			if (repoInfo !== undefined) logDebug('cache', `仓库信息命中缓存：${repo}`);
			if (repoInfo === undefined) {
				repoInfo = await getRepoInfo(repo, showRemoteBranches, showStashes, hideRemotes);
				// 只缓存成功的读取：失败文本可能来自瞬时故障，缓存会让它停留整个 TTL。
				if (repoInfo.error === null) writeRepoInfo(repo, { showRemoteBranches, showStashes, hideRemotes }, repoInfo);
			}
			let isRepo = true;
			if (repoInfo.error) {
				isRepo = (await repoRoot(repo)) !== null;
				if (!isRepo) repoInfo = { ...repoInfo, error: null };
			}
			respond({ command: 'loadRepoInfo', refreshId: num('refreshId'), ...repoInfo, isRepo });
			break;
		}
		case 'loadCommits':
			// 提交图同样等写操作结束：写操作可能正在改写引用。
			await whenGitIdle(repo);
			/*
			 * 非仓库路径直接回空窗口：对工作区根取提交图必然失败，且每次要起 git log、
			 * for-each-ref 与 config 三条子进程。
			 */
			if (!(await isRepoPath(repo))) {
				logDebug('repo', `目标路径不是 git 仓库，按空提交图返回：${repo}`);
				respond({
					command: 'loadCommits',
					refreshId: num('refreshId'),
					error: null,
					onlyFollowFirstParent: bool('onlyFollowFirstParent'),
					commits: [],
					head: null,
					branch: null,
					tags: [],
					moreCommitsAvailable: false,
					nextSkip: 0,
					nextCursor: null,
					foreignBranches: [],
					repoInfo: null,
				});
				break;
			}
			{
				/*
				 * 偏移分页：客户端传 `skip`（已加载条数）与 `limit`，git 跳过前 skip 条再输出本页。
				 *
				 * 用偏移而不是 hash 游标：hash 游标只能从一个提交往更早方向走，向上回看时无法用它定位；
				 * 偏移则正反向都能取，代价是 git 端多遍历 skip 条（纯指针跳转，无 IO）。
				 */
				const limit = num('limit', num('maxCommits', 32));
				const skip = num('skip', 0);
				const showStashes = bool('showStashes', true);
				const showRemoteBranches = bool('showRemoteBranches', true);
				const hideRemotes = arr<string>('hideRemotes');
				const branchesArg = msg.branches === null || Array.isArray(msg.branches) ? (msg.branches as string[] | null) : null;
				/*
				 * 贮藏：调用方给出列表时以它为准（空数组同样表示没有贮藏）；未给出时按 `showStashes`
				 * 单独枚举。该取值同时交给仓库信息批与 `getCommits`，两者因此共用一次读取。
				 */
				const givenStashes = Array.isArray(msg.stashes) ? (msg.stashes as StashEntry[]) : null;
				/*
				 * 远程名：调用方在前端是 `Remote` 对象数组，数据层按远程名标注远程分支的归属，
				 * 这里取名字；直接传字符串数组的调用方同样接受。
				 *
				 * 客户端首次取数后即持有远程列表并随每次刷新传入。空列表与「未提供」不同：仓库确实没有
				 * 远程时客户端传的是空列表，此时不能回退去读远程名，否则无远程的仓库每次刷新都多起一个
				 * 子进程。
				 */
				const remotesGiven = Array.isArray(msg.remotes);
				const givenRemotes = arr<unknown>('remotes')
					.map((remote) => (typeof remote === 'string' ? remote : (remote as { name?: unknown } | null)?.name))
					.filter((name): name is string => typeof name === 'string' && name !== '');
				/*
				 * 缓存键含全部会改变 `getCommits` 结果的参数：除排序、分页与引用筛选外，贮藏标识与
				 * 远程名也参与组装提交行，参数不同必须落到不同的窗口。HEAD 同样参与：提交集的
				 * 起点含 HEAD，外部进程的提交不产生写事件，只有键随 HEAD 变化才能自然失配。
				 *
				 * HEAD 由 `HEAD` 文件与分支引用解析，不起子进程；同一次读取还给出当前分支名，随响应
				 * 回投供客户端在未取仓库信息时填补 `head`。
				 */
				const head = await repoHead(repo);
				const graphParams = {
					head: head?.hash ?? null,
					maxCommits: limit, skip,
					ordering: (typeof msg.commitOrdering === 'string' ? msg.commitOrdering : 'topo'),
					showTags: bool('showTags', true),
					showRemoteBranches,
					showStashes,
					onlyFollowFirstParent: bool('onlyFollowFirstParent'),
					includeCommitsMentionedByReflogs: bool('includeCommitsMentionedByReflogs'),
					hideRemotes,
					branches: branchesArg,
					remotes: givenRemotes,
					/*
					 * 贮藏标识：调用方未给出时为 `*`，表示由宿主按 `showStashes` 自行枚举——那份
					 * 结果通常非空，与「给出空列表」不是同一批提交行。
					 */
					stashes: givenStashes === null ? ['*'] : givenStashes.map((stash) => stash.hash),
				};
				/*
				 * 窗口缓存留在宿主内存：切回同一仓库、翻页回看已取过的窗口都命中，客户端不必
				 * 跨会话搬运数据。任何成功的仓库写操作都会清空该缓存。
				 */
				const cachedGraph = readGraph(repo, graphParams);
				if (cachedGraph !== undefined) {
					logDebug('cache', `提交图窗口命中缓存：${repo}${graphParamsLog(graphParams)}`);
					const lastCached = cachedGraph.commits.at(-1);
					/*
					 * 仓库信息同样来自宿主缓存：命中窗口时一并回投，客户端不必为远程与贮藏
					 * 再发一次请求。缓存里没有时留给客户端按需补取。
					 */
					const cachedInfo = readRepoInfo(repo, { showRemoteBranches, showStashes, hideRemotes }) ?? null;
					respond({
						command: 'loadCommits',
						refreshId: num('refreshId'),
						error: null,
						onlyFollowFirstParent: graphParams.onlyFollowFirstParent,
						commits: cachedGraph.commits,
						head: cachedGraph.head,
						branch: cachedGraph.branch,
						tags: cachedGraph.tags,
						moreCommitsAvailable: cachedGraph.moreCommitsAvailable,
						nextSkip: cachedGraph.nextSkip,
						nextCursor: cachedGraph.moreCommitsAvailable && lastCached !== undefined ? lastCached.hash : null,
						foreignBranches: cachedGraph.foreignBranches,
						repoInfo: cachedInfo,
					});
					break;
				}
				/*
				 * 仓库信息批由 `withRepoInfo` 显式控制，与「是否首屏」无关：刷新（skip 为 0）不必
				 * 重取仓库信息，调用方把已知的远程与贮藏随请求传入。
				 *
				 * 该批含仓库信息（内含引用与分支列表）、贮藏枚举与工作树分支，三者互不依赖，同批并行。
				 * 仓库信息以 `repoInfo` 随响应发回，客户端首次进入因此只发一次请求。
				 */
				const withRepoInfo = msg.withRepoInfo === true;
				/*
				 * 贮藏取自前面已解析的 `givenStashes`：给出列表时以它为准（空数组同样表示没有贮藏）；
				 * 未给出时按 `showStashes` 单独枚举。该取值同时交给仓库信息批与 `getCommits`，
				 * 两者因此共用一次读取。
				 */
				const stashesSource: Promise<StashEntry[]> = givenStashes !== null
					? Promise.resolve(givenStashes)
					: showStashes ? getStashes(repo) : Promise.resolve<StashEntry[]>([]);
				/*
				 * 仓库信息批：仓库信息（含引用与分支列表，一次 `for-each-ref` 同时得到两者）、贮藏与
				 * 别的工作树占用分支，三者互不依赖，同批并行。
				 *
				 * 提交图的引用标记不再来自这里：它取自同一次 `git log` 的装饰。
				 */
				const batchSource = withRepoInfo
					? Promise.all([
						getRepoInfo(repo, showRemoteBranches, showStashes, hideRemotes),
						stashesSource,
						branchesOfOtherWorktrees(repo),
					]).then(([info, stashes, foreign]) => ({ info, stashes, foreign }), () => null)
					: null;
				const stashes = await stashesSource;
				/*
				 * 别的工作树占用的分支：仓库信息批里已含该结果时直接取用，否则单独判定。
				 * 该判定对没有链接工作树的仓库只读文件系统，不启动 git；先发出去，不占关键路径。
				 *
				 * 同样先挂吞错分支：下游提前失败时，未处理的 rejection 会让宿主进程直接退出。
				 */
				const foreignSource: Promise<Set<string>> = (batchSource !== null
					? batchSource.then((batch) => batch?.foreign ?? branchesOfOtherWorktrees(repo))
					: branchesOfOtherWorktrees(repo)).catch(() => new Set<string>());
				/*
				 * 远程名可能来自仓库信息批，也可能需要单独读取。后者是一个 Promise：若下游在它
				 * 落地前就失败，未处理的 rejection 会让宿主进程直接退出（表现为 fatal load failure），
				 * 因此先挂一个吞错分支，真正的错误仍由 getCommits 内部的 catch 转成 error 字段。
				 */
				const remoteNames: readonly string[] | Promise<readonly string[]> = batchSource !== null
					? batchSource.then((batch) => batch?.info.remotes.map((remote) => remote.name) ?? givenRemotes)
					: remotesGiven ? givenRemotes : getRemoteNames(repo).catch(() => [] as string[]);
				// getCommits 内部已按「多取一条作哨兵」判断是否还有更多。
				logDebug('cache', `提交图窗口未命中缓存，重新取数：${repo}${graphParamsLog(graphParams)}`);
				const data = await getCommits(
					repo,
					branchesArg,
					limit,
					graphParams.showTags,
					showRemoteBranches,
					graphParams.includeCommitsMentionedByReflogs,
					graphParams.onlyFollowFirstParent,
					graphParams.ordering as never,
					remoteNames,
					hideRemotes,
					stashes,
					skip,
					head?.hash ?? null,
				);
				const batch = batchSource === null ? null : await batchSource;
				// 仓库信息成功取回时写入缓存，后续命中窗口的请求因此能一并回投它。
				if (batch !== null && batch.info.error === null) {
					writeRepoInfo(repo, { showRemoteBranches, showStashes, hideRemotes }, batch.info);
				}
				/*
				 * 别的工作树占用的分支照常作为标签显示：它们确实指向该提交，只是不能在本工作树里
				 * 检出或删除。这类分支名随响应回投，客户端据此禁用相应操作。
				 */
				const foreign = await foreignSource;
				const all = data.commits;
				// 游标取本页最后一条：git 会从该提交重新输出它，由客户端按 hash 去重。
				const last = all.at(-1);
				// 只缓存成功的读取：失败文本可能来自瞬时故障，缓存会让它停留整个 TTL。
				if (data.error === null) {
					writeGraph(repo, graphParams, {
						commits: all, head: data.head, branch: head?.branch ?? null, tags: data.tags,
						moreCommitsAvailable: data.moreCommitsAvailable, nextSkip: data.nextSkip,
						foreignBranches: [...foreign],
					});
				}
				respond({
					command: 'loadCommits',
					refreshId: num('refreshId'),
					// 成功路径的 error 恒为 null：既有契约要求该字段存在。
					error: null,
					onlyFollowFirstParent: graphParams.onlyFollowFirstParent,
					commits: all,
					head: data.head,
					// 当前分支名：与缓存键里的 HEAD 哈希是两个值，未取仓库信息时由客户端用它填补 `head`。
					branch: head?.branch ?? null,
					tags: data.tags,
					moreCommitsAvailable: data.moreCommitsAvailable,
					nextSkip: data.nextSkip,
					nextCursor: data.moreCommitsAvailable && last !== undefined ? last.hash : null,
					// 别的工作树占用的分支：客户端据此禁用检出、删除与重命名。
					foreignBranches: [...foreign],
					// 带 `withRepoInfo` 时随响应取回的仓库信息；其余请求为 null。
					repoInfo: batch?.info ?? null,
				});
			}
			break;
		case 'loadRefs':
			// 引用筛选弹窗与手选校验用：只在需要时读，刷新路径不调用。
			await respondResult('loadRefs', async () => ({ repo, refs: await getRefSummaries(repo, bool('showRemoteBranches', true)) }));
			break;
		case 'loadBranchBase':
			// 当前分支的分叉来源：自动筛选把它并入取数起点。
			await respondResult('loadBranchBase', async () => ({ repo, ...(await getBranchBase(repo)) }));
			break;
		case 'loadConfig':
			respond({ command: 'loadConfig', repo, ...(await getConfig(repo, arr('remotes'))) });
			break;
		case 'commitDetails': {
			const data = msg.commitHash === '*'
				? await getUncommittedDetails(repo)
				: msg.stash === null || msg.stash === undefined
					? await getCommitDetails(repo, str('commitHash'), bool('hasParents'))
					: await getStashDetails(repo, str('commitHash'), msg.stash as never);
			respond({ command: 'commitDetails', ...data, avatar: null, codeReview: null, refresh: bool('refresh') });
			break;
		}
		case 'compareCommits':
			respond({
				command: 'compareCommits',
				commitHash: str('commitHash'),
				compareWithHash: str('compareWithHash'),
				...(await getCommitComparison(repo, str('fromHash'), str('toHash'))),
				codeReview: null,
				refresh: bool('refresh'),
			});
			break;
		/* --- 分支操作 --- */
		case 'checkoutBranch': {
			const branchName = str('branchName');
			const errors: unknown[] = [await checkoutBranch(repo, branchName, strOrNull('remoteBranch'))];
			const pull = msg.pullAfterwards as Record<string, unknown> | null;
			if (errors[0] === null && pull) {
				errors.push(await pullBranch(repo, String(pull.branchName), String(pull.remote), Boolean(pull.createNewCommit), Boolean(pull.squash)));
			}
			if (errors.every((error) => error === null)) logInfo('repo', `已检出分支：${branchName}${pull ? '（并拉取）' : ''}`);
			respond({ command: 'checkoutBranch', pullAfterwards: msg.pullAfterwards ?? null, errors });
			break;
		}
		case 'createBranch':
			respond({ command: 'createBranch', errors: await createBranch(repo, str('branchName'), str('commitHash'), bool('checkout'), bool('force')) });
			break;
		case 'deleteBranch': {
			const branchName = str('branchName');
			const forceDelete = bool('forceDelete');
			const errors: unknown[] = [await deleteBranch(repo, branchName, forceDelete)];
			if (errors[0] === null) {
				logInfo('repo', `已删除本地分支${forceDelete ? '（强制）' : ''}：${branchName}`);
				for (const remote of arr<string>('deleteOnRemotes')) {
					errors.push(await deleteRemoteBranch(repo, branchName, remote));
				}
			}
			respond({ command: 'deleteBranch', repo, branchName: str('branchName'), deleteOnRemotes: arr('deleteOnRemotes'), errors });
			break;
		}
		case 'deleteRemoteBranch':
			await respondError('deleteRemoteBranch', () => deleteRemoteBranch(repo, str('branchName'), str('remote')));
			break;
		case 'renameBranch':
			await respondError('renameBranch', () => renameBranch(repo, str('oldName'), str('newName')));
			break;
		case 'fetchIntoLocalBranch':
			await respondError('fetchIntoLocalBranch', () => fetchIntoLocalBranch(repo, str('remote'), str('remoteBranch'), str('localBranch'), bool('force')));
			break;
		case 'pullBranch':
			await respondError('pullBranch', () => pullBranch(repo, str('branchName'), str('remote'), bool('createNewCommit'), bool('squash')));
			break;
		case 'pushBranch':
			respond({
				command: 'pushBranch',
				willUpdateBranchConfig: bool('willUpdateBranchConfig'),
				errors: await pushBranchToMultipleRemotes(repo, str('branchName'), arr('remotes'), bool('setUpstream'), (typeof msg.mode === 'string' ? msg.mode : '') as never, bool('skipHooks')),
			});
			break;
		case 'pushUpstream':
			await respondError('pushUpstream', () => pushUpstream(repo, bool('skipHooks')));
			break;

		/* --- 提交操作 --- */
		case 'checkoutCommit':
			await respondError('checkoutCommit', () => checkoutCommit(repo, str('commitHash')));
			break;
		case 'cherrypickCommit':
			respond({ command: 'cherrypickCommit', errors: [await cherrypickCommit(repo, str('commitHash'), num('parentIndex'), bool('recordOrigin'), bool('noCommit'))] });
			break;
		case 'dropCommit':
			await respondError('dropCommit', () => dropCommit(repo, str('commitHash')));
			break;
		case 'resetToCommit':
			await respondError('resetToCommit', () => resetToCommit(repo, str('commit'), (typeof msg.resetMode === 'string' ? msg.resetMode : 'mixed') as never));
			break;
		case 'revertCommit':
			await respondError('revertCommit', () => revertCommit(repo, str('commitHash'), num('parentIndex')));
			break;
		case 'merge': {
			const obj = str('obj');
			const error = await merge(repo, obj, typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch', bool('createNewCommit'), bool('squash'), bool('noCommit'));
			if (error === null) logInfo('repo', `已合并：${obj}`);
			respond({
				command: 'merge',
				actionOn: msg.actionOn,
				error,
			});
			break;
		}
		case 'abortMerge':
			await respondResult('abortMerge', async () => {
				const error = await abortMerge(repo);
				if (error !== null) throw new Error(error);
				return { repo };
			});
			break;
		case 'mergeIntoBranch': {
			const branchName = str('branchName');
			const commitHash = str('commitHash');
			// 选中分支必须存在，且被右键的提交就是它的尖端：否则合并的目标不是用户所指的位置。
			const tip = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], repo);
			const tipHash = tip.code === 0 ? tip.stdout.trim() : '';
			if (tipHash === '') {
				respond({ command: 'mergeIntoBranch', error: '选中的分支不存在。', branchName, mergeMessage: null, conflicted: false });
				break;
			}
			if (commitHash !== '' && tipHash !== commitHash) {
				respond({
					command: 'mergeIntoBranch', branchName, mergeMessage: null, conflicted: false,
					error: '该提交不是选中分支的尖端，无法执行合并。',
				});
				break;
			}
			respond({ command: 'mergeIntoBranch', ...(await mergeCurrentIntoBranch(repo, branchName, str('message'))) });
			break;
		}
		case 'rebase': {
			const obj = str('obj');
			const error = await rebase(repo, obj, typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch', bool('ignoreDate', true), bool('interactive'));
			if (error === null) logInfo('repo', `已变基到：${obj}`);
			respond({ command: 'rebase', actionOn: msg.actionOn, interactive: bool('interactive'), error });
			break;
		}

		/* --- 标签 --- */
		case 'addTag': {
			const errors: unknown[] = [await addTag(repo, str('tagName'), str('commitHash'), typeof msg.type === 'number' ? msg.type : 0, str('message'), bool('force'))];
			if (errors[0] === null && strOrNull('pushToRemote') !== null) {
				errors.push(...(await pushTag(repo, str('tagName'), [str('pushToRemote')], str('commitHash'), bool('pushSkipRemoteCheck'))));
			}
			respond({ command: 'addTag', repo, tagName: str('tagName'), pushToRemote: strOrNull('pushToRemote'), commitHash: str('commitHash'), errors });
			break;
		}
		case 'deleteTag':
			await respondError('deleteTag', () => deleteTag(repo, str('tagName'), strOrNull('deleteOnRemote')));
			break;
		/* --- 远程 --- */
		case 'fetch': {
			const remoteName = strOrNull('name');
			const pruneRemotes = bool('prune');
			const pruneAllTags = bool('pruneTags');
			// 非仓库路径抓不了：直接回未变化，不起 git fetch 与两次 for-each-ref。
			if (!(await isRepoPath(repo))) {
				logDebug('repo', `目标路径不是 git 仓库，跳过抓取：${repo}`);
				respondResultSync('fetch', { repo, changed: false });
				break;
			}
			await respondResult('fetch', async () => {
				/*
				 * 抓取前后比一次引用：远端没有新东西时这次抓取不改变任何可见状态。
				 *
				 * 不比较的话，自动抓取（默认每 180s 一轮）会让所有面板每轮都重取一次提交图
				 * 与工作区，而实际上什么都没变。抓取本身要几秒，两次 `for-each-ref` 的代价可忽略。
				 */
				const before = await refsSignature(repo);
				const error = await fetch(repo, remoteName, pruneRemotes, pruneAllTags, true);
				if (error !== null) throw new Error(error);
				const after = await refsSignature(repo);
				const changed = before !== after;
				// 抓取以 quietWrite 执行：确有改动才补发写事件，否则面板不会白刷新。
				if (changed) notifyRepositoryWrite(repo);
				logInfo('repo', `已抓取远程${remoteName === null ? '（全部）' : `：${remoteName}`}${changed ? '，引用有更新' : '，引用无变化'}`);
				return { repo, changed };
			});
			break;
		}
		case 'addRemote':
			await respondError('addRemote', () => addRemote(repo, str('name'), str('url'), strOrNull('pushUrl'), bool('fetch')));
			break;
		case 'deleteRemote':
			await respondError('deleteRemote', () => deleteRemote(repo, str('name')));
			break;
		case 'editRemote':
			await respondError('editRemote', () => editRemote(repo, str('nameOld'), str('nameNew'), strOrNull('urlOld'), strOrNull('urlNew'), strOrNull('pushUrlOld'), strOrNull('pushUrlNew')));
			break;
		case 'pruneRemote':
			await respondError('pruneRemote', () => pruneRemote(repo, str('name')));
			break;

		/* --- Stash --- */
		case 'applyStash':
			await respondError('applyStash', () => applyStash(repo, str('selector'), bool('reinstateIndex')));
			break;
		case 'branchFromStash':
			await respondError('branchFromStash', () => branchFromStash(repo, str('selector'), str('branchName')));
			break;
		case 'dropStash':
			await respondError('dropStash', () => dropStash(repo, str('selector')));
			break;
		case 'popStash':
			await respondError('popStash', () => popStash(repo, str('selector'), bool('reinstateIndex')));
			break;
		case 'pushStash':
			await respondResult('pushStash', async () => {
				const message = str('message');
				const error = await pushStash(repo, message, bool('includeUntracked', true));
				if (error !== null) throw new Error(error);
				logInfo('repo', `已贮藏改动${message === '' ? '' : `：${message}`}`);
				return { repo };
			});
			break;

		/* --- 其它 --- */
		case 'cleanUntrackedFiles':
			await respondError('cleanUntrackedFiles', () => cleanUntrackedFiles(repo, bool('directories')));
			break;
		case 'resetFileToRevision':
			await respondError('resetFileToRevision', () => resetFileToRevision(repo, str('commitHash'), str('filePath')));
			break;
		case 'createArchive': {
			const ref = str('ref');
			const format = str('format') || 'zip';
			const outputPath = str('outputPath');
			if (!ref || !outputPath) { sendBadRequest(res, '缺少 ref 或 outputPath'); break; }
			try {
				const fmtArg = format === 'tgz' ? 'tar.gz' : format;
				await gitOrThrow(['archive', `--format=${fmtArg}`, `--output=${outputPath}`, ref], repo);
				respond({ command: 'createArchive', error: null });
			} catch (e) {
				respond({ command: 'createArchive', error: e instanceof Error ? e.message : String(e) });
			}
			break;
		}
		case 'createPullRequest':
			// 用 gh CLI 创建 PR：非交互，标题与正文由前端给出。
			await respondResult('createPullRequest', async () => ({
				url: await ghCreatePullRequest(repo, {
					head: str('head'),
					base: str('base'),
					title: str('title'),
					body: str('body'),
					draft: bool('draft'),
				}),
			}));
			break;

		/* --- GitHub 集成（gh CLI） --- */
		case 'ghAccount':
			await respondResult('ghAccount', async () => ({ account: await ghAccount(repo) }));
			break;
		case 'ghOwners':
			await respondResult('ghOwners', async () => ({ owners: await ghOwners(repo) }));
			break;
		case 'ghRepoInfo':
			await respondResult('ghRepoInfo', async () => ({ info: await ghRepoInfo(repo) }));
			break;
		case 'ghCreateRepo':
			await respondResult('ghCreateRepo', async () => ({
				url: await ghCreateRepo(repo, {
					name: str('name'),
					owner: str('owner'),
					private: bool('private'),
					description: str('description'),
					remote: str('remote') === '' ? 'origin' : str('remote'),
					protocol: str('protocol') === 'ssh' ? 'ssh' : 'https',
				}),
			}));
			break;
		case 'sshStatus':
			await respondResult('sshStatus', async () => ({
				status: await sshStatus(str('host') === '' ? 'github.com' : str('host'), str('refresh') === 'true'),
			}));
			break;
		case 'openExtensionSettings':
		case 'openExternalDirDiff':
		case 'openExternalUrl':
		case 'openFile':
		case 'openTerminal':
		case 'viewFileAtRevision':
		case 'viewScm':
			respond({ command: msg.command, error: '该操作在当前版本中暂不支持' });
			break;

		/* --- Diff：DSH 右侧栏无通用 git diff 页类型，与其它专属命令一致回错误，
		       前端收到 error 后弹提示。 --- */
		case 'viewDiff':
		case 'viewDiffWithWorkingFile':
			respond({ command: msg.command, error: 'DSH 版本暂不支持打开 Git diff，请用 git 命令或外部 diff 工具' });
			break;

		/* --- 状态 / 剪贴板（DSH 版由前端直接处理） --- */
		case 'copyToClipboard':
		case 'copyFilePath':
			respond({ command: msg.command, type: msg.type ?? null, error: null });
			break;
		case 'setGlobalViewState':
		case 'setWorkspaceViewState':
			respond({ command: msg.command, error: null });
			break;
		case 'setRepoState':
		case 'fetchAvatar':
		case 'startCodeReview':
		case 'endCodeReview':
		case 'updateCodeReview':
			respond({ command: msg.command, error: null });
			break;
		case 'showErrorMessage':
			logError('panel', `面板报告前端错误：${str('message')}`);
			respond({ command: 'showErrorMessage' });
			break;
		case 'exportRepoConfig': {
			try {
				const config = await getConfig(repo, []);
				const repoInfo = await getRepoInfo(repo, true, true, []);
				respond({ command: 'exportRepoConfig', error: null, config: { repo, config, repoInfo } });
			} catch (e) {
				respond({ command: 'exportRepoConfig', error: e instanceof Error ? e.message : String(e), config: null });
			}
			break;
		}
		case 'fileDiffContent': {
			const filePath = str('filePath');
			const commitHash = str('commitHash');
			const baseHash = str('baseHash');
			const staged = bool('staged');
			try {
				let oldText: string | null = null;
				let newText: string | null = null;
				if (baseHash !== '') {
					// 两提交对比：旧侧取 baseHash，新侧取 commitHash（'*' 表示工作区文件）。
					try { oldText = await gitOrThrow(['show', `${baseHash}:${filePath}`], repo); } catch { oldText = null; }
					if (commitHash === '*') {
						try { newText = await fs.readFile(nodePath.resolve(repo, filePath), 'utf8'); } catch { newText = null; }
					} else {
						try { newText = await gitOrThrow(['show', `${commitHash}:${filePath}`], repo); } catch { newText = null; }
					}
				} else if (commitHash === '*') {
					if (staged) {
						// 暂存区 vs HEAD
						try { oldText = await gitOrThrow(['show', `HEAD:${filePath}`], repo); } catch { oldText = null; }
						try { newText = await gitOrThrow(['show', `:${filePath}`], repo); } catch { newText = null; }
					} else {
						// 工作区 vs 暂存区
						try { oldText = await gitOrThrow(['show', `:${filePath}`], repo); } catch { oldText = null; }
						try {
							const fullPath = nodePath.resolve(repo, filePath);
							newText = await fs.readFile(fullPath, 'utf8');
						} catch { newText = null; }
					}
				} else {
					// 提交差异：oldText 取父提交，newText 取该提交
					try { oldText = await gitOrThrow(['show', `${commitHash}~1:${filePath}`], repo); } catch { oldText = null; }
					try { newText = await gitOrThrow(['show', `${commitHash}:${filePath}`], repo); } catch { newText = null; }
				}
				// 真实 hunk 由 git 算出：交给前端的本地 diff 在改动量超过其搜索上限时
				// 会退化成整文件「全删全加」，因此这里直接给出逐块内容。
				const hunks = await diffHunksOf(repo, commitHash, filePath, staged, baseHash);
				respond({ command: 'fileDiffContent', path: filePath, oldText, newText, hunks });
			} catch (e) {
				respond({ command: 'fileDiffContent', path: filePath, oldText: null, newText: null, hunks: [], error: e instanceof Error ? e.message : String(e) });
			}
			break;
		}
		case 'rescanForRepos':
			respond({ command: 'rescanForRepos' });
			break;
		case 'translateAvailable':
			// 翻译服务由 cot-translation bundle 可选装载；未装载时前端不显示翻译入口。
			respond({ command: 'translateAvailable', available: usableTranslator(aiDeps?.getTranslator?.()) !== undefined });
			break;
		case 'translateText': {
			// 逐段翻译：调用方按标题与正文行拆分后分别请求，避免整段被译成一行。
			const text = str('text');
			const targetLanguage = str('targetLanguage');
			if (text === '') { sendBadRequest(res, '缺少 text'); break; }
			if (targetLanguage === '') { sendBadRequest(res, '缺少 targetLanguage'); break; }
			await respondResult('translateText', async () => ({
				text: await translateWithService(aiDeps?.getTranslator?.(), text, targetLanguage),
			}));
			break;
		}
		case 'deleteUserDetails': {
			const location = str('location') as 'local' | 'global';
			const errors: string[] = [];
			if (bool('name')) { try { await unsetConfigValue(repo, 'user.name', location); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			if (bool('email')) { try { await unsetConfigValue(repo, 'user.email', location); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			respond({ command: 'deleteUserDetails', errors });
			break;
		}
		case 'editUserDetails': {
			const location = str('location') as 'local' | 'global';
			const errors: string[] = [];
			const name = str('name');
			const email = str('email');
			try { await setConfigValue(repo, 'user.name', name, location); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
			try { await setConfigValue(repo, 'user.email', email, location); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
			if (bool('deleteLocalName')) { try { await unsetConfigValue(repo, 'user.name', 'local'); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			if (bool('deleteLocalEmail')) { try { await unsetConfigValue(repo, 'user.email', 'local'); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			respond({ command: 'editUserDetails', errors });
			break;
		}
		/*
		 * 主动作废宿主缓存：用户点刷新时使用。
		 *
		 * 写操作已由执行层自动作废该仓库的缓存；这个命令覆盖「外部进程改了仓库、但没有经过本插件」
		 * 的情形——那种改动不产生写事件，宿主无从得知。
		 *
		 * 只作废目标仓库及其祖先与后代：别的仓库的缓存与本次改动无关，全量清空会让它们
		 * 各自重取一次提交图与工作区。
		 */
		case 'invalidateCache':
			invalidateRepo(repo);
			respond({ command: 'invalidateCache', repo, error: null });
			break;

		/* --- 反馈与日志 --- */
		case 'feedbackInfo':
			// 日志目录与最近文件供反馈页展示：失败时用户据此手动提交。
			respondResultSync('feedbackInfo', {
				logDir: logRoot(),
				currentFile: currentLogFile(),
				// 体积文本由宿主给出：客户端不再自带一份格式化实现。
				files: recentLogFiles(5).map((file) => ({ ...file, sizeText: formatBytes(file.size) })),
			});
			break;
		case 'submitFeedback': {
			const type = str('type');
			if (type !== 'bug' && type !== 'suggestion' && type !== 'other') { sendBadRequest(res, '未知反馈类型'); break; }
			if (str('title').trim() === '') { sendBadRequest(res, '缺少标题'); break; }
			if (str('description').trim() === '') { sendBadRequest(res, '缺少描述'); break; }
			const result = await submitFeedback({
				type,
				title: str('title'),
				description: str('description'),
				attachLogs: bool('attachLogs'),
				logFile: strOrNull('logFile') ?? undefined,
				disableRedaction: bool('disableRedaction'),
				exemptions: arr<string>('exemptions'),
				pluginVersion: str('pluginVersion'),
				cwd: repo,
			});
			if (result.error !== null) logError('feedback', `反馈提交失败，原因分类 ${result.kind}：${result.error}`);
			else logInfo('feedback', `反馈已提交，issue 地址：${result.url}${result.archive === null ? '（未附带日志）' : `，日志压缩包：${result.archive}`}`);
			respond({ command: 'submitFeedback', ...result });
			break;
		}
		case 'logEvent': {
			// 浏览器半边没有文件系统，日志经这条命令转写到宿主日志。
			const entries = arr<Record<string, unknown>>('entries').slice(0, MAX_CLIENT_LOG_ENTRIES);
			for (const entry of entries) {
				const tag = typeof entry.tag === 'string' && entry.tag !== '' ? entry.tag : 'panel';
				const message = typeof entry.message === 'string' ? entry.message : '';
				if (message === '') continue;
				log(clientLogLevel(entry.level), `client/${tag}`, message);
			}
			respondResultSync('logEvent', { accepted: entries.length });
			// 客户端上报是插件唯一看不到落盘结果的一环：收几条就记一条，便于确认上报通路是否通。
			if (entries.length > 0) logDebug('api', `已接收 ${String(entries.length)} 条客户端日志`);
			break;
		}

		default:
			sendBadRequest(res, '未知命令: ' + String(msg.command));
	}

	recordCommandCost(command, Date.now() - started, repo, refreshIdParam);
}

/*
 * 刷新耗时汇总：单条命令不记日志，按「一次刷新」把耗时与 git 子进程数汇总成一行。
 *
 * 这是「显示到界面」之外唯一需要的性能观测点：一次刷新会打十几次命令，逐条记既淹没日志，
 * 又看不出那一次刷新到底花了多少。
 *
 * 分组按客户端随请求带来的 `refreshId`：同一轮刷新的命令归到一组，轮次边界由客户端决定。
 * 没有 `refreshId` 的命令（抓取这类由用户操作直接触发的、或旧版客户端）按仓库与时间窗口归组。
 */

/** 无轮次编号时一轮的合并窗口（毫秒）。 */
const COST_WINDOW_MS = 3000;

/** 退出时冲刷的已登记标志。 */
let exitFlushRegistered = false;

/** 一轮刷新内的累计。 */
interface CostBucket {
	/** 本轮的标识，仅用于日志展示。 */
	readonly label: string;
	/** 本轮所属仓库；git 子进程计数按它取。 */
	readonly repo: string;
	/** 本轮第一条命令的开始时刻。 */
	firstStartedAt: number;
	/** 本轮最后一条命令的结束时刻；墙钟由它与 firstStartedAt 相减得到。 */
	lastEndedAt: number;
	/** 本轮开始时的 git 子进程计数。 */
	spawnsAtStart: number;
	/** 各命令的执行次数。 */
	readonly counts: Map<string, number>;
	/** 各命令累计耗时（毫秒）。 */
	readonly msByCommand: Map<string, number>;
	/** 各命令命中缓存的次数（耗时 0 ms 且不是首次）。 */
	readonly cachedCounts: Map<string, number>;
	/** 最慢的一条命令与其耗时。 */
	slowest: { command: string; ms: number } | null;
	/** 本轮累计耗时（毫秒）。 */
	totalMs: number;
}

/** 在跑的轮次：键为仓库 + 轮次编号（无编号时用 `*`）。 */
const costBuckets = new Map<string, CostBucket>();

/** 各轮次的归组键 → 超时冲刷定时器。 */
const costTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 输出一轮的汇总。
 *
 * @param key - 归组键。
 * @returns 无。
 */
function flushCostBucket(key: string): void {
	const timer = costTimers.get(key);
	if (timer !== undefined) {
		clearTimeout(timer);
		costTimers.delete(key);
	}
	const current = costBuckets.get(key);
	if (current === undefined) return;
	costBuckets.delete(key);
	const breakdown = [...current.counts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.map(([name, count]) => {
			const cached = current.cachedCounts.get(name) ?? 0;
			const suffix = cached === 0 ? '' : cached === count ? '（全部命中缓存）' : `（${String(cached)} 次命中缓存）`;
			return `${name}×${String(count)}=${String(current.msByCommand.get(name) ?? 0)}ms${suffix}`;
		})
		.join('、');
	const slowest = current.slowest === null ? '' : `，最慢 ${current.slowest.command} ${String(current.slowest.ms)} ms`;
	/*
	 * 墙钟取「首条命令开始 → 末条命令结束」，不是「归组开启至今」：命令之间的空闲不算用户等待。
	 *
	 * 命令是并行发出的，各条耗时之和会大于墙钟，因此两个数都给：墙钟是用户感知，
	 * 命令之和是工作量。git 子进程数是这套取数的主要成本来源（一次约 80ms 固定开销）。
	 */
	const wall = Math.max(0, current.lastEndedAt - current.firstStartedAt);
	// 按仓库计数：并发轮次各自算差值，共用全局计数会把别的轮次的子进程算进来。
	const spawns = gitSpawnCount(current.repo) - current.spawnsAtStart;
	logInfo('perf', `${current.label}墙钟 ${String(wall)} ms，命令耗时合计 ${String(current.totalMs)} ms，git 子进程 ${String(spawns)} 个，共 ${String(current.counts.size)} 种命令${slowest}：${breakdown}`);
}

/**
 * 输出全部在跑的轮次并复位。
 *
 * @returns 无。
 */
function flushCommandCost(): void {
	for (const key of [...costBuckets.keys()]) flushCostBucket(key);
}

/**
 * 记一条命令的耗时；轮次结束时输出一行汇总。
 *
 * @param command - 命令名。
 * @param ms - 本次耗时（毫秒）。
 * @param repo - 仓库路径。
 * @param refreshId - 客户端给出的轮次编号；未给出时为 null。
 * @returns 无。
 */
function recordCommandCost(command: string, ms: number, repo: string, refreshId: number | null): void {
	if (command === '' || command === 'logEvent') return;
	if (!exitFlushRegistered) {
		exitFlushRegistered = true;
		/*
		 * 定时器 unref 过：进程退出时靠这里把最后一轮写出去。
		 *
		 * 退出钩子按注册顺序执行，而日志模块自己的收尾钩子在插件装载时就已注册、会先跑；
		 * 因此这里写完必须自己再 flush 一次，否则刚写进缓冲的行赶不上落盘。
		 */
		process.once('exit', () => {
			flushCommandCost();
			flushSync();
		});
	}
	const repoLabel = repo === '' ? '（未指定仓库）' : repo;
	const key = `${repo.toLowerCase()}\u0000${refreshId === null ? '*' : String(refreshId)}`;
	/*
	 * 同一仓库出现新的轮次编号时，说明上一轮已经打完：先把它写出去，不再等定时器。
	 * 定时器只兜「客户端不再发新轮次」的情形（例如窗口被关掉）。
	 */
	for (const existing of [...costBuckets.keys()]) {
		if (existing === key) continue;
		if (!existing.startsWith(`${repo.toLowerCase()}\u0000`)) continue;
		flushCostBucket(existing);
	}
	const now = Date.now();
	let current = costBuckets.get(key);
	if (current === undefined) {
		current = {
			label: refreshId === null ? `一轮刷新（${repoLabel}）` : `第 ${String(refreshId)} 轮刷新（${repoLabel}）`,
			repo, firstStartedAt: now - ms, lastEndedAt: now, spawnsAtStart: gitSpawnCount(repo),
			counts: new Map(), msByCommand: new Map(), cachedCounts: new Map(), slowest: null, totalMs: 0,
		};
		costBuckets.set(key, current);
	}
	current.lastEndedAt = now;
	current.counts.set(command, (current.counts.get(command) ?? 0) + 1);
	current.msByCommand.set(command, (current.msByCommand.get(command) ?? 0) + ms);
	current.totalMs += ms;
	// 0 ms 的命令即命中了缓存：单独计数，否则无法判断缓存是否生效。
	if (ms === 0) current.cachedCounts.set(command, (current.cachedCounts.get(command) ?? 0) + 1);
	if (current.slowest === null || ms > current.slowest.ms) current.slowest = { command, ms };
	// 每一轮都重新计时：轮次内的命令可能间隔很久（用户在等某个慢操作）。
	const existTimer = costTimers.get(key);
	if (existTimer !== undefined) clearTimeout(existTimer);
	const timer = setTimeout(() => {
		costTimers.delete(key);
		flushCostBucket(key);
	}, COST_WINDOW_MS);
	if (typeof timer.unref === 'function') timer.unref();
	costTimers.set(key, timer);
}
export interface GgRouteContext {
	register(spec: {
		kind: 'exact' | 'prefix';
		path: string;
		handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
	}): () => void;
}

/** AI 提交生成的依赖面。 */
export interface AiCommitDeps {
	getLlm?: () => unknown;
	getAgentDefaultModel?: () => unknown;
	/** 取官方 translator 服务；未装载时为 undefined，翻译入口据此降级。 */
	getTranslator?: () => unknown;
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
 * 取官方 translator 服务；未装载时返回 undefined。
 *
 * @param translator - 依赖面给出的服务实例。
 * @returns 具备 resolve 与 translate 的服务；不可用时为 undefined。
 */
function usableTranslator(translator: unknown): { resolve: (request: { text: string; targetLanguage: string }) => unknown; translate: (spec: unknown) => Promise<string> } | undefined {
	const service = translator as {
		resolve?: (request: { text: string; targetLanguage: string }) => unknown;
		translate?: (spec: unknown) => Promise<string>;
	} | undefined;
	if (service === undefined || typeof service.resolve !== 'function' || typeof service.translate !== 'function') return undefined;
	return service as { resolve: (request: { text: string; targetLanguage: string }) => unknown; translate: (spec: unknown) => Promise<string> };
}

/**
 * 用官方 translator 服务翻译一段文本。
 *
 * 该服务由 cot-translation bundle 可选装载；不可用时抛出可读错误，前端另有
 * `translateAvailable` 查询，正常情况下不会走到这里。
 *
 * @param translator - translator 服务实例。
 * @param text - 待翻译文本。
 * @param targetLanguage - 目标语言标签。
 * @returns 译文。
 */
async function translateWithService(translator: unknown, text: string, targetLanguage: string): Promise<string> {
	const service = usableTranslator(translator);
	if (service === undefined) throw new Error('未装载翻译服务（translator），无法翻译');
	return await service.translate(service.resolve({ text, targetLanguage }));
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

/**
 * 取某个文件差异的逐块内容。
 *
 * 由 git 用 `-U3` 生成统一差异后按 hunk 切分。提交差异与新旧内容同源，一律对比第一个
 * 父提交，因此合并提交不会落到 git 的合并差异格式（`@@@`，无法按单侧 hunk 解析）。
 * 命令失败或没有 hunk（二进制、未跟踪的新文件）时返回空数组，前端据此退回整份内容比较。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 提交哈希；`*` 表示工作区。
 * @param filePath - 文件路径（相对仓库根）。
 * @param staged - 工作区时是否比较暂存区。
 * @returns 逐块的新旧内容。
 */
/**
 * 取某个文件的逐块差异。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 目标提交；`*` 表示工作区。
 * @param filePath - 文件路径（相对仓库根）。
 * @param staged - 工作区时是否取暂存区内容。
 * @param baseHash - 旧侧提交；非空时按 `baseHash → commitHash` 对比。
 * @returns 逐块差异；取不到时为空数组。
 */
async function diffHunksOf(repo: string, commitHash: string, filePath: string, staged: boolean, baseHash = ''): Promise<DiffHunkText[]> {
	const args = baseHash !== ''
		? ['diff', '--no-color', '--unified=3', baseHash, commitHash === '*' ? '' : commitHash, '--', filePath].filter((part) => part !== '')
		: commitHash === '*'
			? (staged
				? ['diff', '--no-color', '--unified=3', '--cached', '--', filePath]
				: ['diff', '--no-color', '--unified=3', '--', filePath])
			: ['diff', '--no-color', '--unified=3', `${commitHash}~1`, commitHash, '--', filePath];
	try {
		return parseUnifiedDiffHunks(await gitOrThrow(args, repo));
	} catch {
		return [];
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
