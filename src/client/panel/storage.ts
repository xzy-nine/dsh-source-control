/**
 * 客户端存储：宿主侧持久化 + 内存缓存，以及会话级存储。
 *
 * 两级存储：
 * - 宿主持久化：数据落在宿主（`$DSH_HOME/dsh-source-control/`），本模块只在首屏预取一次，
 *   之后读走内存缓存；写更新缓存并异步落盘。键值对读写用 {@link loadValue} / {@link saveValue}。
 * - 会话级：数据落在浏览器 sessionStorage，直读直写，不经宿主也不进内存缓存。读写用
 *   {@link loadSessionValue} / {@link saveSessionValue} / {@link clearSessionValue}。
 *
 * 预取是异步的，而 `useState(() => loadValue(...))` 在挂载时同步执行，因此首次渲染读到的是回退值，
 * 且 useState 的初始值不会随预取完成而重算。调用方须在预取完成后把状态重新按真实值初始化，
 * 否则每次进入都会显示默认值（表现为「设置每次都被重置」）。
 *
 * 本模块是客户端唯一的存储出口，其它模块不直接访问 sessionStorage。
 */
import { readState, writeState } from '../api/index.ts';
/** 内存缓存：宿主状态的镜像。 */
let cache: Record<string, unknown> = {};

/** 是否已完成首次预取。 */
let primed = false;

/** 预取进行中的 Promise；并发调用共享一次往返。 */
let priming: Promise<void> | null = null;

/** 当前工作区路径；写盘时作为 repo 参数。 */
let currentCwd: string | null = null;
/** 预取完成时的订阅者；预取完成后一次性通知。 */
const readyListeners = new Set<() => void>();

/**
 * 工作区路径尚未确定时暂存的写入。
 *
 * 挂载早期（预取尚未开始）可能先发生写入，此时拿不到 repo 参数；直接丢弃会让那次改动永久丢失，
 * 因此先记下来，路径确定后一并补写。
 */
const pendingWrites = new Map<string, unknown>();

/**
 * 首次预取宿主状态到内存缓存。
 *
 * @param cwd - 会话工作区路径。
 * @returns 无。
 */
export async function primeStorage(cwd: string): Promise<void> {
	currentCwd = cwd;
	if (primed) return;
	if (priming !== null) return priming;
	priming = (async () => {
		try {
			cache = await readState(cwd);
			// 补写路径未定期间暂存的改动：预取刚读回的值以后写为准。
			for (const [key, value] of pendingWrites) {
				if (value === null) delete cache[key]; else cache[key] = value;
				void writeState(cwd, key, value).catch(() => { /* 落盘失败时保留内存态 */ });
			}
			pendingWrites.clear();
			primed = true;
			for (const listener of readyListeners) listener();
			readyListeners.clear();
		} catch {
			/* 预取失败时保持空缓存，读写退化为内存态 */
		} finally {
			priming = null;
		}
	})();
	return priming;
}

/**
 * 是否已完成预取。
 *
 * @returns 完成时为 true。
 */
export function storageReady(): boolean {
	return primed;
}

/**
 * 订阅预取完成。
 *
 * 已就绪时立即调用；否则等预取完成后调用一次。用于把挂载时按回退值初始化的状态改成真实值。
 *
 * @param listener - 预取完成时调用。
 * @returns 取消订阅。
 */
export function subscribeStorage(listener: () => void): () => void {
	if (primed) { listener(); return () => { /* 已就绪，无需取消 */ }; }
	readyListeners.add(listener);
	return () => { readyListeners.delete(listener); };
}

/**
 * 读取一个键值。
 *
 * @param key - 键。
 * @param fallback - 缺失时的回退值。
 * @returns 值或回退值。
 */
export function loadValue<T>(key: string, fallback: T): T {
	const value = cache[key];
	return value === undefined ? fallback : value as T;
}

/**
 * 写入一个键值：更新缓存并异步落盘。
 *
 * @param key - 键。
 * @param value - 值；null 表示删除。
 * @returns 无。
 */
export function saveValue(key: string, value: unknown): void {
	if (value === null || value === undefined) delete cache[key];
	else cache[key] = value;
	const cwd = currentCwd;
	if (cwd === null) {
		// 路径未定：先暂存，待预取拿到 cwd 后补写，避免这次改动丢失。
		pendingWrites.set(key, value ?? null);
		return;
	}
	void writeState(cwd, key, value ?? null).catch(() => { /* 落盘失败时保留内存态 */ });
}

/**
 * 清掉缓存，使下次预取重新读取。
 *
 * 只涉及宿主持久化的内存镜像，不影响会话级存储。
 *
 * @returns 无。
 */
export function resetStorageCache(): void {
	cache = {};
	primed = false;
	priming = null;
}

/** 提交信息草稿的键前缀。 */
const DRAFT_KEY_PREFIX = 'ggg-commit-msg:';

/**
 * 按仓库根路径构造提交信息草稿的会话键。
 *
 * @param repoPath - 仓库根绝对路径。
 * @returns 键 `ggg-commit-msg:<repoPath>`。
 */
export function draftKeyOf(repoPath: string): string {
	return `${DRAFT_KEY_PREFIX}${repoPath}`;
}

/**
 * 取 sessionStorage；不存在时返回 null。
 *
 * @returns sessionStorage 或 null。
 */
function sessionStore(): Storage | null {
	return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

/**
 * 读取会话级存储的一个键。
 *
 * sessionStorage 不存在、访问抛错或值不是合法 JSON 时一律给回退值。
 *
 * @param key - 键。
 * @param fallback - 回退值。
 * @returns 值或回退值。
 */
export function loadSessionValue<T>(key: string, fallback: T): T {
	try {
		const store = sessionStore();
		if (store === null) return fallback;
		const raw = store.getItem(key);
		if (raw === null) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/**
 * 写入会话级存储的一个键。
 *
 * 值为 null / undefined 时删除该键；sessionStorage 不存在或访问抛错时静默。
 *
 * @param key - 键。
 * @param value - 值。
 * @returns 无。
 */
export function saveSessionValue(key: string, value: unknown): void {
	try {
		const store = sessionStore();
		if (store === null) return;
		if (value === null || value === undefined) store.removeItem(key);
		else store.setItem(key, JSON.stringify(value));
	} catch {
		/* 会话存储不可用时静默 */
	}
}

/**
 * 删除会话级存储的一个键。
 *
 * sessionStorage 不存在或访问抛错时静默。
 *
 * @param key - 键。
 * @returns 无。
 */
export function clearSessionValue(key: string): void {
	try {
		sessionStore()?.removeItem(key);
	} catch {
		/* 会话存储不可用时静默 */
	}
}
