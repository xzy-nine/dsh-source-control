/**
 * HTTP 适配：响应写出、请求体读取与请求合并键。
 */
import type http from 'node:http';
import { logWarn } from '../logger.js';

/**
 * 开始一条 SSE 流：写出事件流响应头并立即返回。
 *
 * 客户端按 `text/event-stream` 逐帧解析，因此不能走 {@link sendJson}（它会 `end` 掉响应）；
 * `no-store` 与 `keep-alive` 保证代理不缓存、连接不被中途关闭。
 *
 * @param res - 响应。
 * @returns 无。
 */
function openEventStream(res: http.ServerResponse): void {
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-store',
		'connection': 'keep-alive',
	});
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}

function sendBadRequest(res: http.ServerResponse, message: string, code?: string): void {
	logWarn('api', `请求被拒绝（400）：${message}`);
	sendJson(res, 400, code === undefined ? { error: message } : { error: message, code });
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

/**
 * 生成并发合并键。
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

export { sendJson, sendBadRequest, openEventStream, readBody, coalesceKeyOf };