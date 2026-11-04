/**
 * 引用短名与完整名的换算，以及旧版筛选值的收敛。
 *
 * 客户端共享：`panel/refs.ts` 的筛选读写与 `api/state.ts` 的浏览器旧数据迁移都用。
 */

/**
 * 取一个引用在持久化与请求里使用的完整名。
 *
 * @param name - 引用短名。
 * @param type - 引用种类。
 * @returns 完整引用名，如 `refs/heads/main`、`refs/remotes/origin/main`。
 */
export function refIdOf(name: string, type: 'branch' | 'tag' | 'remote'): string {
	if (name.startsWith('refs/')) return name;
	if (type === 'tag') return `refs/tags/${name}`;
	if (type === 'remote') return `refs/remotes/${name}`;
	return `refs/heads/${name}`;
}

/**
 * 把字符串列表收敛成非空字符串数组。
 *
 * @param value - 待收敛的值。
 * @returns 非空字符串组成的数组。
 */
export function idsOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((id): id is string => typeof id === 'string' && id !== '');
}
