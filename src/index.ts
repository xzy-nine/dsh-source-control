/**
 * dsh-dev-git-graph host entry：注册 web 路由并注入 AI 依赖。
 *
 * 1) webServer 挂三条路由：
 *    POST /dsh-dev-git-graph/gg/api       -> 面板命令集（host 直跑 git 命令）
 *    GET  /dsh-dev-git-graph/gg/ai-models -> AI 供应商与模型目录
 *    POST /dsh-dev-git-graph/gg/ai-commit -> AI 生成提交信息（SSE 流式）
 * 2) 提交图查询复用 vendor/git-graph/dataSource.ts（mhutchie/vscode-git-graph，
 *    许可与本源文件不同，原文见 vendor/git-graph/LICENSE）。
 * 3) 工作区变更、工作树与差异由 src/git-graph/ 下的本地 git 层提供。
 */
import type http from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { registerGgRoutes } from './git-graph/routes.js';

export const name = 'dev-git-graph';
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
		const disposers = registerGgRoutes(webServer, { getLlm, getAgentDefaultModel });

		(ctx.on as (event: string, cb: () => void) => void)('dispose', () => {
			for (const d of disposers) d();
		});
	});
}
