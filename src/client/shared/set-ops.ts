/**
 * 不可变集合的小工具：折叠/勾选状态都按 `Set` 存，更新时要交出新的实例。
 */

/**
 * 切换一个成员：在则删、不在则加。
 *
 * @param previous - 原集合。
 * @param value - 要切换的成员。
 * @returns 新集合；成员状态确实变化时总是新实例。
 */
export function toggleIn<T>(previous: ReadonlySet<T>, value: T): Set<T> {
	const next = new Set(previous);
	if (next.has(value)) next.delete(value);
	else next.add(value);
	return next;
}

/**
 * 加一组成员。
 *
 * @param previous - 原集合。
 * @param values - 要加入的成员。
 * @returns 新集合。
 */
export function addAll<T>(previous: ReadonlySet<T>, values: Iterable<T>): Set<T> {
	const next = new Set(previous);
	for (const value of values) next.add(value);
	return next;
}
