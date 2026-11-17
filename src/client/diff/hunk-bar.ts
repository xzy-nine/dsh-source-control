/**
 * 分段暂存轨道：按补丁块在正文里的位置，把按钮放进左右两栏之间的窄列。
 *
 * forge 的 `DiffFile` 不画 `@@` 块头（它只按行渲染与折叠未变更行），因此块级动作没法
 * 挂在块头行上。这里改为在正文中间让出一条窄列：每个块在自己的改动区间中点给一个方块
 * 加号（暂存）或方块减号（取消暂存），位置由 {@link hunkSlots} 从渲染结果量出。
 *
 * 「全部块」不在这里：它作用于整个文件，因此放在页头增减行数旁边。与 VS Code 的差异
 * 视图一样，逐块按钮平时隐去，指到某一块或轨道本身时才浮现——一屏里常有十几块，常驻
 * 会把中间那条缝变成一排图标。
 */
import React from 'react';
import type { FileHunk } from '../api/merge.ts';
import { markHunkRows, type HunkSlot } from './hunk-lane.ts';
import { AddBlockIcon, RemoveBlockIcon } from '../ui/ref-icons.ts';
import css from '../css/hunk-bar.module.css';

/** 分段暂存轨道的属性。 */
export interface HunkLaneProps {
	/** 当前的补丁块。 */
	readonly hunks: readonly FileHunk[];
	/** 各块在正文里的落位。 */
	readonly slots: readonly HunkSlot[];
	/** 差异正文的滚动容器；指到按钮时用它把对应的改动行高亮出来。 */
	readonly host: Element | null;
	/** 当前作用域是否已暂存：决定按钮是加号还是减号。 */
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
 * 分段暂存轨道。
 *
 * @param props - 见 {@link HunkLaneProps}。
 * @returns 轨道元素；没有块或量不出位置时不渲染。
 */
export function HunkLane({ hunks, slots, host, staged, busy, onApply }: HunkLaneProps): React.ReactElement | null {
	if (hunks.length === 0 || slots.length === 0) return null;
	const verb = staged ? '取消暂存' : '暂存';
	const icon = staged ? React.createElement(RemoveBlockIcon) : React.createElement(AddBlockIcon);
	const byIndex = new Map(hunks.map((hunk) => [hunk.index, hunk]));
	return React.createElement(
		'div',
		{ className: css.lane, 'data-sc-hunk-lane': '', 'data-sc-hunk-staged': staged ? '' : undefined },
		...slots.map((slot) => {
			const hunk = byIndex.get(slot.index);
			if (hunk === undefined) return null;
			return React.createElement(
				'div',
				{
					key: slot.index, className: css.slot,
					style: { top: slot.top, height: slot.height },
					'data-sc-hunk-slot': String(slot.index),
				},
				React.createElement('button', {
					type: 'button', className: css.button, disabled: busy,
					title: `${verb}这一块 ${rangeText(hunk)}`,
					'aria-label': `${verb}这一块 ${rangeText(hunk)}`,
					'data-sc-hunk': hunk.index, 'data-sc-hunk-action': staged ? 'unstage' : 'stage',
					onClick: () => { onApply([hunk.index]); },
					// 指到按钮时把它要处理的那几行淡出来，让人确认按钮管的是哪一段。
					onPointerEnter: () => { markHunkRows(host, hunks, hunk.index); },
					onPointerLeave: () => { markHunkRows(host, hunks, null); },
					onFocus: () => { markHunkRows(host, hunks, hunk.index); },
					onBlur: () => { markHunkRows(host, hunks, null); },
				}, icon),
			);
		}),
	);
}
