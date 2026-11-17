/**
 * 分段暂存轨道的几何：把每个补丁块落到它在差异视图里的实际位置。
 *
 * 竖排按钮按块的首行定位。块在屏幕上的高度与「行数」不是一回事：并排布局把一串删除行
 * 与紧随其后的新增行配成同一行，自动换行又把一行撑成多行。因此位置与高度都从渲染结果
 * 量出来，而不是按行数推算。
 */

import { rowNumber, selectableRows } from './line-range.ts';
import type { FileHunk } from '../api/merge.ts';

/** 一个块在轨道上的落位；单位是相对差异正文顶部的像素。 */
export interface HunkSlot {
	/** 块下标。 */
	readonly index: number;
	/** 块首行距正文顶部的距离。 */
	readonly top: number;
	/** 块占用的高度。 */
	readonly height: number;
}

/**
 * 找出某一块的首行在可选择行里的下标。
 *
 * 块的首行由块头两侧行号确定：新侧有行时按新侧找，纯删除的块按旧侧找。展开的未变更行
 * 与折叠按钮都不影响这条判据，因为它们不会带该块的行号。
 *
 * @param rows - 可选择的行。
 * @param hunk - 补丁块。
 * @returns 首行的下标；找不到时为 -1。
 */
function firstRowOf(rows: readonly Element[], hunk: FileHunk): number {
	for (const [index, row] of rows.entries()) {
		const numbers = rowNumber(row);
		if (hunk.newLines > 0 ? numbers.new === hunk.newStart : numbers.old === hunk.oldStart) return index;
	}
	return -1;
}

/**
 * 量出各块在正文里的落位。
 *
 * 块的顶端取首行相对正文的偏移；高度取到下一个块的首行为止，最后一块取到正文末尾。
 * 这样块之间的折叠区也被算进上一个块的高度里，按钮列不会与正文错位。
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
	const tops: number[] = [];
	const indexes: number[] = [];
	for (const hunk of hunks) {
		const at = firstRowOf(rows, hunk);
		if (at < 0) continue;
		indexes.push(hunk.index);
		tops.push(rows[at].getBoundingClientRect().top - origin);
	}
	if (tops.length === 0) return [];
	const bottom = host.getBoundingClientRect().bottom - origin;
	return tops.map((top, at) => ({
		index: indexes[at],
		top,
		height: (at + 1 < tops.length ? tops[at + 1] : bottom) - top,
	}));
}
