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

	ctx.inject(['webServer'], (host) => {
		const webServer = (host as unknown as { webServer: WebServerLike }).webServer;
		const getLlm = () => (ctx as unknown as { get(name: string): unknown }).get('llm');
		const getAgentDefaultModel = () => (ctx as unknown as { get(name: string): unknown }).get('agentDefaultModel');
		// 翻译走官方 translator 服务；未装载时该服务取不到，翻译入口据此提示降级。
		const getTranslator = () => (ctx as unknown as { get(name: string): unknown }).get('translator');
		const disposers = registerGgRoutes(webServer, { getLlm, getAgentDefaultModel, getTranslator });
		// 预扫不 await：不阻塞 apply 返回，失败也不影响路由。
		void primeCachedWorkspaces().catch(() => { /* 预扫失败不影响路由 */ });

		(ctx.on as (event: string, cb: () => void) => void)('dispose', () => {
			for (const d of disposers) d();
		});
	});
}
