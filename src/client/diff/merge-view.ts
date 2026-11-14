/**
 * 合并区间视图：左我方、右对方，每个可冲突区间给一行「采纳 / 两者都留 / 忽略」。
 *
 * 照 VS Code 合并编辑器的布局分层：输入侧（我方 / 对方）各自成栏、按块着色，
 * 结果由选择表推出而不直接编辑；两栏之间的分栏列承载该区间的动作，因此动作属于
 * 「这一段」而不是整个文件。区间之外的未改动行按整行显示。
 *
 * 与 VS Code 的差别只在承载：那边是三个 Monaco 编辑器加 view zone，这里用一份
 * 只读的区间表渲染，样式取本仓库的 ui 变量。
 */
import React from 'react';
import type { MergeAnalysis, MergeChoice, MergeRange } from '../../shared/merge-ranges.js';
import css from '../css/merge-view.module.css';

/** 每段可用的动作。 */
interface RangeAction {
	readonly choice: MergeChoice;
	/** 悬停与无障碍名称。 */
	readonly title: string;
	/** 按钮上的短标记。 */
	readonly mark: string;
}

/**
 * 动作表：两侧都有改动时给「采纳我方 / 采纳对方 / 两者都留 / 忽略」；
 * 只有一侧改动时只给该侧的采纳，另一侧本来就是基线。
 */
function actionsOf(range: MergeRange): RangeAction[] {
	if (!range.conflicting) {
		return range.ours.changed
			? [{ choice: 'ours', title: '采纳我方这一处', mark: '左' }]
			: [{ choice: 'theirs', title: '采纳对方这一处', mark: '右' }];
	}
	return [
		{ choice: 'ours', title: '采纳我方这一处', mark: '左' },
		{ choice: 'theirs', title: '采纳对方这一处', mark: '右' },
		{ choice: 'both', title: '两边的改动都留下', mark: '合' },
		{ choice: 'base', title: '保留基线内容', mark: '基' },
		{ choice: 'none', title: '两边都不要', mark: '删' },
	];
}

/** 视图属性。 */
export interface MergeViewProps {
	/** 解析结果。 */
	readonly analysis: MergeAnalysis;
	/** 各区间已选定的取舍。 */
	readonly choices: ReadonlyMap<number, MergeChoice>;
	/** 是否自动换行。 */
	readonly wrap: boolean;
	/** 选择一个区间的取舍。 */
	readonly onChoose: (index: number, choice: MergeChoice) => void;
	/** 动作进行中。 */
	readonly busy: boolean;
}

/** 结果视图里显示的一行：普通行、区间标题或区间内容。 */
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
 * 一栏内容：行号 + 行文本。
 *
 * @param props - 行、起始行号与是否标出空侧。
 * @returns 该栏元素。
 */
function Column({ lines, from, side }: { readonly lines: readonly string[]; readonly from: number; readonly side?: 'ours' | 'theirs' }): React.ReactElement {
	return React.createElement(
		'div',
		{ className: css.column, 'data-side': side },
		lines.length === 0
			? React.createElement('div', { className: css.emptySide }, '（此处被删除）')
			: renderLines(lines, from),
	);
}

/**
 * 把若干行画成「行号 + 文本」的一串行。
 *
 * 三处都要这一种画法：我方栏、对方栏、以及区间之外的公共行。
 *
 * @param lines - 行内容。
 * @param from - 起始行号。
 * @returns 行元素数组。
 */
function renderLines(lines: readonly string[], from: number): React.ReactNode[] {
	return lines.map((line, offset) => React.createElement(
		'div',
		{ key: offset, className: css.row },
		React.createElement('span', { className: css.lineNo }, String(from + offset)),
		React.createElement('span', { className: css.lineText }, line === '' ? '\u00a0' : line),
	));
}

/**
 * 合并区间视图。
 *
 * @param props - 见 {@link MergeViewProps}。
 * @returns 视图元素。
 */
export function MergeView({ analysis, choices, wrap, onChoose, busy }: MergeViewProps): React.ReactElement {
	const rows = React.useMemo(() => rowsOfAnalysis(analysis), [analysis]);
	const chosenCount = React.useMemo(
		() => analysis.ranges.filter((range) => choices.has(range.index)).length,
		[analysis.ranges, choices],
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
			React.createElement('span', { className: css.progress },
				`已处理 ${String(chosenCount)} / ${String(analysis.ranges.filter((range) => range.conflicting).length)} 处冲突`),
		),
		React.createElement(
			'div',
			{ className: css.heads },
			React.createElement('div', { className: css.head }, '我方'),
			React.createElement('div', { className: cxHead(css.head, css.headActions) }, '取舍'),
			React.createElement('div', { className: css.head }, '对方'),
		),
		React.createElement(
			'div',
			{ className: css.body },
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
				return React.createElement(
					'div',
					{
						key: `r${range.index}`,
						className: cxRange(css.rangeRow, range.conflicting, choice !== undefined),
						'data-sc-range': range.index,
						'data-conflicting': range.conflicting ? '1' : '0',
						'data-handled': choice === undefined ? '0' : '1',
					},
					React.createElement('div', { className: css.sideCell },
						React.createElement(Column, {
							lines: range.ours.changed ? range.ours.lines : analysis.baseLines.slice(range.baseStart, range.baseStart + range.baseLength),
							from: start, side: 'ours',
						})),
					React.createElement(
						'div',
						{ className: css.actions },
						...actionsOf(range).map((action) => React.createElement('button', {
							key: action.choice,
							type: 'button',
							className: activeAction(css.actionButton, choice === action.choice),
							title: action.title,
							'aria-label': action.title,
							'aria-pressed': choice === action.choice,
							disabled: busy,
							'data-sc-range-action': action.choice,
							'data-index': range.index,
							onClick: () => { onChoose(range.index, action.choice); },
						}, action.mark)),
					),
					React.createElement('div', { className: css.sideCell },
						React.createElement(Column, {
							lines: range.theirs.changed ? range.theirs.lines : analysis.baseLines.slice(range.baseStart, range.baseStart + range.baseLength),
							from: start, side: 'theirs',
						})),
				);
			}),
		),
	);
}

/** 拼类名。 */
function cxHead(...names: string[]): string {
	return names.filter(Boolean).join(' ');
}

/** 区间行的类名：冲突 / 已处理各自一档。 */
function cxRange(base: string, conflicting: boolean, handled: boolean): string {
	return [base, conflicting ? css.conflict : '', handled ? css.handled : ''].filter(Boolean).join(' ');
}

/** 动作按钮的类名：当前已选中的那一档加高亮。 */
function activeAction(base: string, active: boolean): string {
	return active ? `${base} ${css.active}` : base;
}
