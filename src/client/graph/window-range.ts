/**
 * 图形区窗口化渲染的区间计算。
 *
 * 纯模块：无 React、无其它 import。输入是行偏移表（第 i 行顶部与第 i+1 行顶部之差为该行高度），
 * 输出是应挂载的行区间与滚动位置对应的顶部行下标。
 */

/** 行偏移表：`offsets[i]` 是第 i 行的顶部位置，`offsets[rowCount]` 是内容总高度。 */
export type RowOffsets = ArrayLike<number>;

/**
 * 取滚动位置对应的顶部行下标。
 *
 * 判据是最小的 `index` 使 `offsets[index + 1] > scrollTop`：滚动位置落在该行之内。
 * 滚动位置为负或超出内容高度时分别收拢到首行与末行。
 *
 * @param offsets - 行偏移表。
 * @param scrollTop - 滚动位置。
 * @param rowCount - 行数。
 * @returns 顶部行下标；行数为 0 时返回 0。
 */
export function topIndexOf(offsets: RowOffsets, scrollTop: number, rowCount: number): number {
	if (rowCount <= 0) return 0;
	let low = 0;
	let high = rowCount - 1;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (offsets[mid + 1] <= scrollTop) low = mid + 1;
		else high = mid;
	}
	return low;
}

/**
 * 取应挂载的行区间。
 *
 * 区间以顶部行为基准，向上、向下各多取 `overscan` 行；视口高度为 0（首帧尚未测量）时上下各取
 * `overscan` 行，与按实测高度渲染的结果一致。
 *
 * @param offsets - 行偏移表。
 * @param topIndex - 顶部行下标。
 * @param viewportHeight - 可视区高度。
 * @param overscan - 上下额外挂载的行数。
 * @param rowCount - 行数。
 * @returns 左闭右开的行区间 `[first, last)`。
 */
export function visibleRange(
	offsets: RowOffsets,
	topIndex: number,
	viewportHeight: number,
	overscan: number,
	rowCount: number,
): { first: number; last: number } {
	if (rowCount <= 0) return { first: 0, last: 0 };
	const top = topIndex < 0 ? 0 : (topIndex >= rowCount ? rowCount - 1 : topIndex);
	const bottom = offsets[top] + Math.max(0, viewportHeight);
	let end = top;
	while (end < rowCount && offsets[end] < bottom) end += 1;
	const first = Math.max(0, top - Math.max(0, overscan));
	const last = Math.min(rowCount, end + Math.max(0, overscan));
	return { first, last: Math.max(first, last) };
}
