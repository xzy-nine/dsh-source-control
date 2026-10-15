/**
 * 客户端存储：宿主侧持久化 + 内存缓存。
 *
 * 数据统一落在宿主（`$DSH_HOME/dsh-source-control/`），本模块只在首屏预取一次，之后读走内存
 * 缓存（同步，供 useState 初始化），写更新缓存并异步落盘。预取完成前读到的是回退值，预取完成
 * 后由面板重新渲染补齐。
 *
 * 会话级与持久化级在此已无区别：两者都跨浏览器与标签页保留。
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
			primed = true;
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
	if (cwd === null) return;
	void writeState(cwd, key, value ?? null).catch(() => { /* 落盘失败时保留内存态 */ });
}

/**
 * 清掉缓存，使下次预取重新读取。
 *
 * @returns 无。
 */
export function resetStorageCache(): void {
	cache = {};
	primed = false;
	priming = null;
}
