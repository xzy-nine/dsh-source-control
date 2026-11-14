/**
 * 合并区间视图：左侧「当前更改」、右侧「传入的更改」，每个冲突区间中间给两个按钮
 * 把一侧替换成另一侧。
 *
 * 命名与动作取 git 与 VS Code 的既有说法（`:2:`/`Current` 为当前分支，
 * `:3:`/`Incoming` 为被合入的一侧）。视图面向的是「看清冲突并给出编辑指导」，
 * 不是完整的合并编辑器，因此不提供并集、基线或两边都丢弃。区间之外未改动的行
 * 按整行显示。
 *
 * 行选区与评论复用差异页的同一套机制：每行带行号属性，拖动选连续行后可在本页
 * 直接写评论，评论按「哪一份内容第几行」插进对话输入框。
 */
import React from 'react';
import type { MergeAnalysis, MergeChoice, MergeRange } from '../../shared/merge-ranges.js';
import { markRange, ROW_SELECTOR, type LineRange } from './line-range.ts';
import css from '../css/merge-view.module.css';

/** 一个区间的覆盖方向。 */
interface RangeAction {
	readonly choice: MergeChoice;
	/** 悬停与无障碍名称。 */
	readonly title: string;
	/** 按钮上的标记。 */
	readonly mark: string;
	/** 覆盖方向：`left` 表示把右侧覆盖到左侧。 */
	readonly direction: 'left' | 'right';
}

/**
 * 每个区间可用的两个方向。
 *
 * 措辞取 git 与 VS Code 的既有说法：`Current` 为当前分支（`:2:`，`ours`），
 * `Incoming` 为被合入的一侧（`:3:`，`theirs`），动词用「采用」。
 */
const RANGE_ACTIONS: readonly RangeAction[] = [
	{ choice: 'theirs', title: '采用传入的更改（右侧替换左侧）', mark: '《', direction: 'left' },
	{ choice: 'ours', title: '采用当前更改（左侧替换右侧）', mark: '》', direction: 'right' },
];

/** 视图属性。 */
export interface MergeViewProps {
	/** 解析结果。 */
	readonly analysis: MergeAnalysis;
	/** 各区间已选定的覆盖方向。 */
	readonly choices: ReadonlyMap<number, MergeChoice>;
	/** 是否自动换行。 */
	readonly wrap: boolean;
	/** 选择一个区间的覆盖方向。 */
	readonly onChoose: (index: number, choice: MergeChoice) => void;
	/** 动作进行中。 */
	readonly busy: boolean;
	/** 选中一段连续行后调用；`body` 为评论正文。 */
	readonly onComment: (range: LineRange, body: string) => void;
}

/** 视图里显示的一行：普通行或区间。 */
type ViewRow =
	| { readonly kind: 'common'; readonly lines: readonly string[] }
	| { readonly kind: 'range'; readonly range: MergeRange };

/**
 * 把分析结果切成可渲染的行序。
 *
 * @param analysis - 解析结果。
 * @returns 普通段与区间段，按基线顺序。
 */
export function rowsOfAnalysis(analysis: MergeAnalysis): ViewRow[] {
	const rows: ViewRow[] = [];
	let at = 0;
	for (const range of analysis.ranges) {
		if (range.baseStart > at) {
			rows.push({ kind: 'common', lines: analysis.baseLines.slice(at, range.baseStart) });
		}
		rows.push({ kind: 'range', range });
		at = range.baseStart + range.baseLength;
	}
	if (at < analysis.baseLines.length) {
		rows.push({ kind: 'common', lines: analysis.baseLines.slice(at) });
	}
	return rows;
}

/**
 * 一栏内容：该区间在这一侧的行。
 *
 * @param props - 行、起始行号与所属侧。侧决定行号属性名，供选区读出（`ours` / `theirs`）。
 * @returns 该栏元素。
 */
function Column({ lines, from, side }: {
	readonly lines: readonly string[];
	readonly from: number;
	readonly side: 'ours' | 'theirs';
}): React.ReactElement {
	return React.createElement(
		'div',
		{ className: css.column, 'data-side': side },
		lines.length === 0
			? React.createElement('div', { className: css.emptySide }, '（此处为空）')
			: renderLines(lines, from, side),
	);
}

/**
 * 把若干行画成「行号 + 文本」的一串行。
 *
 * 每行带 `data-diff-line` 与 `data-ours-line` / `data-theirs-line`：选区按侧读行号，
 * 因此评论能说清「这是哪一份内容的第几行」。
 *
 * @param lines - 行内容。
 * @param from - 起始行号。
 * @param side - 所属侧；缺省表示两侧一致的普通行。
 * @returns 行元素数组。
 */
function renderLines(lines: readonly string[], from: number, side?: 'ours' | 'theirs'): React.ReactNode[] {
	return lines.map((line, offset) => {
		const number = from + offset;
		const attrs: Record<string, unknown> = { key: offset, className: css.row, 'data-diff-line': '' };
		if (side === 'ours') attrs['data-ours-line'] = number;
		else if (side === 'theirs') attrs['data-theirs-line'] = number;
		else { attrs['data-ours-line'] = number; attrs['data-theirs-line'] = number; }
		return React.createElement(
			'div',
			attrs,
			React.createElement('span', { className: css.lineNo }, String(number)),
			React.createElement('span', { className: css.lineText }, line === '' ? '\u00a0' : line),
		);
	});
}

/**
 * 合并区间视图。
 *
 * @param props - 见 {@link MergeViewProps}。
 * @returns 视图元素。
 */
export function MergeView({ analysis, choices, wrap, onChoose, busy, onComment }: MergeViewProps): React.ReactElement {
	const rows = React.useMemo(() => rowsOfAnalysis(analysis), [analysis]);
	const host = React.useRef<HTMLDivElement | null>(null);
	const anchor = React.useRef<number | null>(null);
	const head = React.useRef<number | null>(null);
	const [selection, setSelection] = React.useState<LineRange | null>(null);
	const [body, setBody] = React.useState('');

	/** 容器里可选中的行，按显示顺序。 */
	const selectable = React.useCallback((): Element[] => {
		if (host.current === null) return [];
		return [...host.current.querySelectorAll(ROW_SELECTOR)];
	}, []);
	const paint = React.useCallback((low: number | null, high: number | null): void => {
		markRange(selectable(), low, high);
	}, [selectable]);
	/**
	 * 读出一段选区属于哪一侧、哪几行。
	 *
	 * 选区可能跨栏（左右都选到），此时按「起点所在的行」定侧：评论锚定在用户按下的那一栏。
	 *
	 * @param from - 起始下标。
	 * @param to - 结束下标。
	 * @returns 侧与行号区间；读不到行号时为 null。
	 */
	const rangeOf = React.useCallback((from: number, to: number): LineRange | null => {
		const list = selectable();
		const low = Math.min(from, to);
		const rowsInRange = list.slice(low, Math.max(from, to) + 1);
		// 起点所在的行决定评论锚定在哪一栏：只有传入侧行号的是右侧（R），其余算左侧（L）。
		const first = list.length === 0 ? null : list[Math.min(from, to)];
		const side: LineRange['side'] = first !== null && first.hasAttribute('data-theirs-line') && !first.hasAttribute('data-ours-line')
			? 'R' : 'L';
		// 行号属性在行元素**自身**上（差异页那边在行内的编号元素上，两者不通用），
		// 因此直接读属性，不能 querySelector。
		const attr = side === 'R' ? 'data-theirs-line' : 'data-ours-line';
		const numbers = rowsInRange
			.map((row) => Number(row.getAttribute(attr) ?? 'NaN'))
			.filter((value) => Number.isSafeInteger(value));
		if (numbers.length === 0) return null;
		return { side, startLine: Math.min(...numbers), endLine: Math.max(...numbers) };
	}, [selectable]);

	React.useEffect(() => {
		const element = host.current;
		if (element === null) return undefined;
		const down = (event: PointerEvent): void => {
			if (event.button !== 0 || !(event.target instanceof Element)) return;
			const row = event.target.closest(ROW_SELECTOR);
			if (row === null || !element.contains(row)) return;
			const list = selectable();
			const index = list.indexOf(row);
			if (index < 0) return;
			event.preventDefault();
			anchor.current = index;
			head.current = index;
			paint(index, index);
			setSelection(null);
		};
		const over = (event: PointerEvent): void => {
			if (anchor.current === null || event.buttons !== 1) return;
			if (!(event.target instanceof Element)) return;
			const row = event.target.closest(ROW_SELECTOR);
			if (row === null || !element.contains(row)) return;
			const index = selectable().indexOf(row);
			if (index < 0) return;
			head.current = index;
			paint(Math.min(anchor.current, index), Math.max(anchor.current, index));
		};
		const up = (): void => {
			const from = anchor.current;
			anchor.current = null;
			if (from === null) return;
			const to = head.current ?? from;
			head.current = null;
			const range = rangeOf(from, to);
			paint(range === null ? null : Math.min(from, to), range === null ? null : Math.max(from, to));
			setSelection(range);
			if (range !== null) setBody('');
		};
		element.addEventListener('pointerdown', down);
		element.addEventListener('pointerover', over);
		window.addEventListener('pointerup', up);
		return () => {
			element.removeEventListener('pointerdown', down);
			element.removeEventListener('pointerover', over);
			window.removeEventListener('pointerup', up);
		};
	}, [paint, rangeOf, selectable]);

	/** 取消评论：清掉选区与正文。 */
	const clear = React.useCallback((): void => {
		paint(null, null);
		setSelection(null);
		setBody('');
	}, [paint]);

	const chosenCount = React.useMemo(
		() => analysis.ranges.filter((range) => choices.has(range.index)).length,
		[analysis.ranges, choices],
	);
	const conflictingCount = React.useMemo(
		() => analysis.ranges.filter((range) => range.conflicting).length,
		[analysis.ranges],
	);
	if (analysis.ranges.length === 0) {
		return React.createElement('div', { className: css.mergeView, 'data-sc-merge-view': '' },
			React.createElement('div', { className: css.note }, '三方内容一致，没有需要处理的改动。'));
	}
	let baseLine = 1;
	return React.createElement(
		'div',
		{ className: css.mergeView, 'data-sc-merge-view': '', 'data-wrap': wrap ? '' : undefined },
		React.createElement(
			'div',
			{ className: css.toolbar },
			React.createElement('span', { className: css.progress }, `已采用 ${String(chosenCount)} / ${String(conflictingCount)} 处冲突`),
		),
		React.createElement(
			'div',
			{ className: css.heads },
			React.createElement('div', { className: css.head }, '当前更改'),
			React.createElement('div', { className: `${css.head} ${css.headActions}` }, '采用'),
			React.createElement('div', { className: css.head }, '传入的更改'),
		),
		React.createElement(
			'div',
			{ className: css.body, ref: host },
			...rows.map((row, index) => {
				if (row.kind === 'common') {
					const from = baseLine;
					baseLine += row.lines.length;
					return React.createElement(
						'div',
						{ key: `c${index}`, className: css.commonRow, 'data-sc-common': '' },
						...renderLines(row.lines, from),
					);
				}
				const range = row.range;
				const start = baseLine + 1;
				baseLine += range.baseLength;
				const choice = choices.get(range.index);
				const oursLines = range.ours.changed ? range.ours.lines : analysis.baseLines.slice(range.baseStart, range.baseStart + range.baseLength);
				const theirsLines = range.theirs.changed ? range.theirs.lines : analysis.baseLines.slice(range.baseStart, range.baseStart + range.baseLength);
				return React.createElement(
					'div',
					{
						key: `r${range.index}`,
						className: [css.rangeRow, range.conflicting ? css.conflict : '', choice === undefined ? '' : css.handled].filter(Boolean).join(' '),
						'data-sc-range': range.index,
						'data-conflicting': range.conflicting ? '1' : '0',
						'data-handled': choice === undefined ? '0' : '1',
					},
					React.createElement('div', { className: css.sideCell },
						React.createElement(Column, { lines: oursLines, from: start, side: 'ours' })),
					React.createElement(
						'div',
						{ className: css.actions },
						...RANGE_ACTIONS.map((action) => React.createElement('button', {
							key: action.choice,
							type: 'button',
							className: choice === action.choice ? `${css.actionButton} ${css.active}` : css.actionButton,
							title: action.title,
							'aria-label': action.title,
							'aria-pressed': choice === action.choice,
							disabled: busy,
							'data-sc-range-action': action.choice,
							'data-direction': action.direction,
							'data-index': range.index,
							onClick: () => { onChoose(range.index, action.choice); },
						}, action.mark)),
					),
					React.createElement('div', { className: css.sideCell },
						React.createElement(Column, { lines: theirsLines, from: start, side: 'theirs' })),
				);
			}),
		),
		selection === null ? null : React.createElement(
			'div',
			{ className: css.composer, 'data-sc-merge-comment': '' },
			React.createElement('div', { className: css.composerHead },
				`评论：${selection.side === 'R' ? '传入的更改' : '当前更改'}第 ${String(selection.startLine)}${selection.startLine === selection.endLine ? '' : `-${String(selection.endLine)}`} 行`),
			React.createElement('textarea', {
				className: css.composerInput,
				value: body,
				placeholder: '写下要改什么；这条评论会带着定位插进对话输入框',
				onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { setBody(event.currentTarget.value); },
			}),
			React.createElement('div', { className: css.composerActions },
				React.createElement('button', { type: 'button', className: css.composerButton, onClick: clear }, '取消'),
				React.createElement('button', {
					type: 'button', className: `${css.composerButton} ${css.primary}`,
					'data-sc-comment-submit': '',
					onClick: () => { onComment(selection, body); clear(); },
				}, '插入对话')),
		),
	);
}
