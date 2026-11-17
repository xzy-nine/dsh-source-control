/**
 * 分段暂存轨道：按补丁块在正文里的位置，把按钮竖排放进左右两栏之间的窄列。
 *
 * forge 的 `DiffFile` 不画 `@@` 块头（它只按行渲染与折叠未变更行），因此块级动作没法
 * 挂在块头行上。这里改为在正文中间让出一条窄列：每个块在自己的首行旁竖排给出「暂存」
 * 或「取消暂存」，位置由 {@link hunkSlots} 从渲染结果量出。与冲突视图的中间一列同构。
 */
import React from 'react';
import type { FileHunk } from '../api/merge.ts';
import type { HunkSlot } from './hunk-lane.ts';
import css from '../css/hunk-bar.module.css';

/** 分段暂存轨道的属性。 */
export interface HunkLaneProps {
	/** 当前的补丁块。 */
	readonly hunks: readonly FileHunk[];
	/** 各块在正文里的落位。 */
	readonly slots: readonly HunkSlot[];
	/** 当前作用域是否已暂存：决定按钮是「暂存」还是「取消暂存」。 */
	readonly staged: boolean;
	/** 动作进行中。 */
	readonly busy: boolean;
	/**
	 * 处理某一块。
	 *
	 * @param indexes - 要处理的块下标；空数组表示全部块。
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
 * 竖排文字：按钮文本按字换行，宽度压到一个字。
 *
 * @param text - 按钮文本。
 * @returns 文字节点；换行由样式承担，这里只保证每个字都能单独折行。
 */
function stacked(text: string): React.ReactNode {
	return React.createElement('span', { className: css.stacked, 'aria-hidden': 'true' }, text);
}

/**
 * 分段暂存轨道。
 *
 * @param props - 见 {@link HunkLaneProps}。
 * @returns 轨道元素；没有块或量不出位置时不渲染。
 */
export function HunkLane({ hunks, slots, staged, busy, onApply }: HunkLaneProps): React.ReactElement | null {
	if (hunks.length === 0 || slots.length === 0) return null;
	const verb = staged ? '取消暂存' : '暂存';
	const byIndex = new Map(hunks.map((hunk) => [hunk.index, hunk]));
	return React.createElement(
		'div',
		{ className: css.lane, 'data-sc-hunk-lane': '' },
		...slots.map((slot, at) => {
			const hunk = byIndex.get(slot.index);
			if (hunk === undefined) return null;
			return React.createElement(
				'div',
				{
					key: slot.index, className: css.slot,
					style: { top: slot.top, height: slot.height },
					'data-sc-hunk-slot': String(slot.index),
				},
				// 全部块横排在这一列的顶端：文件头占住了轨道的顶边，因此它落在首块的位置上。
				at === 0 && hunks.length > 1 && React.createElement('button', {
					type: 'button', className: `${css.button} ${css.allButton}`, disabled: busy,
					title: `${verb}全部块`, 'aria-label': `${verb}全部块`,
					'data-sc-hunk': 'all', 'data-sc-hunk-action': staged ? 'unstage' : 'stage',
					onClick: () => { onApply([]); },
				}, '全部', stacked(verb)),
				React.createElement('button', {
					type: 'button', className: css.button, disabled: busy,
					title: `${verb}这一块 ${rangeText(hunk)}`,
					'aria-label': `${verb}这一块 ${rangeText(hunk)}`,
					'data-sc-hunk': hunk.index, 'data-sc-hunk-action': staged ? 'unstage' : 'stage',
					onClick: () => { onApply([hunk.index]); },
				}, stacked(verb)),
			);
		}),
	);
}
