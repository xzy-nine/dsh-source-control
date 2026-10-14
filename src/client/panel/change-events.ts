/**
 * 文件改动事件的判据：把会话事件折算成「已落地的写入/编辑」，并判定它是否落在某个仓库内。
 *
 * 事件来源是客户端会话事件窗口（tool/call + tool/result，以及 run_code 内嵌套调用的
 * tool/ptc-dispatch-start + tool/ptc-dispatch）。只有拿到结果、且结果非错误的调用才算写入已落地。
 * 本模块无任何导入，供 hook 与单元测试直接使用。
 */

/** 两次事件驱动的自动重载之间的最小间隔（毫秒）。 */
export const AUTO_REFRESH_COOLDOWN_MS = 5000;

/** 定时抓取的默认间隔（秒）。 */
export const AUTO_FETCH_PERIOD_SECONDS_DEFAULT = 180;

/** 定时抓取间隔的下限与上限（秒）。 */
export const AUTO_FETCH_PERIOD_SECONDS_MIN = 10;
export const AUTO_FETCH_PERIOD_SECONDS_MAX = 3600;

/** 过期缓存的清理周期（毫秒）。 */
export const CLEANUP_INTERVAL_MS = 300000;

/** 兜底轮询的间隔（毫秒）：事件驱动之外的定期校对，远低于事件响应的及时性要求。 */
export const FALLBACK_POLL_INTERVAL_MS = 120000;

/**
 * 兜底轮询的第几次观测可以判定变化已稳定。
 *
 * 克隆等长时间写盘期间，外层仓库会把正在增长的目录树整体列为未跟踪文件；
 * 连续两次读到同一份签名才认为变化已停止。
 */
export const FALLBACK_STABLE_OBSERVATIONS = 2;

/**
 * 兜底轮询是否应触发重载。
 *
 * @param signature - 本次读到的签名。
 * @param lastSeen - 上一次读到的签名；首次读取为空串。
 * @param loaded - 面板当前已加载的签名。
 * @param seenCount - 已连续读到该签名的次数。
 * @returns 应重载时为 true。
 */
export function shouldFallbackRefresh(signature: string, lastSeen: string, loaded: string, seenCount: number): boolean {
	if (lastSeen === '' || signature !== lastSeen) return false;
	if (signature === loaded) return false;
	return seenCount >= FALLBACK_STABLE_OBSERVATIONS;
}

/** 写文件类工具名：整文件写入或新建。 */
const WRITE_TOOLS = new Set(['write', 'create']);

/** 编辑类工具名：按字面替换文件内容。 */
const EDIT_TOOLS = new Set(['edit', 'multi-edit', 'str_replace', 'str-replace-editor', 'ops_replace']);

/** 一次会话事件的最小结构。 */
export interface SessionEventLike {
	readonly type: string;
	readonly data?: Record<string, unknown>;
}

/** 文件改动的种类。 */
export type FileChangeKind = 'write' | 'edit';

/** 一次已落地的文件改动。 */
export interface FileChange {
	/** 工具调用 id。 */
	readonly callId: string;
	readonly kind: FileChangeKind;
	/** 模型给出的路径原文，可能是相对路径。 */
	readonly path: string;
}

/** 工具名到改动种类的映射；不写文件的工具返回 null。 */
function changeKindOf(name: string): FileChangeKind | null {
	if (WRITE_TOOLS.has(name)) return 'write';
	if (EDIT_TOOLS.has(name)) return 'edit';
	return null;
}

/** 解析工具参数：字符串按 JSON 解析，对象原样使用，其余为空对象。 */
function argumentsOf(raw: unknown): Record<string, unknown> {
	let value = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw) as unknown;
		} catch {
			return {};
		}
	}
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 取参数里的路径字段。 */
function pathOf(args: Record<string, unknown>): string | null {
	for (const key of ['file_path', 'path', 'filePath']) {
		const value = args[key];
		if (typeof value === 'string' && value !== '') return value;
	}
	return null;
}

/** 一次调用在等待期间的暂存状态。 */
interface Pending {
	readonly kind: FileChangeKind;
	readonly path: string;
	/** 结果是否已到达；null 表示仍在等待。 */
	settled: boolean | null;
}

/**
 * 事件流里一条工具结果是否报错。
 *
 * @param data - 事件数据。
 * @returns 报错时为 true。
 */
function resultIsError(data: Record<string, unknown>): boolean {
	const message = data.message;
	if (message !== null && typeof message === 'object') {
		const candidate = message as { isError?: unknown; content?: unknown };
		if (candidate.isError === true) return true;
		if (Array.isArray(candidate.content)) {
			for (const block of candidate.content) {
				if (block !== null && typeof block === 'object' && (block as { isError?: unknown }).isError === true) return true;
			}
		}
	}
	return data.isError === true;
}

/** 取工具结果消息里的调用 id。 */
function resultCallId(data: Record<string, unknown>): string | null {
	const message = data.message;
	if (message !== null && typeof message === 'object') {
		const source = (message as { source?: unknown }).source;
		if (source !== null && typeof source === 'object') {
			const callId = (source as { callId?: unknown }).callId;
			if (typeof callId === 'string' && callId !== '') return callId;
		}
		const direct = (message as { toolCallId?: unknown }).toolCallId;
		if (typeof direct === 'string' && direct !== '') return direct;
	}
	return null;
}

/**
 * 把事件折算成已落地的写入/编辑。
 *
 * 只保留拿到结果且结果非错误的调用；未结算或报错的调用不返回。
 *
 * @param events - 会话事件，按发生顺序。
 * @returns 已落地的改动，按事件顺序。
 */
export function settledFileChanges(events: readonly SessionEventLike[]): FileChange[] {
	const pending = new Map<string, Pending>();
	const settled: FileChange[] = [];
	for (const event of events) {
		const data = event.data ?? {};
		if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
			const name = data.name;
			const callId = event.type === 'tool/call' ? data.callId : data.subCallId;
			if (typeof name !== 'string' || typeof callId !== 'string') continue;
			const kind = changeKindOf(name);
			if (kind === null) continue;
			const path = pathOf(argumentsOf(data.arguments));
			if (path === null) continue;
			pending.set(callId, { kind, path, settled: null });
			continue;
		}
		if (event.type === 'tool/result') {
			const callId = resultCallId(data);
			if (callId === null) continue;
			const entry = pending.get(callId);
			if (entry === undefined) continue;
			entry.settled = !resultIsError(data);
			continue;
		}
		if (event.type === 'tool/ptc-dispatch') {
			const callId = data.subCallId;
			if (typeof callId !== 'string') continue;
			const entry = pending.get(callId);
			if (entry === undefined) continue;
			entry.settled = !resultIsError(data);
		}
	}
	for (const [callId, entry] of pending) {
		if (entry.settled === true) settled.push({ callId, kind: entry.kind, path: entry.path });
	}
	return settled;
}

/**
 * 把模型给出的路径折算成仓库相对路径。
 *
 * 模型写相对路径时按会话工作区解析，写绝对路径时按仓库根判断是否在仓库内；
 * 仓库之外（如临时目录）返回 null。
 *
 * @param repoRoot - 仓库根绝对路径。
 * @param cwd - 会话工作区绝对路径，用于解析相对路径。
 * @param path - 模型给出的路径。
 * @returns 以 `/` 分隔的仓库相对路径；不在仓库内时返回 null。
 */
export function repositoryRelativePath(repoRoot: string, cwd: string | null, path: string): string | null {
	if (path === '') return null;
	const normalized = (value: string): string => {
		let text = value.replace(/\\/g, '/');
		if (/^[A-Za-z]:\//.test(text)) text = text.slice(0, 2).toLowerCase() + text.slice(2);
		const parts: string[] = [];
		for (const segment of text.split('/')) {
			if (segment === '' || segment === '.') continue;
			if (segment === '..') {
				parts.pop();
				continue;
			}
			parts.push(segment);
		}
		return parts.join('/');
	};
	const root = normalized(repoRoot);
	const given = normalized(path);
	// 绝对路径判定在分隔符统一之后：模型可能写 `C:\\dir/file` 这种混合形态。
	const target = /^([A-Za-z]:\/|\/)/.test(given)
		? given
		: normalized(cwd === null || cwd === '' ? given : `${cwd}/${given}`);
	if (root === '' || target === root) return null;
	if (!target.startsWith(`${root}/`)) return null;
	return target.slice(root.length + 1);
}

/**
 * 若干改动里是否有落在该仓库内的。
 *
 * @param changes - 已落地的改动。
 * @param repoRoot - 仓库根绝对路径。
 * @param cwd - 会话工作区绝对路径。
 * @returns 至少一条落在仓库内时为 true。
 */
export function hasRepositoryChange(changes: readonly FileChange[], repoRoot: string, cwd: string | null): boolean {
	return changes.some((change) => repositoryRelativePath(repoRoot, cwd, change.path) !== null);
}

/**
 * 本次事件是否应触发自动刷新。
 *
 * @param lastRefreshAt - 上一次自动刷新时间戳；从未刷新时为 0。
 * @param now - 当前时间戳。
 * @returns 距上次刷新已达冷却时间时为 true。
 */
export function isAutoRefreshDue(lastRefreshAt: number, now: number): boolean {
	return now - lastRefreshAt >= AUTO_REFRESH_COOLDOWN_MS;
}

/**
 * 抓取间隔设置值换算为毫秒，越界时收拢到区间内。
 *
 * @param seconds - 设置里的秒数；非有限数时用默认值。
 * @returns 间隔毫秒数。
 */
export function autoFetchPeriodMs(seconds: number): number {
	const value = Number.isFinite(seconds) ? Math.round(seconds) : AUTO_FETCH_PERIOD_SECONDS_DEFAULT;
	const clamped = Math.min(AUTO_FETCH_PERIOD_SECONDS_MAX, Math.max(AUTO_FETCH_PERIOD_SECONDS_MIN, value));
	return clamped * 1000;
}

/**
 * 一条缓存记录是否已过期。
 *
 * @param at - 记录写入时间戳。
 * @param now - 当前时间戳。
 * @returns 已达清理周期时为 true。
 */
export function isCacheExpired(at: number, now: number): boolean {
	return now - at >= CLEANUP_INTERVAL_MS;
}
