/**
 * 分段暂存条：按补丁块列出「暂存 / 取消暂存」，不必整文件进出索引。
 *
 * forge 的 `DiffFile` 不画 `@@` 块头（它只按行渲染与折叠未变更行），因此块级动作
 * 没法挂在块头行上。这里改为在正文上方给一条紧凑的块列表：每项显示块的范围，
 * 并按当前作用域给出「暂存」或「取消暂存」。
 */
import React from 'react';
import type { FileHunk } from '../api/conflict-sections.ts';
import css from '../css/hunk-bar.module.css';

/** 分段暂存条的属性。 */
export interface HunkBarProps {
	/** 当前的补丁块。 */
	readonly hunks: readonly FileHunk[];
	/** 当前作用域是否已暂存：决定按钮是「暂存」还是「取消暂存」。 */
	readonly staged: boolean;
	/** 动作进行中。 */
	readonly busy: boolean;
	/**
	 * 处理某一块。
	 *
	 * @param indexes - 要处理的块下标。
	 */
	readonly onApply: (indexes: readonly number[]) => void;
}

/**
 * 一个块的范围文案。
 *
 * @param hunk - 补丁块。
 * @returns 形如 `-1,5 +1,5` 的范围。
 */
function rangeText(hunk: FileHunk): string {
	return `-${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)}`;
}

/**
 * 分段暂存条。
 *
 * @param props - 见 {@link HunkBarProps}。
 * @returns 条元素；没有块时不渲染。
 */
export function HunkBar({ hunks, staged, busy, onApply }: HunkBarProps): React.ReactElement | null {
	if (hunks.length === 0) return null;
	const verb = staged ? '取消暂存' : '暂存';
	return React.createElement(
		'div',
		{ className: css.bar, 'data-sc-hunk-bar': '' },
		React.createElement('span', { className: css.label }, '分段'),
		...hunks.map((hunk) => React.createElement(
			'span',
			{ key: hunk.index, className: css.item },
			React.createElement('span', { className: css.range }, rangeText(hunk)),
			React.createElement('button', {
				type: 'button', className: css.button, disabled: busy,
				title: `${verb}这一块`, 'aria-label': `${verb}这一块 ${rangeText(hunk)}`,
				'data-sc-hunk': hunk.index, 'data-sc-hunk-action': staged ? 'unstage' : 'stage',
				onClick: () => { onApply([hunk.index]); },
			}, verb),
		)),
		hunks.length > 1 && React.createElement('button', {
			type: 'button', className: css.button, disabled: busy,
			title: `${verb}全部块`, 'aria-label': `${verb}全部块`,
			'data-sc-hunk': 'all', 'data-sc-hunk-action': staged ? 'unstage' : 'stage',
			onClick: () => { onApply([]); },
		}, `${verb}全部`),
	);
}
