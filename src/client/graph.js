/**
 * 提交图：左侧泳道 SVG + 右侧提交行。
 *
 * 泳道由 lanes.js 纯函数算出，这里只负责画；每一行是独立的 DOM 行，
 * 因此不必像移植版那样用一个整体 SVG 覆盖所有行。
 *
 * 行内排布：泳道 | 提交信息与作者（同一段可截断文本）| 引用标记（右对齐）。
 * 当前分支与本地分支是「图标 + 名称」的药丸，远端、标签、贮藏是圆形图标，
 * 名称经 title 与右键菜单给出。节点形状区分提交种类：当前分支为空心环，
 * 合并提交为环加内点，其余为实心点。
 */
import React from 'react';
import {
	HoverCard, IconArchiveOutlineRegular, IconBranchOutlineRegular, IconClockOutlineRegular,
	IconCopyOutlineRegular, IconGoalOutlineRegular, IconUserOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
	HEAD_NODE_RADIUS, LANE_STROKE, LANE_WIDTH, MERGE_CORE_RADIUS, MERGE_NODE_RADIUS, NODE_RADIUS,
	RING_STROKE, ROW_HEIGHT, laneCentre, laneColour, layoutCommits, nodeOuterRadius, segmentGeometry,
} from './lanes.js';
import { RemoteRefIcon, TagRefIcon } from './ref-icons.js';
import { copyText } from './context-menu.js';

/**
 * 画一行的泳道线与节点。
 *
 * 几何由 lanes.js 的 segmentGeometry 给出（纯函数，可单测），这里只做元素拼装；
 * 线段按本行节点的外沿断开，节点内部不画线。列宽取本行实际用到的泳道数，
 * 提交信息因此紧贴本行泳道；泳道横向位置由 LANE_WIDTH 决定，逐行对齐。
 *
 * @param props.row - 该行的布局。
 * @param props.isHead - 是否是当前分支指向的提交。
 * @param props.isMerge - 是否是合并提交（两个以上父提交）。
 * @returns SVG 元素。
 */
function LaneCell({ row, isHead, isMerge }) {
	const width = row.width * LANE_WIDTH;
	const half = ROW_HEIGHT / 2;
	const colour = laneColour(row.colour);
	const cx = laneCentre(row.lane);
	const nodeKind = isHead ? 'head' : isMerge ? 'merge' : 'plain';
	const node = { x: cx, radius: nodeOuterRadius(nodeKind) };
	const segments = (row.segments ?? []).flatMap((segment, index) => {
		const geometry = segmentGeometry(segment, node);
		if (geometry === null) return [];
		const stroke = laneColour(segment.colour);
		const common = { stroke, strokeWidth: LANE_STROKE };
		if (geometry.kind === 'path') {
			return [React.createElement('path', { key: `c${index}`, d: geometry.d, fill: 'none', ...common })];
		}
		if (geometry.kind === 'gap') {
			return [
				React.createElement('line', { key: `u${index}`, ...geometry.upper, ...common }),
				React.createElement('line', { key: `l${index}`, ...geometry.lower, ...common }),
			];
		}
		if (geometry.kind === 'bend') {
			return [
				React.createElement('line', { key: `h${index}`, ...geometry.horizontal, ...common }),
				React.createElement('line', { key: `v${index}`, ...geometry.vertical, ...common }),
			];
		}
		return [React.createElement('line', { key: `s${index}`, x1: geometry.x1, y1: geometry.y1, x2: geometry.x2, y2: geometry.y2, ...common })];
	});
	const ring = (radius) => React.createElement('circle', {
		key: 'ring', cx, cy: half, r: radius, fill: 'none', stroke: colour, strokeWidth: RING_STROKE,
	});
	const nodes = isHead
		? [ring(HEAD_NODE_RADIUS)]
		: isMerge
			? [
				ring(MERGE_NODE_RADIUS),
				React.createElement('circle', { key: 'core', cx, cy: half, r: MERGE_CORE_RADIUS, fill: colour }),
			]
			: [React.createElement('circle', { key: 'dot', cx, cy: half, r: NODE_RADIUS, fill: colour })];
	return React.createElement(
		'svg',
		{ className: 'ggg-lane', width, height: ROW_HEIGHT, viewBox: `0 0 ${width} ${ROW_HEIGHT}`, 'aria-hidden': 'true' },
		...segments,
		...nodes,
	);
}

/**
 * 取提交的引用标记，并附上用于右键识别的类型与名称。
 *
 * @param commit - 提交。
 * @param head - 当前 HEAD 指向的分支。
 * @returns 标记列表：{ key, kind, text, title, refType, refName }。
 */
function refLabels(commit, head) {
	const labels = [];
	for (const name of commit.heads ?? []) {
		const isHead = head !== null && name === head;
		labels.push({
			key: `h:${name}`,
			kind: isHead ? 'head' : 'branch',
			text: name,
			title: isHead ? `当前分支 ${name}` : `分支 ${name}`,
			refType: 'head',
			refName: name,
		});
	}
	for (const remote of commit.remotes ?? []) {
		labels.push({
			key: `r:${remote.name}`, kind: 'remote', text: remote.name,
			title: `远程分支 ${remote.name}`, refType: 'remote', refName: remote.name,
		});
	}
	for (const tag of commit.tags ?? []) {
		labels.push({
			key: `t:${tag.name}`, kind: 'tag', text: tag.name,
			title: `标签 ${tag.name}`, refType: 'tag', refName: tag.name,
		});
	}
	if (commit.stash !== null && commit.stash !== undefined) {
		const selector = commit.stash.selector ?? 'stash';
		labels.push({
			key: 'stash', kind: 'stash', text: selector,
			title: `贮藏 ${selector}`, refType: 'stash', refName: selector,
		});
	}
	return labels;
}

/** 圆形标记的图标：只有图标、名称进 title 的种类。 */
const ROUND_KINDS = new Set(['remote', 'tag', 'stash']);

/**
 * 画一个引用标记。
 *
 * @param props.label - refLabels 给出的标记。
 * @param props.expanded - 是否展开为「图标 + 名称」药丸；默认只有分支带名称。
 * @returns 标记元素。
 */
function RefChip({ label, expanded = false }) {
	const icon = label.kind === 'remote'
		? React.createElement(RemoteRefIcon)
		: label.kind === 'tag'
			? React.createElement(TagRefIcon)
			: label.kind === 'stash'
				? React.createElement(IconArchiveOutlineRegular, { size: 12 })
				: label.kind === 'head'
					? React.createElement(IconGoalOutlineRegular, { size: 12 })
					: React.createElement(IconBranchOutlineRegular, { size: 12 });
	const named = expanded || !ROUND_KINDS.has(label.kind);
	return React.createElement(
		'span',
		{
			className: `ggg-ref ggg-ref-${label.kind}${named && ROUND_KINDS.has(label.kind) ? ' ggg-ref-wide' : ''}`,
			title: label.title,
			'data-ref-type': label.refType,
			'data-ref-name': label.refName,
			// 圆形标记只有图标，名称经 aria-label 与 title 给出。
			...(named ? {} : { role: 'img', 'aria-label': label.title }),
		},
		icon,
		named ? React.createElement('span', { className: 'ggg-ref-text' }, label.text) : null,
	);
}

/**
 * 悬停卡片的正文：作者与时间、完整提交信息、改动统计、引用标记、短哈希。
 *
 * @param props.commit - 提交。
 * @param props.labels - refLabels 给出的引用标记。
 * @param props.stats - 改动统计 { files, additions, deletions }，未知时为 null。
 * @param props.formatDate - 日期格式化函数（unixSeconds -> 文本），沿用设置里的格式。
 * @param props.formatDetail - 详细时间格式化函数（unixSeconds -> 日期与时间）。
 * @returns 卡片正文元素。
 */
function CommitCard({ commit, labels, stats, formatDate, formatDetail }) {
	const isUncommitted = commit.hash === '*';
	const dated = typeof commit.date === 'number' && Number.isFinite(commit.date);
	// 主标签按设置里的格式；括号内补详细时间，主标签已是详细时间时不重复。
	const timeText = dated ? formatDate(commit.date) : '';
	const detail = dated ? formatDetail(commit.date) : '';
	const timeLabel = detail === '' || detail === timeText ? timeText : `${timeText}（${detail}）`;
	const lines = String(commit.message ?? '').split('\n');
	return React.createElement(
		'div',
		{ className: 'ggg-card' },
		React.createElement(
			'div',
			{ className: 'ggg-card-head' },
			React.createElement(IconUserOutlineRegular, { size: 13, className: 'ggg-card-icon' }),
			React.createElement('span', { className: 'ggg-card-author' }, commit.author ?? ''),
			dated && React.createElement(IconClockOutlineRegular, { size: 13, className: 'ggg-card-icon' }),
			dated && React.createElement('span', { className: 'ggg-card-time' }, timeLabel),
		),
		React.createElement(
			'div',
			{ className: 'ggg-card-message' },
			...lines.map((line, index) => React.createElement(
				'div',
				{ key: `line-${index}`, className: 'ggg-card-line' },
				line === '' ? '\u00a0' : line,
			)),
		),
		stats !== null && stats !== undefined && React.createElement(
			'div',
			{ className: 'ggg-card-stats' },
			`已更改 ${stats.files} 个文件，${stats.additions} 行插入(+)，${stats.deletions} 行删除(-)`,
		),
		labels.length > 0 && React.createElement(
			'div',
			{ className: 'ggg-card-refs' },
			...labels.map((label) => React.createElement(RefChip, { key: label.key, label, expanded: true })),
		),
		!isUncommitted && React.createElement(
			'div',
			{ className: 'ggg-card-hash' },
			React.createElement('span', { className: 'ggg-card-hash-text' }, commit.hash.slice(0, 7)),
			React.createElement('button', {
				type: 'button',
				className: 'ggg-card-copy',
				title: '复制完整哈希',
				'aria-label': '复制完整哈希',
				onClick: () => { void copyText(commit.hash); },
			}, React.createElement(IconCopyOutlineRegular, { size: 13 })),
		),
	);
}

/**
 * 把提交信息中的 Issue 编号替换成链接。
 *
 * @param message - 提交信息。
 * @param issueLinking - { issueRegex, issueUrlTemplate }。
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
 * @param props.head - 当前分支。
 * @param props.selected - 是否选中。
 * @param props.onSelect - 选中回调。
 * @param props.onContextMenu - 右键回调：({ commit, refInfo, event })。
 * @param props.formatDate - 日期格式化函数（unixSeconds -> 文本）。
 * @param props.formatDetail - 详细时间格式化函数（unixSeconds -> 日期与时间）。
 * @param props.issueLinking - Issue 链接配置，为 null 时不识别。
 * @param props.stats - 该提交的改动统计，未知时为 null。
 * @param props.onHover - 悬停回调：进入传哈希，离开传 null。
 * @param props.widthAnchorRef - 卡片宽度对齐用的图区元素。
 * @returns 行元素。
 */
function CommitRow({
	commit, row, head, selected, onSelect, onContextMenu, formatDate, formatDetail, issueLinking,
	stats, onHover, widthAnchorRef,
}) {
	const isUncommitted = commit.hash === '*';
	const labels = refLabels(commit, head);
	const isHead = !isUncommitted && head !== null && (commit.heads ?? []).includes(head);
	const isMerge = (commit.parents ?? []).length > 1;
	const anchor = React.createElement(
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
			onPointerEnter: () => onHover?.(commit.hash),
			onPointerLeave: () => onHover?.(null),
		},
		React.createElement(LaneCell, { row, isHead, isMerge }),
		React.createElement(
			'span',
			{ className: 'ggg-subject' },
			...renderSubject(commit.message, issueLinking),
			!isUncommitted && React.createElement('span', { className: 'ggg-author' }, commit.author),
		),
		labels.length > 0 && React.createElement(
			'span',
			{ className: 'ggg-refs' },
			...labels.map((label) => React.createElement(RefChip, { key: label.key, label })),
		),
	);
	return React.createElement(HoverCard, {
		anchor,
		content: React.createElement(CommitCard, { commit, labels, stats, formatDate, formatDetail }),
		variant: 'preview',
		widthAnchorRef,
	});
}

/**
 * 展开块左侧的泳道续画：把该行画到行底的线段在展开块高度内继续向下延伸。
 *
 * @param props.row - 该行的布局。
 * @returns SVG 元素；没有向下线段时返回 null。
 */
function DetailGutter({ row }) {
	const width = row.width * LANE_WIDTH;
	const continued = (row.segments ?? []).filter((segment) => segment.toBottom);
	if (width === 0 || continued.length === 0) return null;
	return React.createElement(
		'svg',
		{
			className: 'ggg-detail-gutter', width, viewBox: `0 0 ${width} 100`,
			preserveAspectRatio: 'none', 'aria-hidden': 'true',
		},
		...continued.map((segment, index) => React.createElement('line', {
			key: index,
			x1: laneCentre(segment.toLane), y1: 0,
			x2: laneCentre(segment.toLane), y2: 100,
			stroke: laneColour(segment.colour), strokeWidth: LANE_STROKE,
			vectorEffect: 'non-scaling-stroke',
		})),
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
 * @param props.formatDetail - 详细时间格式化函数。
 * @param props.issueLinking - Issue 链接配置。
 * @param props.commitStats - 提交哈希 -> 改动统计的映射。
 * @param props.onHoverCommit - 悬停回调：进入传哈希，离开传 null。
 * @param props.renderDetail - 选中行的展开内容：({ commit, row }) => 元素或 null。
 * @returns 提交图元素。
 */
export function CommitGraph({
	commits, head, selectedHash, onSelect, onLoadMore, moreCommitsAvailable,
	onContextMenu, formatDate, formatDetail, issueLinking, commitStats, onHoverCommit, renderDetail,
}) {
	const layout = React.useMemo(() => layoutCommits(commits), [commits]);
	const graphRef = React.useRef(null);
	const dateFmt = formatDate ?? ((seconds) => new Date(seconds * 1000).toLocaleString());
	const detailFmt = formatDetail ?? ((seconds) => new Date(seconds * 1000).toLocaleString());
	if (commits.length === 0) {
		return React.createElement('div', { className: 'ggg-empty' }, '这个仓库还没有提交');
	}
	const items = [];
	for (const [index, commit] of commits.entries()) {
		const row = layout.rows[index];
		items.push(React.createElement(CommitRow, {
			key: commit.hash,
			commit,
			row,
			head,
			selected: commit.hash === selectedHash,
			onSelect,
			onContextMenu,
			formatDate: dateFmt,
			formatDetail: detailFmt,
			issueLinking,
			stats: commitStats?.get(commit.hash) ?? null,
			onHover: onHoverCommit,
			widthAnchorRef: graphRef,
		}));
		// 改动文件区是图形区的一部分：展开在该提交行下方。
		const detail = renderDetail?.({ commit, row });
		if (detail !== null && detail !== undefined) {
			items.push(React.createElement(
				'div',
				{ key: `${commit.hash}:detail`, className: 'ggg-detail-inline' },
				React.createElement(DetailGutter, { row }),
				React.createElement('div', { className: 'ggg-detail-body' }, detail),
			));
		}
	}
	return React.createElement(
		'div',
		{ className: 'ggg-graph', ref: graphRef },
		...items,
		moreCommitsAvailable && React.createElement(
			'div',
			{ className: 'ggg-pager' },
			React.createElement('button', { type: 'button', className: 'ggg-bar-item', onClick: onLoadMore }, '加载更多提交'),
		),
	);
}
