/**
 * 客户端存储：会话级用 sessionStorage、持久化用 localStorage，读写失败时回退。
 *
 * 窗口级状态只存于组件 state，不经本模块。
 */

/**
 * 读取会话级存储：刷新保留，关闭标签页清除。
 *
 * @param key - 存储键。
 * @param fallback - 缺失或解析失败时的回退值。
 * @returns 存储值或回退值。
 */
export function loadSession<T>(key: string, fallback: T): T {
	try {
		const raw = sessionStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

/**
 * 写入会话级存储。
 *
 * @param key - 存储键。
 * @param value - 待写入的值。
 * @returns 无。
 */
export function saveSession(key: string, value: unknown): void {
	try {
		sessionStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* 忽略写入失败 */
	}
}

/**
 * 读取持久化存储：跨标签页与浏览器重启保留。
 *
 * @param key - 存储键。
 * @param fallback - 缺失或解析失败时的回退值。
 * @returns 存储值或回退值。
 */
export function loadPersistent<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

/**
 * 写入持久化存储。
 *
 * @param key - 存储键。
 * @param value - 待写入的值。
 * @returns 无。
 */
export function savePersistent(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* 忽略写入失败 */
	}
}
