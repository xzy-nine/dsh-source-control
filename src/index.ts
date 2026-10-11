/**
 * dsh-dev-git-graph host entry：内置移植版 vscode-git-graph 1.30.0（MIT，© mhutchie）。
 * 1) webServer 挂两条路由：
 *    GET /dsh-dev-git-graph/gg/          -> git-graph 前端入口（iframe 加载，带 __DSH_GG_BOOT__）
 *    GET /dsh-dev-git-graph/gg/<static>  -> 打包后的 JS/CSS
 *    POST /dsh-dev-git-graph/gg/api      -> 原扩展 gitGraphView.respondToMessage 的命令集（host 直跑 git 命令）
 * 2) 数据层复用 vendor/git-graph/dataSource.ts（mhutchie/vscode-git-graph，许可见 vendor/git-graph/LICENSE）。
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
		const disposers = registerGgRoutes(webServer);

		(ctx.on as (event: string, cb: () => void) => void)('dispose', () => {
			for (const d of disposers) d();
		});
	});
}
