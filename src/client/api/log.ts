/**
 * 浏览器半边的日志上报：入队后按批转交宿主，写进同一份日志文件。
 *
 * 浏览器没有文件系统，日志经 `logEvent` 命令交给宿主。上报是尽力而为：
 * 队列有上限，发送失败把条目放回队首，且不上报自身失败（见 http.ts）。
 */
import { API_PATH, setApiFailureReporter } from './http.ts';

/** 客户端日志级别。 */
export type ClientLogLevel = 'D' | 'I' | 'W' | 'E';

/** 一条待上报的日志。 */
interface ClientLogEntry {
	readonly level: ClientLogLevel;
	readonly tag: string;
	readonly message: string;
}

/** 队列条数上限：超出时丢弃最旧的。 */
const QUEUE_LIMIT = 200;

/** 合并发送窗口（毫秒）。 */
const FLUSH_DELAY_MS = 1500;

/** 待发送的条目。 */
let queue: ClientLogEntry[] = [];

/** 合并发送定时器。 */
let timer: ReturnType<typeof setTimeout> | undefined;

/** 是否有一次发送在途。 */
let sending = false;

/**
 * 记一条客户端日志。
 *
 * @param level - 级别。
 * @param tag - 标签，写进日志的 TAG 段（宿主会加 `client/` 前缀）。
 * @param message - 消息正文。
 */
export function logClient(level: ClientLogLevel, tag: string, message: string): void {
	if (message === '') return;
	queue.push({ level, tag, message });
	if (queue.length > QUEUE_LIMIT) queue = queue.slice(-QUEUE_LIMIT);
	if (timer !== undefined) return;
	timer = setTimeout(() => { timer = undefined; void flushClientLog(); }, FLUSH_DELAY_MS);
}

/**
 * 立即发送队列里的条目。
 *
 * @returns 发送完成后完成；没有待发条目或已有一次在途时立即返回。
 */
export async function flushClientLog(): Promise<void> {
	if (sending || queue.length === 0) return;
	const entries = queue;
	queue = [];
	sending = true;
	try {
		await fetch(API_PATH, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ repo: '', command: 'logEvent', entries }),
		});
	} catch {
		// 放回队首：下一次发送一起带上，仍受总量上限约束。
		queue = [...entries, ...queue].slice(0, QUEUE_LIMIT);
	} finally {
		sending = false;
	}
}

/**
 * 安装命令失败的转报钩子：宿主命令失败自动进日志，无需各处手写。
 */
export function installClientLog(): void {
	setApiFailureReporter((level, tag, message) => { logClient(level, tag, message); });
}
