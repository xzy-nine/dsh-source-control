/**
 * 路径键的归一化：仓库节点 id 与按仓库持久化的键共用同一形态。
 *
 * 统一 `/` 分隔并去掉尾斜杠；Windows 与盘符路径按大小写不敏感处理，统一小写。
 * 同一仓库在不同来源下的写法（`E:\x` / `e:/x/`）因此落到同一个键。
 */

/** 运行环境是否按大小写不敏感比较路径。 */
const CASE_INSENSITIVE = typeof navigator !== 'undefined'
	&& (/Windows/i.test(navigator.userAgent));

/**
 * 把路径规范化为稳定的键。
 *
 * @param path - 任意路径。
 * @returns `/` 分隔、去掉尾斜杠的路径；大小写不敏感环境下统一小写。
 */
export function normalizePath(path: string | null | undefined): string {
	const normalized = (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
	const insensitive = CASE_INSENSITIVE || /^[a-zA-Z]:\//.test(normalized);
	return insensitive ? normalized.toLowerCase() : normalized;
}
