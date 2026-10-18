/**
 * 仓库变更事件流：订阅宿主推送的「某仓库被写入」与「某仓库结构已变」，用于即时反映别处的改动。
 *
 * 事件驱动的自动刷新只订阅当前会话的事件窗口，因此在别的会话、别的工作区或外部进程里
 * 对同一仓库做的改动收不到任何信号，只能等兜底轮询。本模块订阅宿主的事件流补上这条通道。
 *
 * 传输为 `text/event-stream`：宿主在每次**成功**的仓库写操作后推一条 `repository-write`，
 * 在 git 目录里的工作树登记、子模块目录或 `.gitmodules` 变化后推一条 `repository-tree`，
 * 数据均为发生变更的仓库路径。连接断开后按退避重连，因此宿主重启或页面长时间挂起都能自愈。
 * 本模块不依赖 React 与其它客户端模块，可直接单测。
 */
import { readStreamText } from './stream.ts';

/** 事件流地址。 */
const EVENTS_PATH = '/dsh-source-control/gg/events';

/** 首次重连延迟（毫秒）。 */
const RECONNECT_MIN_MS = 1000;

/** 重连延迟上限（毫秒）。 */
const RECONNECT_MAX_MS = 30000;

/** 一个仓库写事件。 */
export interface RepositoryWriteEvent {
	/** 发生变更的仓库路径。 */
	readonly repo: string;
}

/** 一个仓库结构事件：工作树登记或子模块声明可能已变。 */
export interface RepositoryTreeEvent {
	/** 结构发生变化的仓库路径。 */
	readonly repo: string;
}

/** 统一分隔符、去掉尾斜杠；盘符统一小写。 */
function normalizePath(value: string): string {
	const unified = value.replace(/\\/g, '/').replace(/\/+$/, '');
	return /^[A-Za-z]:/.test(unified) ? unified.slice(0, 1).toLowerCase() + unified.slice(1) : unified;
}

/**
 * 一条仓库写事件是否属于当前查看的仓库。
 *
 * 相等即命中；事件仓库在查看路径之内也命中 —— 子模块里的写入会让外层仓库的变更区出现改动。
 * 路径比较统一分隔符并忽略盘符大小写。
 *
 * @param viewed - 当前查看的仓库或工作树路径。
 * @param eventRepo - 事件给出的仓库路径。
 * @returns 命中时为 true。
 */
export function matchesRepository(viewed: string, eventRepo: string): boolean {
	const target = normalizePath(viewed);
	const changed = normalizePath(eventRepo);
	if (target === '' || changed === '') return false;
	return changed === target || changed.startsWith(`${target}/`);
}

/** 事件流连接的订阅者接口。 */
export interface RepositoryWriteStreamOptions {
	/** 收到一条仓库写事件。 */
	readonly onWrite: (event: RepositoryWriteEvent) => void;
	/** 收到一条仓库结构事件；省略时忽略。 */
	readonly onTree?: (event: RepositoryTreeEvent) => void;
	/** 连接状态变化；用于诊断，缺省不关心。 */
	readonly onState?: (state: 'open' | 'closed') => void;
}

/**
 * 解析一条事件流帧。
 *
 * 只识别 `repository-write` 与 `repository-tree` 事件；注释行、保活与其它事件一律忽略，
 * `data` 不是合法 JSON 或缺少 `repo` 时同样忽略 —— 单条坏帧不应打断整条连接。
 *
 * @param frame - 一个完整的帧（已按空行切分）。
 * @returns 事件；不是可用的仓库事件时为 null。
 */
export function parseRepositoryEventFrame(frame: string): { readonly kind: 'write' | 'tree'; readonly repo: string } | null {
	let event = '';
	let data = '';
	for (const line of frame.split('\n')) {
		if (line === '' || line.startsWith(':')) continue;
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
		if (field === 'event') event = value;
		else if (field === 'data') data += value;
	}
	if ((event !== 'repository-write' && event !== 'repository-tree') || data === '') return null;
	try {
		const parsed = JSON.parse(data) as { repo?: unknown };
		if (typeof parsed.repo !== 'string' || parsed.repo === '') return null;
		return { kind: event === 'repository-tree' ? 'tree' : 'write', repo: parsed.repo };
	} catch {
		return null;
	}
}

/**
 * 解析一条仓库写事件帧。
 *
 * @param frame - 一个完整的帧（已按空行切分）。
 * @returns 写事件；不是可用的写事件时为 null。
 */
export function parseRepositoryWriteFrame(frame: string): RepositoryWriteEvent | null {
	const parsed = parseRepositoryEventFrame(frame);
	return parsed !== null && parsed.kind === 'write' ? { repo: parsed.repo } : null;
}

/**
 * 解析一条仓库结构事件帧。
 *
 * 结构事件表示仓库的工作树登记或子模块声明可能已变，接收方据此重新枚举。
 *
 * @param frame - 一个完整的帧（已按空行切分）。
 * @returns 结构事件；不是可用的结构事件时为 null。
 */
export function parseRepositoryTreeFrame(frame: string): RepositoryTreeEvent | null {
	const parsed = parseRepositoryEventFrame(frame);
	return parsed !== null && parsed.kind === 'tree' ? { repo: parsed.repo } : null;
}

/**
 * 按 SSE 的帧边界切分缓冲。
 *
 * 帧之间以空行分隔；最后一段可能不完整，留在缓冲里等下一批数据。
 *
 * @param buffer - 已收到的全部文本。
 * @returns 完整帧与剩余缓冲。
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
	const parts = buffer.split(/\r?\n\r?\n/);
	const rest = parts.pop() ?? '';
	return { frames: parts, rest };
}

/**
 * 取下一次重连的延迟：连续失败时翻倍，封顶后保持。
 *
 * @param attempt - 已失败的次数，从 1 开始。
 * @returns 延迟毫秒数。
 */
export function reconnectDelayMs(attempt: number): number {
	const safe = Number.isFinite(attempt) && attempt > 1 ? Math.floor(attempt) : 1;
	return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (safe - 1));
}

/** 事件流的传输面；便于测试替换。 */
export interface EventStreamTransport {
	subscribe(options: RepositoryWriteStreamOptions): () => void;
}

/**
 * 用 fetch 的流式响应订阅事件流，断线后按退避重连。
 *
 * @param options - 见 {@link RepositoryWriteStreamOptions}。
 * @returns 取消订阅；调用后不再重连。
 */
export function subscribeRepositoryWrites(options: RepositoryWriteStreamOptions): () => void {
	const disposed = { current: false };
	/** 订阅是否已取消。 */
	const isDisposed = (): boolean => disposed.current;
	let controller: AbortController | null = null;
	let timer: number | null = null;
	let attempt = 0;

	const scheduleReconnect = (): void => {
		if (disposed.current) return;
		attempt++;
		timer = window.setTimeout(() => { timer = null; void connect(); }, reconnectDelayMs(attempt));
	};

	const connect = async (): Promise<void> => {
		if (isDisposed()) return;
		controller = new AbortController();
		try {
			const response = await fetch(EVENTS_PATH, {
				method: 'GET',
				headers: { accept: 'text/event-stream' },
				signal: controller.signal,
			});
			if (!response.ok || response.body === null) throw new Error('事件流不可用');
			attempt = 0;
			options.onState?.('open');
			let buffer = '';
			await readStreamText(response.body, (text) => {
				buffer += text;
				const { frames, rest } = splitFrames(buffer);
				buffer = rest;
				for (const frame of frames) {
					const event = parseRepositoryEventFrame(frame);
					if (event === null) continue;
					if (event.kind === 'tree') options.onTree?.({ repo: event.repo });
					else options.onWrite({ repo: event.repo });
				}
			}, () => disposed.current);
		} catch {
			/* 连接失败或中断：走重连 */
		} finally {
			options.onState?.('closed');
		}
		if (!disposed.current) scheduleReconnect();
	};

	void connect();
	return () => {
		disposed.current = true;
		if (timer !== null) window.clearTimeout(timer);
		controller?.abort();
	};
}
