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
import md5 from 'blueimp-md5';
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
import { RemoteRefIcon, TagRefIcon, TranslateIcon } from '../ui/ref-icons.ts';
import { GitGraphIcon } from '../ui/plugin-icon.ts';
import { copyText } from '../ui/context-menu.ts';
import { interfaceLanguage, showTranslateEntry } from '../panel/language.ts';
import css from '../css/graph.module.css';
import shared from '../css/shared.module.css';
import { cx } from '../css/cx.ts';

/** MarkdownText 所需的本地化标签。 */
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

/** 距底部不足该像素数时自动取下一页。 */
const AUTO_LOAD_THRESHOLD = 120;

/** 可视区之外额外渲染的行数：滚动时留出缓冲，避免边缘出现空白。 */
const OVERSCAN_ROWS = 12;

/**
 * 滚动停止判定的静默时长。
 *
 * 悬浮卡片的改动统计与完整提交信息按哈希单独取回，滚动期间行在变、取了也多半用不上；
 * 因此滚动停止这段时间之后才真正发起请求。
 */
const SCROLL_SETTLE_MS = 160;

/** 取下一页后等待新数据的上限；超时未到则解除占用，允许重试。 */
const LOAD_MORE_SETTLE_MS = 10000;

/** GitHub 的 noreply 邮箱，形如 `ID+用户名@users.noreply.github.com` 或 `用户名@users.noreply.github.com`。 */
const GITHUB_NOREPLY = /^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/i;

/**
 * 构造作者头像的候选地址，按优先次序排列。
 *
 * GitHub 邮箱由 GitHub 直接提供头像；其余邮箱用 Gravatar。GitHub 在前，取不到时由
 * Gravatar 兜底。
 *
 * @param {string} email - 作者邮箱。
 * @param {number} size - 请求的图片像素边长。
 * @returns {string[]} 候选地址；无邮箱时为空数组。
 */
function avatarUrls(email, size = 40) {
	if (typeof email !== 'string') return [];
	const urls = [];
	const trimmed = email.trim();
	if (trimmed === '') return [];
	const noreply = GITHUB_NOREPLY.exec(trimmed);
	if (noreply !== null) {
		const [, id, username] = noreply;
		// 带数字 id 时按 id 取；只有用户名时按用户名取。
		urls.push(id !== undefined
			? `https://avatars.githubusercontent.com/u/${id}?s=${size}&v=4`
			: `https://avatars.githubusercontent.com/${encodeURIComponent(username)}?s=${size}&v=4`);
	}
	return urls;
}

/**
 * 画作者头像：依次尝试候选地址，全部失败时回退到用户图标。
 *
 * 头像来自外部站点，取不到（离线、被拦、作者无头像）是常态，回退因此不报错也不留空白。
 *
 * @param props.urls - 候选地址，按优先次序。
 * @returns 头像元素。
 */
function AvatarImage({ urls }) {
	const [index, setIndex] = React.useState(0);
	const [failed, setFailed] = React.useState(false);
	if (failed || index >= urls.length) {
		return React.createElement(IconUserOutlineRegular, { size: 13, className: css.cardIcon });
	}
	return React.createElement('img', {
		className: css.cardAvatar,
		src: urls[index],
		alt: '',
		width: 20,
		height: 20,
		loading: 'lazy',
		// 该候选取不到就换下一个；候选用尽时标记失败。
		onError: () => { if (index + 1 < urls.length) setIndex(index + 1); else setFailed(true); },
	});
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
	/*
	 * 同色的直线合并成一条 <path>：直通竖线占线段总数的九成以上（并分支多的仓库实测 99%），
	 * 逐条建元素会让可见区的 SVG 元素数达到数千，滚动时每帧重建即成为内存与耗时的主要来源。
	 * 每条直线对应一个 M-L 子路径，样式与位置与逐条绘制完全一致。
	 */
	const lineParts = new Map<string, string[]>();
	const curves = [];
	// 未提交行的线用虚线，与真实提交区分。
	const dash = isUncommitted ? { strokeDasharray: '2 2' } : {};
	(row.segments ?? []).forEach((segment, index) => {
		// 未提交行不画节点，其出线因此从行顶起画、贯穿整行，不留节点处的断口。
		const shaped = isUncommitted && !segment.fromTop ? { ...segment, fromTop: true } : segment;
		const geometry = segmentGeometry(shaped, node);
		if (geometry === null) return;
		if (geometry.kind === 'path') {
			curves.push(React.createElement('path', {
				key: `c${index}`, d: geometry.d, fill: 'none',
				stroke: segment.colour, strokeWidth: LANE_STROKE, strokeLinecap: 'round', ...dash,
			}));
			return;
		}
		const parts = lineParts.get(segment.colour) ?? [];
		if (geometry.kind === 'gap') {
			parts.push(`M ${geometry.upper.x1} ${geometry.upper.y1} L ${geometry.upper.x2} ${geometry.upper.y2}`);
			parts.push(`M ${geometry.lower.x1} ${geometry.lower.y1} L ${geometry.lower.x2} ${geometry.lower.y2}`);
		} else {
			parts.push(`M ${geometry.x1} ${geometry.y1} L ${geometry.x2} ${geometry.y2}`);
		}
		lineParts.set(segment.colour, parts);
	});
	const segments = [
		...[...lineParts].map(([stroke, parts]) => React.createElement('path', {
			key: `l${stroke}`, d: parts.join(' '), fill: 'none',
			stroke, strokeWidth: LANE_STROKE, strokeLinecap: 'round', ...dash,
		})),
		...curves,
	];
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
			className: css.lane, width, height: ROW_HEIGHT,
			viewBox: `0 0 ${width} ${ROW_HEIGHT}`,
			// 线段在行顶与行底各越界 ROW_OVERLAP，必须允许溢出，否则越界部分被裁掉、接缝仍在。
			overflow: 'visible', 'aria-hidden': 'true',
		},
		...segments,
		...nodes,
	);
}

/**
 * 贮藏标记的文本：取贮藏消息。
 *
 * git 在有消息时把贮藏的 reflog 主题写成 `On <分支>: <消息>`，展示取用户写的那一段；
 * 没有消息（如自动贮藏）或取不到主题时，退回短引用名。
 *
 * @param commit - 带贮藏标记的提交。
 * @returns 展示文本。
 */
function stashMessage(commit) {
	const text = String(commit.message ?? '').trim();
	if (text === '') {
		const selector = String(commit.stash?.selector ?? 'stash');
		return selector.startsWith('refs/') ? selector.slice('refs/'.length) : selector;
	}
	const match = /^On [^:]*: (.*)$/.exec(text);
	return match !== null && match[1].trim() !== '' ? match[1].trim() : text;
}

/**
 * 取提交的引用标记，并附上用于右键识别的类型与名称。
 *
 * 本地分支与远程分支各自成标记：同名的一对分别显示，便于确认远程分支的存在。
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
		const message = stashMessage(commit);
		labels.push({
			key: 'stash', kind: 'stash', text: message,
			title: `贮藏 ${message}`, refType: 'stash', refName: selector,
		});
	}
	return labels;
}

/** 默认只显示图标、名称进 title 的种类；本地分支、HEAD 与标记始终带名称。 */
const ROUND_KINDS = new Set(['remote', 'stash']);

/** 只显示图标、独占一行也不带名称的种类：贮藏行的提交信息已经说明它的来源。 */
const ICON_ONLY_KINDS = new Set(['stash']);

/** 引用种类到样式类名的对应；种类来自 refLabels。 */
const REF_CLASSES: Record<string, string> = {
	head: css.refHead, branch: css.refBranch, remote: css.refRemote, tag: css.refTag, stash: css.refStash,
};

/**
 * 画一个引用标记。
 *
 * @param props.label - refLabels 给出的标记。
 * @param props.expanded - 是否把默认收起的种类展开为「图标 + 名称」药丸。
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
	const named = !ICON_ONLY_KINDS.has(label.kind) && (expanded || !ROUND_KINDS.has(label.kind));
	return React.createElement(
		'span',
		{
			className: cx(css.ref, REF_CLASSES[label.kind], named && ROUND_KINDS.has(label.kind) && css.refWide),
			title: label.title,
			'data-ref-type': label.refType,
			'data-ref-name': label.refName,
			// 圆形标记只有图标，名称经 aria-label 与 title 给出。
			...(named ? {} : { role: 'img', 'aria-label': label.title }),
		},
		icon,
		named ? React.createElement('span', { className: css.refText }, label.text) : null,
	);
}

/** 未提交伪提交的 message 形如 `Uncommitted Changes (2)`；数据层给出英文，这里译成中文。 */
const UNCOMMITTED_MESSAGE = /^Uncommitted Changes(?: \((\d+)\))?$/;

/**
 * 取一行显示的提交信息：贮藏行取贮藏消息，未提交伪提交的英文文案译成中文。
 *
 * @param commit - 提交。
 * @returns 显示用文本。
 */
function displayMessage(commit) {
	if (commit.stash !== null && commit.stash !== undefined) return stashMessage(commit);
	const message = String(commit.message ?? '');
	if (commit.hash !== '*') return message;
	const match = UNCOMMITTED_MESSAGE.exec(message);
	if (match === null) return message;
	return match[1] === undefined ? '未提交的更改' : `未提交的更改（${match[1]}）`;
}

/**
 * 悬停卡片的正文：作者与时间（时间右侧是翻译入口）、完整提交信息、改动统计、引用标记、短哈希。
 *
 * @param props.commit - 提交。
 * @param props.labels - refLabels 给出的引用标记。
 * @param props.stats - 改动统计 { files, additions, deletions }，未知时为 null。
 * @param props.formatDate - 日期格式化函数（unixSeconds -> 文本），沿用设置里的格式。
 * @param props.formatDetail - 详细时间格式化函数（unixSeconds -> 日期与时间）。
 * @param props.translation - 该提交的提交信息译文；未翻译过时为 null。
 * @param props.translatedFrom - 译文对应的原文；与当前信息相同表示当前显示的就是译文。
 * @param props.translating - 该提交是否正在翻译。
 * @param props.translateReady - 翻译服务是否可用。
 * @param props.onTranslate - 请求翻译该提交的提交信息。
 * @returns 卡片正文元素。
 */
function CommitCard({
	commit, labels, stats, formatDate, formatDetail, markdown, showAvatars, message,
	translation, translatedFrom, translating, translateReady, onTranslate,
}) {
	const isUncommitted = commit.hash === '*';
	const dated = typeof commit.date === 'number' && Number.isFinite(commit.date);
	const timeText = dated ? formatDate(commit.date) : '';
	const detail = dated ? formatDetail(commit.date) : '';
	const timeLabel = detail === '' || detail === timeText ? timeText : `${timeText}（${detail}）`;
	// 完整提交信息优先：列表里的 message 来自 `%s`，只有标题一行。
	const original = typeof message === 'string' && message !== '' ? message : String(commit.message ?? '');
	// 已翻译且内容未变时显示译文；原文一改即回到原文，等待重新翻译。
	const translated = translation !== null && translation !== undefined && translatedFrom === original;
	const fullMessage = translated ? translation : original;
	// 首行是标题，保持卡片自身字号；其余是正文，字号更小、行距更紧，且不留空行。
	const [titleLine, ...bodyLines] = fullMessage.split('\n');
	const body = bodyLines.filter((line) => line.trim() !== '');
	const avatars = showAvatars && !isUncommitted ? avatarUrls(commit.email ?? commit.author, 40) : [];
	// key 取首个候选：换作者时重建，尝试进度不跨提交沿用。
	const avatarEl = avatars.length > 0
		? React.createElement(AvatarImage, { key: avatars[0], urls: avatars })
		: React.createElement(IconUserOutlineRegular, { size: 13, className: css.cardIcon });
	// 判定与提交信息框共用同一函数：服务可用、无进行中的翻译、内容非空且以非当前语言为主。
	const showTranslate = !isUncommitted && showTranslateEntry({
		ready: translateReady === true, busy: translating === true, text: original,
		locale: interfaceLanguage(), translatedFrom,
	});
	return React.createElement(
		'div',
		{ className: css.card },
		React.createElement(
			'div',
			{ className: css.cardHead },
			avatarEl,
			React.createElement('span', { className: css.cardAuthor }, commit.author ?? ''),
			dated && React.createElement(IconClockOutlineRegular, { size: 13, className: css.cardIcon }),
			dated && React.createElement('span', { className: css.cardTime }, timeLabel),
			// 翻译入口排在时间右侧：只在该提交需要翻译时出现。
			showTranslate && React.createElement('button', {
				type: 'button',
				className: css.cardAction,
				title: '把提交信息翻译为当前语言',
				'aria-label': '翻译',
				onClick: () => onTranslate?.(original),
			}, React.createElement(TranslateIcon), '翻译'),
		),
		React.createElement(
			'div',
			{ className: css.cardMessage },
			// 标题：首行，保持卡片自身字号。
			React.createElement('div', { className: css.cardTitle }, titleLine === '' ? '\u00a0' : titleLine),
			// 正文：其余各行，字号更小、行距更紧。
			body.length > 0 && (markdown
				// compact 变体把段落间距从 16px 收到 4px，适合卡片这种小空间。
				? React.createElement('div', { className: css.cardBody },
					React.createElement(MarkdownText, { text: body.join('\n'), labels: MD_LABELS, variant: 'compact' }))
				: React.createElement('div', { className: css.cardBody },
					...body.map((line, index) => React.createElement('div', { key: `line-${index}` }, line)))),
		),
		stats !== null && stats !== undefined && React.createElement(
			'div',
			{ className: css.cardStats },
			`已更改 ${stats.files} 个文件，${stats.additions} 行插入(+)，${stats.deletions} 行删除(-)`,
		),
		labels.length > 0 && React.createElement(
			'div',
			{ className: css.cardRefs },
			...labels.map((label) => React.createElement(RefChip, { key: label.key, label, expanded: true })),
		),
		!isUncommitted && React.createElement(
			'div',
			{ className: css.cardHash },
			React.createElement('span', null, commit.hash.slice(0, 7)),
			React.createElement('button', {
				type: 'button',
				className: css.cardCopy,
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
			{ key: `issue-${key++}`, className: css.issueLink, href: url, target: '_blank', rel: 'noreferrer', onClick: (event) => event.stopPropagation() },
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
	markdown, showAvatars, muteMergeCommits,
	stats, message, onHover, widthAnchorRef,
	translation, translatedFrom, translating, translateReady, onTranslate,
}) {
	const isUncommitted = commit.hash === '*';
	// 贮藏标记行不是提交：与它的引用标记同源，右键走引用菜单，也不显示提交浮动卡片。
	const stashSelector = commit.stash?.selector ?? null;
	const labels = refLabels(commit, head);
	const isHead = !isUncommitted && head !== null && (commit.heads ?? []).includes(head);
	const isMerge = (commit.parents ?? []).length > 1;
	const isMuted = muteMergeCommits && isMerge && !isHead;
	const anchor = React.createElement(
		'div',
		{
			className: cx(css.row, selected && css.isSelected, isUncommitted && css.rowUncommitted, isMuted && css.rowMuted),
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
			{ className: css.subject },
			...renderSubject(displayMessage(commit), issueLinking),
			!isUncommitted && React.createElement('span', { className: css.author }, commit.author),
		),
		labels.length > 0 && React.createElement(
			'span',
			{ className: css.refs },
			// 只有一个标记时展开成「图标 + 名称」：远端分支、标记与贮藏默认只显示图标，
			// 独占一行时没有并排的宽度压力，名称直接给出（过长由 .refText 省略）。
			...labels.map((label) => React.createElement(RefChip, {
				key: label.key, label, expanded: labels.length === 1,
			})),
		),
	);
	// 未提交行没有可展示的提交信息，直接用行本身，不套悬停卡片。
	// 贮藏行同理：它不是提交，不显示提交浮动卡片。
	if (isUncommitted || stashSelector !== null) return anchor;
	return React.createElement(HoverCard, {
		anchor,
		content: React.createElement(CommitCard, {
			commit, labels, stats, message, formatDate, formatDetail, markdown, showAvatars,
			translation, translatedFrom, translating, translateReady, onTranslate,
		}),
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
		{ className: cx(css.row, css.rowIndicator) },
		React.createElement(LaneCell, { row, isUncommitted: false, isHead: false, isMerge: false }),
		React.createElement('span', { className: css.subject },
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
			className: css.detailGutter, width, viewBox: `0 0 ${width} 100`,
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
	localTip, remoteTip, baseTip, upstream,
	markdown, showAvatars, muteMergeCommits, graphColours,
	translatedMessages, translatedFrom, translatingHash, translateReady, onTranslateCommit,
}) {
	const layout = React.useMemo(
		() => layoutCommits(commits, { head, upstream, baseTip, localTip, remoteTip }),
		[commits, head, upstream, baseTip, localTip, remoteTip],
	);
	const graphRef = React.useRef(null);
	/** 可视区高度；窗口化渲染据此决定渲染哪一段。 */
	const [viewportHeight, setViewportHeight] = React.useState(0);
	/** 当前滚动位置。 */
	const [scrollTop, setScrollTop] = React.useState(0);
	/** 展开详情的实测高度；没有展开时为 0。 */
	const [detailHeight, setDetailHeight] = React.useState(0);
	/** 详情块的尺寸观察者。 */
	const detailObserverRef = React.useRef(null);
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
	/** 一次取更早完成前不重复请求；取回后按 commits 变化复位。 */
	/** 悬停回调：滚动期间只记住哈希，停止后由 handleScroll 补取。 */
	const hoverOrDefer = React.useCallback((hash: string | null) => {
		pendingHoverRef.current = hash;
		if (scrollSettleRef.current !== null) return;
		onHoverCommit?.(hash);
	}, [onHoverCommit]);

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

	/** 记录展开详情的实测高度，供行偏移计算使用。 */
	const measureDetail = React.useCallback((node) => {
		if (detailObserverRef.current !== null) {
			detailObserverRef.current.disconnect();
			detailObserverRef.current = null;
		}
		if (node === null) { setDetailHeight(0); return; }
		setDetailHeight(node.clientHeight);
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => setDetailHeight(node.clientHeight));
		observer.observe(node);
		detailObserverRef.current = observer;
	}, []);

	React.useEffect(() => () => {
		if (detailObserverRef.current !== null) detailObserverRef.current.disconnect();
	}, []);

	/*
	 * 滚动期间的悬停请求推迟到停止之后。
	 *
	 * 滚动时行在快速更替，按当时指针下的行取回数据多半用不上；记录最近一次悬停的哈希，
	 * 静默 SCROLL_SETTLE_MS 后再补取。
	 */
	const pendingHoverRef = React.useRef<string | null>(null);
	const scrollSettleRef = React.useRef<number | null>(null);

	/** 记录滚动位置、触发窗口重算，并推迟滚动期间的悬停请求。 */
	const handleScroll = React.useCallback(() => {
		const element = graphRef.current;
		if (element === null) return;
		setScrollTop(element.scrollTop);
		maybeLoadMore();
		if (scrollSettleRef.current !== null) clearTimeout(scrollSettleRef.current);
		scrollSettleRef.current = window.setTimeout(() => {
			scrollSettleRef.current = null;
			const hash = pendingHoverRef.current;
			if (hash !== null) onHoverCommit?.(hash);
		}, SCROLL_SETTLE_MS);
	}, [maybeLoadMore, onHoverCommit]);

	React.useEffect(() => () => {
		if (scrollSettleRef.current !== null) clearTimeout(scrollSettleRef.current);
	}, []);

	// 记录可视高度：窗口化渲染据此决定渲染哪一段；容器尺寸变化时重算。
	React.useEffect(() => {
		const element = graphRef.current;
		if (element === null) return undefined;
		const update = (): void => { setViewportHeight(element.clientHeight); };
		update();
		if (typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// 取回新数据后解除占用，并补取：内容仍未填满容器时继续取下一页。
	React.useEffect(() => {
		if (commits === requestedForRef.current) return;
		requestedForRef.current = commits;
		releasePending();
		maybeLoadMore();
	}, [commits, releasePending, maybeLoadMore]);

	React.useEffect(() => () => { if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current); }, []);

	const rows = layout.rows;
	/*
	 * 提交按哈希索引与选中行下标都记忆化：两者都是 O(提交数)，而滚动会逐帧重渲染，
	 * 放在渲染体内会让每次滚动都重建一份（上万条时每帧约 1MB，持续滚动即上百 MB 垃圾）。
	 */
	const commitByHash = React.useMemo(() => {
		const map = new Map();
		for (const commit of commits) map.set(commit.hash, commit);
		return map;
	}, [commits]);
	const selectedIndex = React.useMemo(
		() => (selectedHash === null ? -1 : rows.findIndex((row) => row.hash === selectedHash)),
		[rows, selectedHash],
	);
	/*
	 * 窗口化渲染：只挂载可视区附近的行，未渲染部分用等高空占位撑起滚动条。
	 *
	 * 不这样做时每条提交都是一个真实 DOM 行（含泳道 SVG 与引用标记），翻到几百条就是几百个节点常驻。
	 * 行偏移按 ROW_HEIGHT 累加，展开详情的那一行额外加上它的实测高度，下方各行因此不会错位。
	 */
	const offsets = React.useMemo(() => {
		const out = new Float64Array(rows.length + 1);
		for (let index = 0; index < rows.length; index++) {
			out[index + 1] = out[index] + ROW_HEIGHT + (index === selectedIndex ? detailHeight : 0);
		}
		return out;
	}, [rows, selectedIndex, detailHeight]);
	if (commits.length === 0) {
		return React.createElement('div', { className: shared.empty }, '这个仓库还没有提交');
	}
	// 可视区上下各多渲染 OVERSCAN_ROWS 行，滚动时不出现空白。
	let first = 0;
	while (first < rows.length && offsets[first + 1] <= scrollTop) first++;
	first = Math.max(0, first - OVERSCAN_ROWS);
	let last = first;
	while (last < rows.length && offsets[last] < scrollTop + viewportHeight) last++;
	last = Math.min(rows.length, last + OVERSCAN_ROWS);
	const items = [];
	for (let index = first; index < last; index++) {
		const row = rows[index];
		if (row === undefined) continue;
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
			stats: commitStats?.get(commit.hash) ?? null,
			message: commitMessages?.get(commit.hash) ?? null,
			translation: translatedMessages?.get(commit.hash) ?? null,
			translatedFrom: translatedFrom?.get(commit.hash) ?? null,
			translating: translatingHash === commit.hash,
			translateReady,
			onTranslate: (text: string) => { onTranslateCommit?.(commit.hash, text); },
			onHover: hoverOrDefer,
			widthAnchorRef: graphRef,
		}));
		// 改动文件区是图形区的一部分：展开在该提交行下方。
		const detail = renderDetail?.({ commit, row });
		if (detail !== null && detail !== undefined) {
			items.push(React.createElement(
				'div',
				{ key: `${commit.hash}:detail`, className: css.detailInline, ref: measureDetail },
				React.createElement(DetailGutter, { row }),
				React.createElement('div', { className: css.detailBody }, detail),
			));
		}
	}
	return React.createElement(
		'div',
		{ className: css.graph, ref: graphRef, onScroll: handleScroll, 'data-graph-scroll': '' },
		// 未渲染部分用等高空占位撑起滚动条：提交行高固定，高度可直接由行数算出。
		first > 0 && React.createElement('div', { key: 'spacerTop', style: { height: offsets[first] } }),
		...items,
		last < rows.length && React.createElement('div', { key: 'spacerBottom', style: { height: offsets[rows.length] - offsets[last] } }),
		moreCommitsAvailable && React.createElement(
			'div',
			{ key: 'pager', className: css.pager },
			loadingMore ? '正在加载更多提交…' : '滚动到底部自动加载更多',
		),
	);
}
