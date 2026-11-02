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
import { initLog, logError, logInfo, logRoot } from './source-control/logger.js';

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
		const getLlm = () => (ctx as unknown as { get(name: string): unknown }).get('llm');
		const getAgentDefaultModel = () => (ctx as unknown as { get(name: string): unknown }).get('agentDefaultModel');
		// 翻译走官方 translator 服务；未装载时该服务取不到，翻译入口据此提示降级。
		const getTranslator = () => (ctx as unknown as { get(name: string): unknown }).get('translator');
		const disposers = registerGgRoutes(webServer, { getLlm, getAgentDefaultModel, getTranslator });
		// 预扫不 await：不阻塞 apply 返回，失败也不影响路由。
		void primeCachedWorkspaces().catch((error: unknown) => {
			logInfo('repo', `启动预扫仓库树失败，不影响路由与面板取数：${error instanceof Error ? error.message : String(error)}`);
		});
		logInfo('source-control', `已注册 ${String(disposers.length)} 条 web 路由，面板命令可用`);

		(ctx.on as (event: string, cb: () => void) => void)('dispose', () => {
			logInfo('source-control', '源代码管理插件正在卸载，关闭已注册的路由与事件流');
			for (const d of disposers) d();
		});
	});
}
