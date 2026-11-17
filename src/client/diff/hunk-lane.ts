/**
 * 分段暂存轨道的几何：把每个补丁块落到它在差异视图里的实际位置。
 *
 * 按钮摆在块**改动区间**的垂直中点，而不是块首行：块首行之前常跟着上下文行，贴首行会
 * 让按钮看起来属于上面的未改动区域。块在屏幕上的高度与「行数」也不是一回事——并排布局
 * 把一串删除行与紧随其后的新增行配成同一行，自动换行又把一行撑成多行——因此位置与高度
 * 都从渲染结果量出来。
 */

import { rowNumber, selectableRows } from './line-range.ts';
import type { FileHunk } from '../api/merge.ts';

/** 一个块在轨道上的落位；单位是相对差异正文顶部的像素。 */
export interface HunkSlot {
	/** 块下标。 */
	readonly index: number;
	/** 块改动区间的顶端距正文顶部的距离。 */
	readonly top: number;
	/** 块改动区间的高度。 */
	readonly height: number;
}

/**
 * 找出某一块的改动区间覆盖哪些行。
 *
 * 块的改动区间由块头两侧行号确定：新侧有内容时覆盖新侧行号，纯删除的块覆盖旧侧行号。
 * 块内的上下文行因此被排除在外——它们没有改动，不该把按钮往下拽。
 *
 * @param rows - 可选择的行。
 * @param hunk - 补丁块。
 * @returns 该块改动区间覆盖的行下标，按显示顺序；找不到时为接下来。
 */
function changedRowIndexes(rows: readonly Element[], hunk: FileHunk): number[] {
	const useNew = hunk.newLines > 0;
	const from = useNew ? hunk.newStart : hunk.oldStart;
	const to = from + (useNew ? hunk.newLines : hunk.oldLines) - 1;
	const picked: number[] = [];
	for (const [index, row] of rows.entries()) {
		const numbers = rowNumber(row);
		const line = useNew ? numbers.new : numbers.old;
		if (line !== null && line >= from && line <= to) picked.push(index);
	}
	return picked;
}

/**
 * 量出各块改动区间在正文里的落位。
 *
 * 顶端取改动首行、底端取改动末行：两端都从渲染结果量出，因此折叠区、自动换行与配对行
 * 都不会让按钮错位。按钮在 {@link HunkSlot} 的中点上，由轨道自己居中。
 *
 * @param host - 差异正文的滚动容器。
 * @param hunks - 各补丁块，按块顺序。
 * @returns 各块的落位；行的位置量不出来时为空数组。
 */
export function hunkSlots(host: Element | null, hunks: readonly FileHunk[]): HunkSlot[] {
	if (host === null || hunks.length === 0) return [];
	const rows = selectableRows(host);
	if (rows.length === 0) return [];
	const origin = host.getBoundingClientRect().top;
	const slots: HunkSlot[] = [];
	for (const hunk of hunks) {
		const picked = changedRowIndexes(rows, hunk);
		if (picked.length === 0) continue;
		const first = rows[picked[0]].getBoundingClientRect();
		const last = rows[picked[picked.length - 1]].getBoundingClientRect();
		slots.push({ index: hunk.index, top: first.top - origin, height: last.bottom - first.top });
	}
	return slots;
}
/**
 * 标出某一块的改动区间，并清掉上一块的标记。
 *
 * 用于指到分段按钮时把该块的改动行高亮：区间与按钮落位取自同一套行号判据，因此高亮
 * 一定会盖住按钮对应的那些行。
 *
 * @param host - 差异正文的滚动容器。
 * @param hunks - 各补丁块。
 * @param index - 要标出的块下标；null 表示清除标记。
 * @returns 无。
 */
export function markHunkRows(host: Element | null, hunks: readonly FileHunk[], index: number | null): void {
	if (host === null) return;
	for (const row of selectableRows(host)) row.removeAttribute('data-sc-hunk-hover');
	if (index === null) return;
	const hunk = hunks.find((item) => item.index === index);
	if (hunk === undefined) return;
	const rows = selectableRows(host);
	for (const at of changedRowIndexes(rows, hunk)) rows[at].setAttribute('data-sc-hunk-hover', '');
}
