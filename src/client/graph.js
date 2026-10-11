/**
 * 提交图：左侧泳道 SVG + 右侧提交行。
 *
 * 泳道由 lanes.js 纯函数算出，这里只负责画；每一行是独立的 DOM 行，
 * 因此不必像移植版那样用一个整体 SVG 覆盖所有行。
 */
import React from 'react';
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import { laneCentre, laneColour, layoutCommits, segmentGeometry, LANE_WIDTH, NODE_RADIUS, ROW_HEIGHT } from './lanes.js';

/**
 * 画一行的泳道线。
 *
 * 几何由 lanes.js 的 segmentGeometry 给出（纯函数，可单测），这里只做元素拼装。
 *
 * @param props.row - 该行的布局。
 * @param props.laneCount - 全局泳道数，用于固定宽度。
 * @param props.isLast - 是否是最后一行（末行不画向下的线）。
 * @returns SVG 元素。
 */
function LaneCell({ row, laneCount, isLast }) {
	const width = laneCount * LANE_WIDTH;
	const half = ROW_HEIGHT / 2;
	return React.createElement(
		'svg',
		{ className: 'ggg-lane', width, height: ROW_HEIGHT, viewBox: `0 0 ${width} ${ROW_HEIGHT}`, 'aria-hidden': 'true' },
		...(row.segments ?? []).flatMap((segment, index) => {
			const geometry = segmentGeometry(segment, isLast);
			if (geometry === null) return [];
			const stroke = laneColour(segment.colour);
			const common = { stroke, strokeWidth: 1.5 };
			if (geometry.kind === 'path') {
				return [React.createElement('path', { key: `c${index}`, d: geometry.d, fill: 'none', ...common })];
			}
			if (geometry.kind === 'bend') {
				return [
					React.createElement('line', { key: `h${index}`, ...geometry.horizontal, ...common }),
					React.createElement('line', { key: `v${index}`, ...geometry.vertical, ...common }),
				];
			}
			return [React.createElement('line', { key: `s${index}`, x1: geometry.x1, y1: geometry.y1, x2: geometry.x2, y2: geometry.y2, ...common })];
		}),
		// 节点：当前提交。
		React.createElement('circle', {
			cx: laneCentre(row.lane), cy: half, r: NODE_RADIUS,
			fill: laneColour(row.colour), stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 1,
		}),
	);
}

/**
 * 取提交的引用标签，并附上用于右键识别的类型与名称。
 *
 * @param commit - 提交。
 * @param head - 当前 HEAD 指向的分支。
 * @returns 标签列表：{ key, text, tone, refType, refName }。
 */
function refLabels(commit, head) {
	const labels = [];
	for (const name of commit.heads ?? []) {
		const isHead = head !== null && name === head;
		labels.push({ key: `h:${name}`, text: name, tone: isHead ? 'solid' : 'info', refType: 'head', refName: name });
	}
	for (const remote of commit.remotes ?? []) {
		labels.push({ key: `r:${remote.name}`, text: remote.name, tone: 'neutral', refType: 'remote', refName: remote.name, remote: remote.remote });
	}
	for (const tag of commit.tags ?? []) {
		labels.push({ key: `t:${tag.name}`, text: tag.name, tone: 'warning', refType: 'tag', refName: tag.name });
	}
	if (commit.stash !== null && commit.stash !== undefined) {
		labels.push({ key: 'stash', text: commit.stash.selector ?? 'stash', tone: 'neutral', refType: 'stash', refName: commit.stash.selector ?? 'stash' });
	}
	return labels;
}

/**
 * 把提交信息中的 Issue 编号替换成链接。
 *
 * @param {string} message - 提交信息。
 * @param {object|null} issueLinking - { issueRegex, issueUrlTemplate }。
 * @returns 行内节点数组。
 */
function renderSubject(message, issueLinking) {
	if (issueLinking === null || issueLinking === undefined) {
		return [message];
	}
	const regexSource = issueLinking.issueRegex;
	const template = issueLinking.issueUrlTemplate;
	if (typeof regexSource !== 'string' || regexSource === '' || typeof template !== 'string' || template === '') {
		return [message];
	}
	let regex;
	try {
		regex = new RegExp(regexSource, 'g');
	} catch {
		return [message];
	}
	const parts = [];
	let last = 0;
	let match;
	let key = 0;
	while ((match = regex.exec(message)) !== null) {
		const id = match[1] ?? match[0];
		const url = template.replace(/%ID%/g, encodeURIComponent(id));
		if (match.index > last) parts.push(message.slice(last, match.index));
		parts.push(React.createElement(
			'a',
			{ key: `issue-${key++}`, className: 'ggg-issue-link', href: url, target: '_blank', rel: 'noreferrer', onClick: (event) => event.stopPropagation() },
			match[0],
		));
		last = match.index + match[0].length;
		if (match.index === regex.lastIndex) regex.lastIndex++;
	}
	if (last < message.length) parts.push(message.slice(last));
	return parts;
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
 * @param props.onContextMenu - 右键回调：({ commit, refInfo, event })。
 * @param props.formatDate - 日期格式化函数（unixSeconds -> 文本）。
 * @param props.issueLinking - Issue 链接配置，为 null 时不识别。
 * @returns 行元素。
 */
function CommitRow({ commit, row, laneCount, head, isLast, selected, onSelect, onContextMenu, formatDate, issueLinking }) {
	const isUncommitted = commit.hash === '*';
	const date = new Date(commit.date * 1000);
	const labels = refLabels(commit, head);
	const title = isUncommitted
		? '未提交的变更'
		: `${commit.hash}\n${commit.author} <${commit.email}>\n${date.toLocaleString()}`;
	return React.createElement(
		'div',
		{
			className: `ggg-row${selected ? ' is-selected' : ''}${isUncommitted ? ' ggg-row-uncommitted' : ''}`,
			onClick: () => onSelect(commit.hash),
			onContextMenu: (event) => {
				event.preventDefault();
				const target = event.target;
				const refElement = target.closest?.('[data-ref-type]');
				const refInfo = refElement !== null && refElement !== undefined
					? { type: refElement.getAttribute('data-ref-type'), name: refElement.getAttribute('data-ref-name') }
					: null;
				onContextMenu?.({ commit, refInfo, event });
			},
			title,
		},
		React.createElement(LaneCell, { row, laneCount, isLast }),
		labels.length > 0 && React.createElement(
			'span',
			{ className: 'ggg-refs' },
			...labels.map((label) => React.createElement(Tag, {
				key: label.key, tone: label.tone,
				'data-ref-type': label.refType, 'data-ref-name': label.refName,
			}, label.text)),
		),
		React.createElement('span', { className: 'ggg-subject' }, ...renderSubject(commit.message, issueLinking)),
		!isUncommitted && React.createElement('span', { className: 'ggg-meta' }, commit.author),
		!isUncommitted && React.createElement('span', { className: 'ggg-meta' }, formatDate(commit.date)),
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
 * @param props.onContextMenu - 右键回调。
 * @param props.formatDate - 日期格式化函数。
 * @param props.issueLinking - Issue 链接配置。
 * @returns 提交图元素。
 */
export function CommitGraph({
	commits, head, selectedHash, onSelect, onLoadMore, moreCommitsAvailable,
	onContextMenu, formatDate, issueLinking,
}) {
	const layout = React.useMemo(() => layoutCommits(commits), [commits]);
	const dateFmt = formatDate ?? ((seconds) => new Date(seconds * 1000).toLocaleString());
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
			onContextMenu,
			formatDate: dateFmt,
			issueLinking,
		})),
		moreCommitsAvailable && React.createElement(
			'div',
			{ className: 'ggg-pager' },
			React.createElement('button', { type: 'button', className: 'ggg-bar-item', onClick: onLoadMore }, '加载更多提交'),
		),
	);
}
