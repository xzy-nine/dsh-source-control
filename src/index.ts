/**
 * dsh-source-control host entry：注册 web 路由并注入 AI 依赖。
 *
 * 1) webServer 挂三条路由：
 *    POST /dsh-source-control/gg/api       -> 面板命令集（host 直跑 git 命令）
 *    GET  /dsh-source-control/gg/ai-models -> AI 供应商与模型目录
 *    POST /dsh-source-control/gg/ai-commit -> AI 生成提交信息（SSE 流式）
 * 2) 提交图查询由 src/source-control/ 下的本地数据层提供（git-query.ts / git-actions.ts）。
 * 3) 工作区变更、工作树与差异同样由 src/source-control/ 提供。
 * 4) 路由注册后按已持久化的工作区根预扫一次仓库树；预扫 fire-and-forget，失败静默。
 */
import type http from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { registerGgRoutes } from './source-control/routes.js';
import { primeCachedWorkspaces } from './source-control/repo-discovery.js';
import { openStateStore, pruneWorkspaces, stateDomainFailure } from './source-control/state-store.js';
import { initLog, logError, logInfo, logRoot, logWarn } from './source-control/logger.js';

export const name = 'source-control';
export const inject = ['webServer'];

export interface DevGitGraphPluginConfig {}

interface WebServerLike {
	register(spec: {
		kind: 'exact' | 'prefix';
		path: string;
		handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
	}): () => void;
}

/** 域注册的等待上限：插件加载顺序不保证 storageDomain 先就位。 */
const DOMAIN_WAIT_ATTEMPTS = 20;

/** 两次尝试的间隔（毫秒）。 */
const DOMAIN_WAIT_INTERVAL_MS = 100;

/**
 * 等 storageDomain 就位后再打开状态文档。
 *
 * 插件加载顺序不保证 `storageDomain` 在本次 `apply` 里已就位；有界重试后仍取不到时按「未装载」
 * 处理，状态文档回退到旧版文件。
 *
 * @param read - 取 `ctx.storageDomain`。
 * @returns 是否接上了域。
 */
async function openStateStoreWhenReady(read: () => unknown): Promise<boolean> {
	for (let attempt = 0; attempt < DOMAIN_WAIT_ATTEMPTS; attempt += 1) {
		if (await openStateStore(read())) return true;
		if (attempt + 1 < DOMAIN_WAIT_ATTEMPTS) await new Promise((resolve) => { setTimeout(resolve, DOMAIN_WAIT_INTERVAL_MS); });
	}
	logWarn('state', `storage domain 始终未就位（${stateDomainFailure() ?? '原因未知'}），状态文档回退到旧版 state.json`);
	return false;
}

export function apply(ctx: Context, config: Partial<DevGitGraphPluginConfig> = {}): void {
	void config;
	// 文本日志：每次启动一个文件，目录与清理判据见 source-control/logger.ts。
	try {
		initLog();
		logInfo('source-control', `源代码管理插件已装载（${name}），日志目录：${logRoot()}`);
	} catch (error) {
		// 日志不可用时插件照常工作，只在控制台留一条。
		logError('source-control', `文本日志初始化失败，本次运行不会记录日志：${error instanceof Error ? error.message : String(error)}`);
	}

	ctx.inject(['webServer'], (host) => {
		const webServer = (host as unknown as { webServer: WebServerLike }).webServer;
		/*
		 * 状态文档接进 DSH 的 storage domain；未装载时回退到旧版 state.json，路由照常可用。
		 *
		 * 域打开是异步的，而预扫与清理要读已持久化的工作区根，因此串在同一个异步链上：
		 * 先接域、再清理、最后预扫。
		 */
		const ready = openStateStoreWhenReady(() => (ctx as unknown as { get(name: string): unknown }).get('storageDomain'));
		const getLlm = () => (ctx as unknown as { get(name: string): unknown }).get('llm');
		const getAgentDefaultModel = () => (ctx as unknown as { get(name: string): unknown }).get('agentDefaultModel');
		// 翻译走官方 translator 服务；未装载时该服务取不到，翻译入口据此提示降级。
		const getTranslator = () => (ctx as unknown as { get(name: string): unknown }).get('translator');
		const disposers = registerGgRoutes(webServer, { getLlm, getAgentDefaultModel, getTranslator });
		// 清理与预扫都依赖已持久化的工作区根，因此排在域打开之后；不 await，失败也不影响路由。
		void ready.then(() => {
			try { pruneWorkspaces(); } catch { /* 清理失败时下次启动重试 */ }
			return primeCachedWorkspaces();
		}).catch((error: unknown) => {
			logInfo('repo', `启动预扫仓库树失败，不影响路由与面板取数：${error instanceof Error ? error.message : String(error)}`);
		});
		logInfo('source-control', `已注册 ${String(disposers.length)} 条 web 路由，面板命令可用`);

		(ctx.on as (event: string, cb: () => void) => void)('dispose', () => {
			logInfo('source-control', '源代码管理插件正在卸载，关闭已注册的路由与事件流');
			for (const d of disposers) d();
		});
	});
}
