/**
 * 事件流：把仓库写操作与结构变化推给所有面板。
 *
 * 推送不携带数据，接收方自行重读。
 */
import type http from 'node:http';
import { logDebug, logInfo, logWarn } from '../logger.js';
import { sendJson } from './http.js';

/** 事件流连接的保活间隔（毫秒）。 */
const EVENTS_HEARTBEAT_MS = 25000;

/** 事件流连接数上限：每个连接占一个响应流，不设上限时页面反复重连会累积。 */
const MAX_EVENT_STREAMS = 16;

/** 当前打开的事件流连接。 */
const eventStreams = new Set<http.ServerResponse>();

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

export { broadcastRepositoryWrite, broadcastRepositoryTree, handleEvents };