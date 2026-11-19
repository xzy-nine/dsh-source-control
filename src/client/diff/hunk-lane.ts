/**
 * 分段暂存轨道的几何：把每个补丁块落到它在差异视图里的实际位置。
 *
 * 按钮摆在块**改动区间**的垂直中点，位置与高度都从渲染结果量出。并排布局把一串删除行与
 * 紧随其后的新增行配成同一行，自动换行又把一行撑成多行：块在屏幕上的高度不等于行数。
 *
 * 行号到行元素的索引只建一次。逐块扫全部行会让每次重排与每次悬停的代价按
 * 「块数 × 行数」增长。
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

/** 行号到行元素下标的两侧索引。 */
interface RowIndex {
	readonly rows: readonly Element[];
	readonly byOld: ReadonlyMap<number, number>;
	readonly byNew: ReadonlyMap<number, number>;
}

/**
 * 一次遍历建出两侧的行号索引。
 *
 * @param host - 差异正文的滚动容器。
 * @returns 行元素与两侧索引；容器为空时行表为空。
 */
function indexRows(host: Element | null): RowIndex {
	const rows = host === null ? [] : selectableRows(host);
	const byOld = new Map<number, number>();
	const byNew = new Map<number, number>();
	for (const [index, row] of rows.entries()) {
		const numbers = rowNumber(row);
		if (numbers.old !== null) byOld.set(numbers.old, index);
		if (numbers.new !== null) byNew.set(numbers.new, index);
	}
	return { rows, byOld, byNew };
}

/**
 * 一块改动区间的一侧与行号范围。
 *
 * @param hunk - 补丁块。
 * @returns 取哪一侧与起止行号。
 */
function changedSpan(hunk: FileHunk): { readonly side: 'old' | 'new'; readonly from: number; readonly to: number } {
	const side = hunk.newLines > 0 ? 'new' : 'old';
	const from = side === 'new' ? hunk.newStart : hunk.oldStart;
	const to = from + (side === 'new' ? hunk.newLines : hunk.oldLines) - 1;
	return { side, from, to };
}

/**
 * 找出某一块的改动区间覆盖哪些行。
 *
 * 块的改动区间由块头两侧行号确定：新侧有内容时覆盖新侧行号，纯删除的块覆盖旧侧行号。
 * 块内的上下文行不在其中。
 *
 * @param index - {@link indexRows} 的结果。
 * @param hunk - 补丁块。
 * @returns 该块改动区间覆盖的行元素，按显示顺序。
 */
function changedRows(index: RowIndex, hunk: FileHunk): Element[] {
	const { side, from, to } = changedSpan(hunk);
	const lookup = side === 'new' ? index.byNew : index.byOld;
	const picked: Element[] = [];
	for (let line = from; line <= to; line += 1) {
		const at = lookup.get(line);
		if (at !== undefined) picked.push(index.rows[at]);
	}
	return picked;
}

/**
 * 量出各块改动区间在正文里的落位。
 *
 * 顶端取改动首行、底端取改动末行，两端都从渲染结果量出。按钮落在 {@link HunkSlot} 的
 * 中点上，由轨道居中。
 *
 * @param host - 差异正文的滚动容器。
 * @param hunks - 各补丁块，按块顺序。
 * @returns 各块的落位；行的位置量不出来时为空数组。
 */
export function hunkSlots(host: Element | null, hunks: readonly FileHunk[]): HunkSlot[] {
	if (host === null || hunks.length === 0) return [];
	const index = indexRows(host);
	if (index.rows.length === 0) return [];
	const origin = host.getBoundingClientRect().top;
	const slots: HunkSlot[] = [];
	for (const hunk of hunks) {
		const picked = changedRows(index, hunk);
		if (picked.length === 0) continue;
		const first = picked[0].getBoundingClientRect();
		const last = picked[picked.length - 1].getBoundingClientRect();
		slots.push({ index: hunk.index, top: first.top - origin, height: last.bottom - first.top });
	}
	return slots;
}

/**
 * 清掉当前的悬停标记。
 *
 * 只查已标记的那些行，不遍历整个正文：悬停来回移动时这条路径最频繁。
 *
 * @param host - 差异正文的滚动容器。
 * @returns 无。
 */
function clearHoverMark(host: Element): void {
	for (const row of host.querySelectorAll('[data-sc-hunk-hover]')) row.removeAttribute('data-sc-hunk-hover');
}

/**
 * 标出某一块的改动区间，并清掉上一块的标记。
 *
 * 用于指到分段按钮时把该块的改动行高亮。高亮与按钮落位取自同一套行号判据。
 *
 * @param host - 差异正文的滚动容器。
 * @param hunks - 各补丁块。
 * @param index - 要标出的块下标；null 表示清除标记。
 * @returns 无。
 */
export function markHunkRows(host: Element | null, hunks: readonly FileHunk[], index: number | null): void {
	if (host === null) return;
	clearHoverMark(host);
	if (index === null) return;
	const hunk = hunks.find((item) => item.index === index);
	if (hunk === undefined) return;
	for (const row of changedRows(indexRows(host), hunk)) row.setAttribute('data-sc-hunk-hover', '');
}

/**
 * 把某一块的改动首行滚进视口。
 *
 * @param host - 差异正文的滚动容器。
 * @param hunks - 各补丁块。
 * @param index - 目标块下标。
 * @returns 找到并滚动了为 true；块或它的行不在渲染结果里时为 false。
 */
export function scrollToHunk(host: Element | null, hunks: readonly FileHunk[], index: number): boolean {
	if (host === null) return false;
	const hunk = hunks.find((item) => item.index === index);
	if (hunk === undefined) return false;
	const picked = changedRows(indexRows(host), hunk);
	if (picked.length === 0) return false;
	const first = picked[0];
	// 没有布局的环境（测试里的 jsdom）没有这个方法：跳转在那边只做定位成功与否。
	if (typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'center' });
	return true;
}

/**
 * 一块改动区间的行号文案。
 *
 * 悬停提示用行号而不是补丁头的 `-1,5 +1,5`：后者是 git 的写法，读起来要先换算。
 *
 * @param hunk - 补丁块。
 * @returns 形如「第 10 行」或「第 10-12 行」。
 */
export function hunkLineText(hunk: FileHunk): string {
	const { from, to } = changedSpan(hunk);
	return from === to ? `第 ${String(from)} 行` : `第 ${String(from)}-${String(to)} 行`;
}
/**
 * 两组落位是否等价。
 *
 * 轨道按落位画按钮；重复写入相同的值会触发重渲染与重新量算。
 *
 * @param left - 上一次的落位。
 * @param right - 这一次的落位。
 * @returns 长度与每一项的块下标、位置、高度都相同时为 true。
 */
export function sameSlots(left: readonly HunkSlot[], right: readonly HunkSlot[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (const [at, slot] of left.entries()) {
		const other = right[at];
		if (slot.index !== other.index) return false;
		// 亚像素抖动不该触发重排。
		if (Math.round(slot.top) !== Math.round(other.top)) return false;
		if (Math.round(slot.height) !== Math.round(other.height)) return false;
	}
	return true;
}
