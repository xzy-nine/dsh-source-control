/**
 * 会话级存储：窗口存活期内有效，读写失败时回退。
 */

/**
 * 读取会话级存储。
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
