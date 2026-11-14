/**
 * 冲突的逐段左右对照视图：左我方、右对方，中间一列放这一段的两侧动作。
 *
 * 冲突的处理粒度是「这一段取哪边」而不是「整个文件取哪边」，因此这里不复用逐行的
 * `DiffFile`：它按 hunk 画同一份文件的两侧，而冲突需要的是按 `<<<<<<< … >>>>>>>`
 * 切开的段落，每段两侧各自独立成块，并在中间给出该段可执行的动作。
 *
 * 普通行（冲突区间之外）两侧共用同一份内容，画成中间没有动作的整行。
 */
import React from 'react';
import { splitConflict } from '../../shared/conflict-sections.ts';
import type { ConflictSection } from '../../shared/conflict-sections.ts';
import css from '../css/conflict-view.module.css';

/** 一个分段动作：取哪一侧。 */
export type SectionSide = 'ours' | 'theirs' | 'both' | 'base' | 'none';

/** 分段动作定义。 */
interface SectionAction {
	readonly side: SectionSide;
	/** 按钮的悬停与无障碍名称。 */
	readonly title: string;
	/** 按钮里的短标记。 */
	readonly mark: string;
}

/** 每一段中间可用的动作，按固定顺序。 */
const SECTION_ACTIONS: readonly SectionAction[] = [
	{ side: 'ours', title: '这一处取我方', mark: '左' },
	{ side: 'theirs', title: '这一处取对方', mark: '右' },
	{ side: 'both', title: '这一处两边都保留', mark: '合' },
	{ side: 'base', title: '这一处取基线', mark: '基' },
	{ side: 'none', title: '这一处两边都不要', mark: '删' },
];

/** 冲突逐段视图的属性。 */
export interface ConflictViewProps {
	/** 工作区文件全文，含冲突标记。 */
	readonly text: string;
	/** 是否自动换行。 */
	readonly wrap: boolean;
	/** 执行一个分段动作；`side` 为取哪一侧。 */
	readonly onResolveSection: (index: number, side: SectionSide) => void;
	/** 把整个文件剩余段落一次性按某一侧处理。 */
	readonly onResolveAll: (side: SectionSide) => void;
	/** 动作进行中：禁用全部按钮。 */
	readonly busy: boolean;
}

/** 一段普通行或一处冲突。 */
type ViewRow =
	| { readonly kind: 'common'; readonly lines: readonly string[] }
	| { readonly kind: 'section'; readonly section: ConflictSection };

/**
 * 把全文拆成可渲染的行。
 *
 * @param text - 工作区全文。
 * @returns 普通段与冲突段，按文件顺序。
 */
export function rowsOf(text: string): ViewRow[] {
	const split = splitConflict(text);
	const rows: ViewRow[] = [];
	for (const common of split.commons) {
		if (common.lines.length > 0) rows.push({ kind: 'common', lines: common.lines });
		if (common.nextSection !== null) {
			const section = split.sections.find((item) => item.index === common.nextSection);
			if (section !== undefined) rows.push({ kind: 'section', section });
		}
	}
	return rows;
}

/**
 * 一列多行内容的行号列与正文。
 *
 * @param props - 行内容与起始行号。
 * @returns 该列元素。
 */
function SideLines({ lines, from }: { readonly lines: readonly string[]; readonly from: number }): React.ReactElement {
	return React.createElement(
		'div',
		{ className: css.sideLines },
		...lines.map((line, offset) => React.createElement(
			'div',
			{ key: offset, className: css.sideLine },
			React.createElement('span', { className: css.lineNo }, String(from + offset)),
			React.createElement('span', { className: css.lineText }, line === '' ? '\u00a0' : line),
		)),
	);
}

/**
 * 冲突的逐段左右对照视图。
 *
 * @param props - 见 {@link ConflictViewProps}。
 * @returns 视图元素。
 */
export function ConflictView({ text, wrap, onResolveSection, onResolveAll, busy }: ConflictViewProps): React.ReactElement {
	const rows = React.useMemo(() => rowsOf(text), [text]);
	const hasSections = rows.some((row) => row.kind === 'section');
	if (!hasSections) {
		// 标记已被解决干净：只把整份内容画成一列。
		return React.createElement(
			'div',
			{ className: css.conflictView, 'data-sc-conflict-view': '' },
			React.createElement('div', { className: css.noSections }, '该文件已没有冲突标记。'),
		);
	}
	let line = 1;
	return React.createElement(
		'div',
		{ className: css.conflictView, 'data-sc-conflict-view': '', 'data-wrap': wrap ? '' : undefined },
		React.createElement(
			'div',
			{ className: css.conflictToolbar },
			React.createElement('span', { className: css.toolbarHint }, '逐段选择要保留的内容；全部处理完后提交即可结束合并。'),
			React.createElement('span', { className: css.toolbarSpacer }),
			...(['ours', 'theirs'] as const).map((side) => React.createElement('button', {
				key: side, type: 'button', className: css.toolbarButton, disabled: busy,
				onClick: () => { onResolveAll(side); },
			}, side === 'ours' ? '全部取我方' : '全部取对方')),
		),
		React.createElement(
			'div',
			{ className: css.columns },
			React.createElement('div', { className: css.head }, '我方'),
			React.createElement('div', { className: css.head, 'data-side': 'actions' }, '这一处'),
			React.createElement('div', { className: css.head }, '对方'),
			...rows.map((row, index) => {
				if (row.kind === 'common') {
					const from = line;
					line += row.lines.length;
					return React.createElement(
						'div',
						{ key: `c${index}`, className: css.commonRow, 'data-sc-common': '' },
						React.createElement('div', { className: css.commonCell },
							React.createElement(SideLines, { lines: row.lines, from })),
					);
				}
				const section = row.section;
				const start = line;
				line += section.ours.lines.length + section.theirs.lines.length + 4;
				return React.createElement(
					'div',
					{ key: `s${section.index}`, className: css.sectionRow, 'data-sc-section': section.index },
					React.createElement('div', { className: css.sideCell },
						React.createElement(SideLines, { lines: section.ours.lines, from: start + 1 })),
					React.createElement(
						'div',
						{ className: css.actions },
						...SECTION_ACTIONS.map((action) => React.createElement('button', {
							key: action.side, type: 'button', className: css.actionButton,
							title: action.title, 'aria-label': action.title, disabled: busy,
							'data-sc-section-action': action.side, 'data-index': section.index,
							onClick: () => { onResolveSection(section.index, action.side); },
						}, action.mark)),
					),
					React.createElement('div', { className: css.sideCell },
						React.createElement(SideLines, { lines: section.theirs.lines, from: start + 1 })),
				);
			}),
		),
	);
}
