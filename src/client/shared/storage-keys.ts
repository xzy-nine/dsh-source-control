/**
 * 浏览器存储的键枚举：localStorage 与 sessionStorage 共用。
 */

/**
 * 枚举一个 store 里的全部键。
 *
 * 优先用 `key(index)` 按下标遍历；store 未提供该方法时退回 `Object.keys`。
 * 访问被拒绝时给出空列表，调用方按「没有数据」处理。
 *
 * @param store - localStorage 或 sessionStorage。
 * @returns 键列表；访问失败时为空数组。
 */
export function storageKeys(store: Storage): string[] {
	const keys: string[] = [];
	try {
		if (typeof store.key === 'function') {
			for (let at = 0; at < store.length; at += 1) {
				const key = store.key(at);
				if (key !== null) keys.push(key);
			}
			return keys;
		}
		return Object.keys(store);
	} catch {
		return [];
	}
}
