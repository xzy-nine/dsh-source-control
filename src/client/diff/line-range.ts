/**
 * 差异视图的行区间选择：从已渲染的行上读出行号，并把两次按下之间的行合成一个连续区间。
 *
 * forge 自带的选区只认 hunk 内的行：折叠区展开后的未变更行不在任何 hunk 里，跨 hunk
 * 的区间（例如整个方法体）也会被整段拒绝。本模块改用渲染结果本身作依据——每一行都带
 * `data-old-line` / `data-new-line`，因此连续行号可以横跨 hunk 与展开的未变更行。
 *
 * 手势只从行号列起手：正文区留给浏览器原生的文本选择与复制。行号列没有可复制的正文，
 * 从那里按下不会与复制动作冲突，因此它是评论选区的唯一入口。
 */

/** 一行在两侧的行号；不存在的侧为 null。 */
export interface RowNumber {
	readonly old: number | null;
	readonly new: number | null;
}

/** 一个跨行的连续区间。 */
export interface LineRange {
	/** 行号所在的一侧：改动后（R）或改动前（L）。 */
	readonly side: 'L' | 'R';
	/** 起始行号，闭区间。 */
	readonly startLine: number;
	/** 结束行号，闭区间。 */
	readonly endLine: number;
}

/** 可被选中的行：统一布局的行、并排布局的配对行。 */
export const ROW_SELECTOR = '[data-diff-line], [data-diff-pair]';

/**
 * 读一个属性里的行号。
 *
 * @param value - 属性值。
 * @returns 行号；缺失或不是整数时为 null。
 */
function lineOf(value: string | null): number | null {
	if (value === null || value === '') return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * 读出一行的两侧行号。
 *
 * @param row - 渲染出的行元素。
 * @returns 该行的行号。
 */
export function rowNumber(row: Element): RowNumber {
	return {
		old: lineOf(row.querySelector('[data-old-line]')?.getAttribute('data-old-line') ?? null),
		new: lineOf(row.querySelector('[data-new-line]')?.getAttribute('data-new-line') ?? null),
	};
}

/**
 * 判定按下位置是否落在行号列。
 *
 * 行号列只放数字，正文元素带 `data-review-code`，合并视图的行号带 `data-sc-line-no`：
 * 命中后者算行号列，命中前者算正文。forge 的行号元素没有标记属性，因此退回「整段文本
 * 就是该行行号之一」这条判据——行号列里只有这个数字，正文里要恰好只写一个与自身行号
 * 相同的数字才会误判。
 *
 * @param target - 按下命中的元素。
 * @param row - 该元素所在的行。
 * @returns 落在行号列时为 true。
 */
export function gutterPressed(target: Element, row: Element): boolean {
	if (target.closest('[data-sc-line-no]') !== null) return true;
	if (target.closest('[data-review-code]') !== null) return false;
	const text = target.textContent.trim();
	if (!/^[0-9]+$/.test(text)) return false;
	const numbers = rowNumber(row);
	const value = Number(text);
	return value === numbers.old || value === numbers.new;
}

/**
 * 取指针事件落到的行。
 *
 * 命中判定有三层：目标必须是元素、必须落在可选中行的选择器内、且那一行确实属于当前容器
 * （事件可能来自浮动层或已卸载的旧节点）。
 *
 * @param event - 指针事件。
 * @param host - 差异视图的根元素。
 * @returns 命中的行；没落在一行上时为 null。
 */
export function rowAt(event: { readonly target: EventTarget | null }, host: Element): Element | null {
	if (!(event.target instanceof Element)) return null;
	const row = event.target.closest(ROW_SELECTOR);
	return row === null || !host.contains(row) ? null : row;
}

/**
 * 取指针事件落到的行在给定列表里的下标。
 *
 * 两个差异视图的手势均经这一处取下标：事件没落在可选行上时为 null，落在列表之外同样为 null。
 *
 * @param event - 指针事件。
 * @param host - 差异视图的根元素。
 * @param rows - 可选中行的当前列表。
 * @returns 行下标；没落在可选行上时为 null。
 */
export function rowIndexAt(event: { readonly target: EventTarget | null }, host: Element, rows: readonly Element[]): number | null {
	const row = rowAt(event, host);
	if (row === null) return null;
	const index = rows.indexOf(row);
	return index < 0 ? null : index;
}

/**
 * 列出容器里所有可被选中的行，按显示顺序。
 *
 * 折叠的未变更行是一个按钮而不是行，没有行号，因此不参与选择；展开后它变成普通行，
 * 自然回到这个列表里。
 *
 * @param host - 差异视图的根元素。
 * @returns 可选择的行。
 */
export function selectableRows(host: Element): Element[] {
	const rows: Element[] = [];
	for (const row of host.querySelectorAll(ROW_SELECTOR)) {
		const numbers = rowNumber(row);
		if (numbers.old !== null || numbers.new !== null) rows.push(row);
	}
	return rows;
}

/**
 * 把起止两行之间的全部行合成一个连续区间。
 *
 * 行号取所选一侧：优先改动后（新侧），整段都没有新侧行号时（例如纯删除）改用改动前。
 * 这样跨 hunk 与展开的未变更行都能得到一个连续区间。
 *
 * @param rows - {@link selectableRows} 的结果。
 * @param fromIndex - 起始行下标。
 * @param toIndex - 结束行下标。
 * @returns 连续区间；区间里没有任何行号时为 null。
 */
export function rangeBetween(rows: readonly Element[], fromIndex: number, toIndex: number): LineRange | null {
	const low = Math.min(fromIndex, toIndex);
	const high = Math.max(fromIndex, toIndex);
	const picked = rows.slice(low, high + 1).map(rowNumber);
	const side: LineRange['side'] = picked.some((item) => item.new !== null) ? 'R' : 'L';
	const lines: number[] = [];
	for (const item of picked) {
		const line = side === 'R' ? item.new : item.old;
		if (line !== null) lines.push(line);
	}
	if (lines.length === 0) return null;
	return { side, startLine: Math.min(...lines), endLine: Math.max(...lines) };
}

/**
 * 在容器里标出所选区间对应的行，并清掉上一次的标记。
 *
 * @param rows - {@link selectableRows} 的结果。
 * @param low - 起始行下标，null 表示清除标记。
 * @param high - 结束行下标。
 */
export function markRange(rows: readonly Element[], low: number | null, high: number | null): void {
	for (const [index, row] of rows.entries()) {
		if (low === null || high === null || index < low || index > high) row.removeAttribute('data-sc-range');
		else row.setAttribute('data-sc-range', '');
	}
}
