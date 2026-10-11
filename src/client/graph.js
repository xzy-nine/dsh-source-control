/**
 * 提交图：左侧泳道 SVG + 右侧提交行。
 *
 * 泳道由 lanes.js 纯函数算出，这里只负责画；每一行是独立的 DOM 行，
 * 因此不必像移植版那样用一个整体 SVG 覆盖所有行。
 */
import React from 'react';
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import { laneColour, layoutCommits, LANE_WIDTH, NODE_RADIUS, ROW_HEIGHT } from './lanes.js';

/**
 * 画一行的泳道线。
 *
 * @param props.row - 该行的布局。
 * @param props.laneCount - 全局泳道数，用于固定宽度。
 * @param props.isLast - 是否是最后一行（末行不画向下的线）。
 * @returns SVG 元素。
 */
function LaneCell({ row, laneCount, isLast }) {
	const width = laneCount * LANE_WIDTH;
	const centre = (lane) => lane * LANE_WIDTH + LANE_WIDTH / 2;
	const half = ROW_HEIGHT / 2;
	return React.createElement(
		'svg',
		{ className: 'ggg-lane', width, height: ROW_HEIGHT, viewBox: `0 0 ${width} ${ROW_HEIGHT}`, 'aria-hidden': 'true' },
		// 连线：先横移再向下，画成两段，拐点落在两行之间。
		...(row.segments ?? []).flatMap((segment, index) => {
			const x1 = centre(segment.from.lane);
			const x2 = centre(segment.to.lane);
			const stroke = laneColour(segment.colour);
			const y1 = segment.straight ? 0 : half;
			const parts = [];
			if (segment.straight) {
				if (!isLast) parts.push(React.createElement('line', { key: `s${index}`, x1, y1: 0, x2, y2: ROW_HEIGHT, stroke, strokeWidth: 1.5 }));
			} else {
				parts.push(React.createElement('path', {
					key: `p${index}`,
					d: `M ${x1} ${y1} C ${x1} ${half + 6}, ${x2} ${half - 6}, ${x2} ${ROW_HEIGHT}`,
					fill: 'none', stroke, strokeWidth: 1.5,
				}));
			}
			return parts;
		}),
		// 节点：当前提交。
		React.createElement('circle', {
			cx: centre(row.lane), cy: half, r: NODE_RADIUS,
			fill: laneColour(row.colour), stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 1,
		}),
	);
}

/**
 * 取提交的引用标签。
 *
 * @param commit - 提交。
 * @param head - 当前 HEAD 指向的分支。
 * @returns 标签列表。
 */
function refLabels(commit, head) {
	const labels = [];
	for (const name of commit.heads ?? []) {
		const isHead = head !== null && name === head;
		labels.push({ key: `h:${name}`, text: name, tone: isHead ? 'solid' : 'info' });
	}
	for (const remote of commit.remotes ?? []) {
		labels.push({ key: `r:${remote.name}`, text: remote.name, tone: 'neutral' });
	}
	for (const tag of commit.tags ?? []) {
		labels.push({ key: `t:${tag.name}`, text: tag.name, tone: 'warning' });
	}
	if (commit.stash !== null && commit.stash !== undefined) {
		labels.push({ key: 'stash', text: commit.stash.selector ?? 'stash', tone: 'neutral' });
	}
	return labels;
}

/**
 * 一行提交。
 *
 * @param props.commit - 提交。
 * @param props.row - 布局。
 * @param props.laneCount - 泳道总数。
 * @param props.head - 当前分支。
 * @param props.isLast - 是否最后一行。
 * @param props.selected - 是否选中。
 * @param props.onSelect - 选中回调。
 * @param props.relativeLabel - 相对时间文本。
 * @returns 行元素。
 */
function CommitRow({ commit, row, laneCount, head, isLast, selected, onSelect, relativeLabel }) {
	const isUncommitted = commit.hash === '*';
	const date = new Date(commit.date * 1000);
	const labels = refLabels(commit, head);
	const title = isUncommitted
		? '未提交的变更'
		: `${commit.hash}\n${commit.author} <${commit.email}>\n${date.toLocaleString()}`;
	return React.createElement(
		'div',
		{
			className: `ggg-row${selected ? ' is-selected' : ''}`,
			onClick: () => onSelect(commit.hash),
			title,
		},
		React.createElement(LaneCell, { row, laneCount, isLast }),
		labels.length > 0 && React.createElement(
			'span',
			{ className: 'ggg-refs' },
			...labels.map((label) => React.createElement(Tag, { key: label.key, tone: label.tone }, label.text)),
		),
		React.createElement('span', { className: 'ggg-subject' }, commit.message),
		!isUncommitted && React.createElement('span', { className: 'ggg-meta' }, commit.author),
		!isUncommitted && React.createElement('span', { className: 'ggg-meta' }, relativeLabel),
		React.createElement('span', { className: 'ggg-hash' }, isUncommitted ? '未提交' : commit.hash.slice(0, 7)),
	);
}

/**
 * 提交图主体。
 *
 * @param props.commits - 提交序列。
 * @param props.head - 当前分支。
 * @param props.selectedHash - 选中的提交。
 * @param props.onSelect - 选中回调。
 * @param props.onLoadMore - 加载更多。
 * @param props.moreCommitsAvailable - 是否还有更多提交。
 * @param props.relativeLabel - 相对时间文本生成器。
 * @returns 提交图元素。
 */
export function CommitGraph({ commits, head, selectedHash, onSelect, onLoadMore, moreCommitsAvailable, relativeLabel }) {
	const layout = React.useMemo(() => layoutCommits(commits), [commits]);
	if (commits.length === 0) {
		return React.createElement('div', { className: 'ggg-empty' }, '这个仓库还没有提交');
	}
	return React.createElement(
		'div',
		{ className: 'ggg-graph' },
		...commits.map((commit, index) => React.createElement(CommitRow, {
			key: commit.hash,
			commit,
			row: layout.rows[index],
			laneCount: layout.laneCount,
			head,
			isLast: index === commits.length - 1,
			selected: commit.hash === selectedHash,
			onSelect,
			relativeLabel: relativeLabel(commit.date),
		})),
		moreCommitsAvailable && React.createElement(
			'div',
			{ className: 'ggg-pager' },
			React.createElement('button', { type: 'button', className: 'ggg-bar-item', onClick: onLoadMore }, '加载更多提交'),
		),
	);
}
