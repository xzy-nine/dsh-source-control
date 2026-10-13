/**
 * 提交图：左侧泳道 SVG + 右侧提交行。
 *
 * 泳道由 lanes.js 纯函数算出，这里只负责画；每一行是独立的 DOM 行。
 *
 * 行内排布：泳道 | 提交信息与作者（同一段可截断文本）| 引用标记（右对齐）。
 * 当前分支与本地分支是「图标 + 名称」的药丸，远端、标签、贮藏是圆形图标，
 * 名称经 title 与右键菜单给出。节点形状区分提交种类：当前分支为空心环，
 * 合并提交为环加内点，其余为实心点。
 */
import React from 'react';
import {
	HoverCard, IconArchiveOutlineRegular, IconClockOutlineRegular,
	IconCopyOutlineRegular, IconGoalOutlineRegular, IconUserOutlineRegular,
	MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
	HEAD_CORE_RADIUS, HEAD_NODE_RADIUS, INDICATOR_DASH, INDICATOR_NODE_RADIUS, INDICATOR_RING_RADIUS,
	LANE_STROKE, MERGE_CORE_RADIUS, MERGE_NODE_RADIUS, NODE_RADIUS,
	REMOTE_REF_COLOUR, RING_STROKE, ROW_HEIGHT, ROW_OVERLAP, HEAD_REF_COLOUR,
	laneCentre, laneSpanWidth, layoutCommits, nodeOuterRadius, segmentGeometry,
} from './lanes.ts';
import { RemoteRefIcon, TagRefIcon } from './ref-icons.ts';
import { GitGraphIcon } from './plugin-icon.ts';
import { copyText } from './context-menu.ts';

/** MarkdownText 所需的本地化标签。 */
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

/** 距底部不足该像素数时自动取下一页。 */
const AUTO_LOAD_THRESHOLD = 120;

/** 取下一页后等待新数据的上限；超时未到则解除占用，允许重试。 */
const LOAD_MORE_SETTLE_MS = 10000;

/**
 * 计算字符串的 MD5 哈希（用于 Gravatar 头像 URL）。
 *
 * 紧凑实现：处理 UTF-8 字节，输出十六进制摘要。
 *
 * @param {string} input - 输入字符串。
 * @returns {string} 十六进制 MD5 摘要。
 */
function md5(input) {
	const bytes = new TextEncoder().encode(input);
	const len = bytes.length;
	const paddedLen = (Math.floor((len + 8) / 64) + 1) * 64;
	const ab = new Uint8Array(paddedLen);
	ab.set(bytes);
	ab[len] = 0x80;
	const bitLen = len * 8;
	const view = new DataView(ab.buffer);
	view.setUint32(paddedLen - 8, bitLen >>> 0, true);
	view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);
	const s = new Uint32Array([7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]);
	const K = new Uint32Array([0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8f1bbcdc, 0x6d6a3e8, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391]);
	let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
	for (let off = 0; off < ab.length; off += 64) {
		const M = new Uint32Array(16);
		for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
		let A = a0, B = b0, C = c0, D = d0;
		for (let i = 0; i < 64; i++) {
			let F, g;
			if (i < 16) { F = (B & C) | (~B & D); g = i; }
			else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
			else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
			else { F = C ^ (B | ~D); g = (7 * i) % 16; }
			F = (F + A + K[i] + M[g]) >>> 0;
			A = D; D = C; C = B;
			B = (B + ((F << s[i % 16]) | (F >>> (32 - s[i % 16])))) >>> 0;
		}
		a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
	}
	const hex = (n) => Array.from({ length: 4 }, (_, i) => ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')).join('');
	return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/**
 * 构造 Gravatar 头像 URL。
 *
 * @param {string} email - 作者邮箱。
 * @param {number} size - 请求的图片像素边长。
 * @returns {string|null} Gravatar URL，无邮箱时返回 null。
 */
function avatarUrl(email, size = 40) {
	if (typeof email !== 'string' || email === '') return null;
	const hash = md5(email.trim().toLowerCase());
	return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`;
}

/**
 * 画一行的泳道线与节点。
 *
 * 几何由 lanes.js 的 segmentGeometry 给出（纯函数，可单测），这里只做元素拼装；
 * 线段按本行节点的外沿断开，节点内部不画线。列宽取本行实际用到的泳道数，
 * 提交信息因此紧贴本行泳道；泳道横向位置由 LANE_WIDTH 决定，逐行对齐。
 *
 * @param props.row - 该行的布局；`row.indicator` 给出领先/落后指示节点。
 * @param props.isHead - 是否是当前分支指向的提交。
 * @param props.isMerge - 是否是合并提交（两个以上父提交）。
 * @param props.isUncommitted - 是否是工作区未提交行。
 * @returns SVG 元素。
 */
function LaneCell({ row, isHead, isMerge, isUncommitted }) {
	const width = laneSpanWidth(row.width);
	const half = ROW_HEIGHT / 2;
	const colour = row.colour;
	const cx = laneCentre(row.lane);
	const indicator = row.indicator;
	const nodeKind = indicator ?? (isHead ? 'head' : isMerge ? 'merge' : 'plain');
	// 未提交行没有对应提交：不画节点，线因此贯穿整行（不留断口）。
	const node = isUncommitted ? null : { x: cx, radius: nodeOuterRadius(nodeKind) };
	const segments = (row.segments ?? []).flatMap((segment, index) => {
		// 未提交行不画节点，其出线因此从行顶起画、贯穿整行，不留节点处的断口。
		const shaped = isUncommitted && !segment.fromTop ? { ...segment, fromTop: true } : segment;
		const geometry = segmentGeometry(shaped, node);
		if (geometry === null) return [];
		const stroke = segment.colour;
		// 未提交行的线用虚线，与真实提交区分。
		const common = { stroke, strokeWidth: LANE_STROKE, strokeLinecap: 'round', ...(isUncommitted ? { strokeDasharray: '2 2' } : {}) };
		if (geometry.kind === 'path') {
			return [React.createElement('path', { key: `c${index}`, d: geometry.d, fill: 'none', ...common })];
		}
		if (geometry.kind === 'gap') {
			return [
				React.createElement('line', { key: `u${index}`, ...geometry.upper, ...common }),
				React.createElement('line', { key: `l${index}`, ...geometry.lower, ...common }),
			];
		}
		return [React.createElement('line', { key: `s${index}`, x1: geometry.x1, y1: geometry.y1, x2: geometry.x2, y2: geometry.y2, ...common })];
	});
	const ring = (radius, key) => React.createElement('circle', {
		key, cx, cy: half, r: radius, fill: 'none', stroke: colour, strokeWidth: RING_STROKE,
	});
	// 领先/落后指示：外圈实心 + 中圈透明 + 内圈虚线，虚线表示尚未同步。
	const indicatorNodes = (nodeColour) => [
		React.createElement('circle', { key: 'outer', cx, cy: half, r: INDICATOR_NODE_RADIUS, fill: nodeColour }),
		React.createElement('circle', { key: 'mid', cx, cy: half, r: INDICATOR_RING_RADIUS, fill: 'none' }),
		React.createElement('circle', {
			key: 'inner', cx, cy: half, r: INDICATOR_RING_RADIUS, fill: 'none',
			stroke: nodeColour, strokeWidth: RING_STROKE, strokeDasharray: INDICATOR_DASH,
		}),
	];
	const nodes = isUncommitted
		// 未提交行：节点位置用一段竖线占位（线由 segments 画到节点中心），不画节点。
		? []
		: indicator === 'incoming'
			? indicatorNodes(REMOTE_REF_COLOUR)
			: indicator === 'outgoing'
				? indicatorNodes(HEAD_REF_COLOUR)
				: isHead
					? [ring(HEAD_NODE_RADIUS, 'ring'), ring(HEAD_CORE_RADIUS, 'core')]
					: isMerge
						? [
							ring(MERGE_NODE_RADIUS, 'ring'),
							React.createElement('circle', { key: 'core', cx, cy: half, r: MERGE_CORE_RADIUS, fill: colour }),
						]
						: [React.createElement('circle', { key: 'dot', cx, cy: half, r: NODE_RADIUS, fill: colour })];
	return React.createElement(
		'svg',
		{
			className: 'ggg-lane', width, height: ROW_HEIGHT,
			viewBox: `0 0 ${width} ${ROW_HEIGHT}`,
			// 线段在行顶与行底各越界 ROW_OVERLAP，必须允许溢出，否则越界部分被裁掉、接缝仍在。
			overflow: 'visible', 'aria-hidden': 'true',
		},
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
function refLabels(commit, head, combineLocalAndRemote) {
	const labels = [];
	const localNames = new Set(commit.heads ?? []);
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
		if (combineLocalAndRemote) {
			const short = remote.name.replace(/^[^/]+\//, '');
			if (localNames.has(short)) continue;
		}
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
					: React.createElement(GitGraphIcon, { size: 12 });
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

/** 未提交伪提交的 message 形如 `Uncommitted Changes (2)`；数据层给出英文，这里译成中文。 */
const UNCOMMITTED_MESSAGE = /^Uncommitted Changes(?: \((\d+)\))?$/;

/**
 * 取一行显示的提交信息：未提交伪提交的英文文案译成中文。
 *
 * @param commit - 提交。
 * @returns 显示用文本。
 */
function displayMessage(commit) {
	const message = String(commit.message ?? '');
	if (commit.hash !== '*') return message;
	const match = UNCOMMITTED_MESSAGE.exec(message);
	if (match === null) return message;
	return match[1] === undefined ? '未提交的更改' : `未提交的更改（${match[1]}）`;
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
function CommitCard({ commit, labels, stats, formatDate, formatDetail, markdown, showAvatars, message }) {
	const isUncommitted = commit.hash === '*';
	const dated = typeof commit.date === 'number' && Number.isFinite(commit.date);
	const timeText = dated ? formatDate(commit.date) : '';
	const detail = dated ? formatDetail(commit.date) : '';
	const timeLabel = detail === '' || detail === timeText ? timeText : `${timeText}（${detail}）`;
	// 完整提交信息优先：列表里的 message 来自 `%s`，只有标题一行。
	const fullMessage = typeof message === 'string' && message !== '' ? message : String(commit.message ?? '');
	// 首行是标题，保持卡片自身字号；其余是正文，字号更小、行距更紧，且不留空行。
	const [titleLine, ...bodyLines] = fullMessage.split('\n');
	const body = bodyLines.filter((line) => line.trim() !== '');
	const avatar = showAvatars && !isUncommitted ? avatarUrl(commit.email ?? commit.author, 40) : null;
	const avatarEl = avatar !== null
		? React.createElement('img', { className: 'ggg-card-avatar', src: avatar, alt: '', width: 20, height: 20, loading: 'lazy' })
		: React.createElement(IconUserOutlineRegular, { size: 13, className: 'ggg-card-icon' });
	return React.createElement(
		'div',
		{ className: 'ggg-card' },
		React.createElement(
			'div',
			{ className: 'ggg-card-head' },
			avatarEl,
			React.createElement('span', { className: 'ggg-card-author' }, commit.author ?? ''),
			dated && React.createElement(IconClockOutlineRegular, { size: 13, className: 'ggg-card-icon' }),
			dated && React.createElement('span', { className: 'ggg-card-time' }, timeLabel),
		),
		React.createElement(
			'div',
			{ className: 'ggg-card-message' },
			// 标题：首行，保持卡片自身字号。
			React.createElement('div', { className: 'ggg-card-title' }, titleLine === '' ? '\u00a0' : titleLine),
			// 正文：其余各行，字号更小、行距更紧。
			body.length > 0 && (markdown
				// compact 变体把段落间距从 16px 收到 4px，适合卡片这种小空间。
				? React.createElement('div', { className: 'ggg-card-body' },
					React.createElement(MarkdownText, { text: body.join('\n'), labels: MD_LABELS, variant: 'compact' }))
				: React.createElement('div', { className: 'ggg-card-body' },
					...body.map((line, index) => React.createElement('div', { key: `line-${index}`, className: 'ggg-card-line' }, line)))),
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
 * @param props.isRemote - 是否用远程色标出：云端独有，或本地领先时已同步到云端的部分。
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
	markdown, showAvatars, muteMergeCommits, combineLocalAndRemoteBranchLabels,
	stats, message, onHover, widthAnchorRef,
}) {
	const isUncommitted = commit.hash === '*';
	// 贮藏标记行不是提交：与它的引用标记同源，右键走引用菜单，也不显示提交浮动卡片。
	const stashSelector = commit.stash?.selector ?? null;
	const labels = refLabels(commit, head, combineLocalAndRemoteBranchLabels);
	const isHead = !isUncommitted && head !== null && (commit.heads ?? []).includes(head);
	const isMerge = (commit.parents ?? []).length > 1;
	const isMuted = muteMergeCommits && isMerge && !isHead;
	const anchor = React.createElement(
		'div',
		{
			className: `ggg-row${selected ? ' is-selected' : ''}${isUncommitted ? ' ggg-row-uncommitted' : ''}${isMuted ? ' ggg-row-muted' : ''}`,
			'data-hash': commit.hash,
			// Ctrl/Cmd 点击进入与已展开提交的对比；普通点击展开自身详情。
			onClick: (event: React.MouseEvent<HTMLDivElement>) => onSelect(commit.hash, event.ctrlKey || event.metaKey),
			// 未提交行不对应真实提交：不给右键菜单，也不触发悬停卡片。
			onContextMenu: isUncommitted ? undefined : (event: React.MouseEvent<HTMLDivElement>) => {
				event.preventDefault();
				const target = event.target as HTMLElement;
				const refElement = target.closest('[data-ref-type]');
				// 点在引用标记上取该标记；点在贮藏行的其他位置时等价于它的贮藏标记。
				const refInfo = refElement !== null && refElement !== undefined
					? { type: refElement.getAttribute('data-ref-type'), name: refElement.getAttribute('data-ref-name') }
					: (stashSelector === null ? null : { type: 'stash', name: stashSelector });
				onContextMenu?.({ commit, refInfo, event });
			},
			// 贮藏行与未提交行没有浮动卡片，不必预取统计与完整信息。
			onPointerEnter: () => { if (!isUncommitted && stashSelector === null) onHover?.(commit.hash); },
			onPointerLeave: () => { if (!isUncommitted && stashSelector === null) onHover?.(null); },
		},
		React.createElement(LaneCell, { row, isHead, isMerge, isUncommitted }),
		React.createElement(
			'span',
			{ className: 'ggg-subject' },
			...renderSubject(displayMessage(commit), issueLinking),
			!isUncommitted && React.createElement('span', { className: 'ggg-author' }, commit.author),
		),
		labels.length > 0 && React.createElement(
			'span',
			{ className: 'ggg-refs' },
			...labels.map((label) => React.createElement(RefChip, { key: label.key, label })),
		),
	);
	// 未提交行没有可展示的提交信息，直接用行本身，不套悬停卡片。
	// 贮藏行同理：它不是提交，不显示提交浮动卡片。
	if (isUncommitted || stashSelector !== null) return anchor;
	return React.createElement(HoverCard, {
		anchor,
		content: React.createElement(CommitCard, { commit, labels, stats, message, formatDate, formatDetail, markdown, showAvatars }),
		variant: 'preview',
		widthAnchorRef,
	});
}

/**
 * 领先/落后指示行：虚拟行，没有对应提交。
 *
 * @param props.row - 该行的布局。
 * @param props.indicator - 'incoming' 云端领先、'outgoing' 本地领先。
 * @returns 行元素。
 */
function IndicatorRow({ row, indicator }) {
	return React.createElement(
		'div',
		{ className: 'ggg-row ggg-row-indicator' },
		React.createElement(LaneCell, { row, isUncommitted: false, isHead: false, isMerge: false }),
		React.createElement('span', { className: 'ggg-subject ggg-indicator-label' },
			indicator === 'incoming' ? '云端领先' : '本地领先'),
	);
}

/**
 * 展开块左侧的泳道续画：把该行画到行底的线段在展开块高度内继续向下延伸。
 *
 * @param props.row - 该行的布局。
 * @returns SVG 元素；没有向下线段时返回 null。
 */
function DetailGutter({ row }) {
	const width = laneSpanWidth(row.width);
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
			stroke: segment.colour, strokeWidth: LANE_STROKE,
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
 * @param props.onSelect - 选中回调；第二参数为是否按住 Ctrl/Cmd（请求对比）。
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
	onContextMenu, formatDate, formatDetail, issueLinking, commitStats, commitMessages, onHoverCommit, renderDetail,
	localTip, remoteTip, upstream,
	markdown, showAvatars, muteMergeCommits, combineLocalAndRemoteBranchLabels, graphColours,
}) {
	const layout = React.useMemo(
		() => layoutCommits(commits, { head, upstream, localTip, remoteTip }),
		[commits, head, upstream, localTip, remoteTip],
	);
	const graphRef = React.useRef(null);
	/** 一次加载完成前不重复请求下一页。 */
	const loadPendingRef = React.useRef(false);
	/** 兜底解除占用的定时器：失败时提交列表不变，靠它恢复可重试。 */
	const settleTimerRef = React.useRef(null);
	/** 上次请求时的提交列表：引用变化说明确实取回了新数据。 */
	const requestedForRef = React.useRef(commits);
	const [loadingMore, setLoadingMore] = React.useState(false);
	// 回调与标志经 ref 读取：调用方每次渲染都会传新的函数，直接进依赖会让下方 effect 每帧重跑。
	const moreRef = React.useRef(moreCommitsAvailable);
	moreRef.current = moreCommitsAvailable;
	const onLoadMoreRef = React.useRef(onLoadMore);
	onLoadMoreRef.current = onLoadMore;
	const dateFmt = formatDate ?? ((seconds) => new Date(seconds * 1000).toLocaleString());
	const detailFmt = formatDetail ?? ((seconds) => new Date(seconds * 1000).toLocaleString());

	/** 解除占用，允许下一次滚动再取。 */
	const releasePending = React.useCallback(() => {
		if (settleTimerRef.current !== null) {
			clearTimeout(settleTimerRef.current);
			settleTimerRef.current = null;
		}
		loadPendingRef.current = false;
		setLoadingMore(false);
	}, []);

	/** 滚动到距底部 AUTO_LOAD_THRESHOLD 以内时取下一页。 */
	const maybeLoadMore = React.useCallback(() => {
		const element = graphRef.current;
		if (element === null || !moreRef.current || loadPendingRef.current) return;
		const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
		if (remaining > AUTO_LOAD_THRESHOLD) return;
		loadPendingRef.current = true;
		setLoadingMore(true);
		// 失败时提交列表不变，超时兜底解除，避免一次失败后自动加载永久停摆。
		settleTimerRef.current = setTimeout(releasePending, LOAD_MORE_SETTLE_MS);
		onLoadMoreRef.current();
	}, [releasePending]);

	// 取回新数据后解除占用，并补取：内容仍未填满容器时继续取下一页。
	React.useEffect(() => {
		if (commits === requestedForRef.current) return;
		requestedForRef.current = commits;
		releasePending();
		maybeLoadMore();
	}, [commits, releasePending, maybeLoadMore]);

	React.useEffect(() => () => { if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current); }, []);

	if (commits.length === 0) {
		return React.createElement('div', { className: 'ggg-empty' }, '这个仓库还没有提交');
	}
	const commitByHash = new Map();
	for (const commit of commits) commitByHash.set(commit.hash, commit);
	const items = [];
	for (const [index, row] of layout.rows.entries()) {
		// 领先/落后为虚拟行：没有对应提交，只画指示节点。
		if (row.indicator !== undefined) {
			items.push(React.createElement(IndicatorRow, { key: `indicator:${index}`, row, indicator: row.indicator }));
			continue;
		}
		const commit = commitByHash.get(row.hash);
		if (commit === undefined) continue;
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
			markdown,
			showAvatars,
			muteMergeCommits,
			combineLocalAndRemoteBranchLabels,
			stats: commitStats?.get(commit.hash) ?? null,
			message: commitMessages?.get(commit.hash) ?? null,
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
		{ className: 'ggg-graph', ref: graphRef, onScroll: maybeLoadMore },
		...items,
		moreCommitsAvailable && React.createElement(
			'div',
			{ className: 'ggg-pager' },
			loadingMore ? '正在加载更多提交…' : '滚动到底部自动加载更多',
		),
	);
}
