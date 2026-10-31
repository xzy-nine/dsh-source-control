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
	REMOTE_REF_COLOUR, RING_STROKE, ROW_HEIGHT, HEAD_REF_COLOUR,
	laneCentre, laneSpanWidth, layoutCommits, nodeOuterRadius, segmentGeometry,
} from './lanes.ts';
import { RemoteRefIcon, TagRefIcon, TranslateIcon } from '../ui/ref-icons.ts';
import { GitGraphIcon } from '../ui/plugin-icon.ts';
import { copyText } from '../ui/context-menu.ts';
import { interfaceLanguage, showTranslateEntry, translatedTitle } from '../panel/language.ts';
import css from '../css/graph.module.css';
import shared from '../css/shared.module.css';
import { cx } from '../css/cx.ts';
import {
	avatarUrlsOf, groupText, labelsOf, titleOf,
} from './row-model.ts';
import { useGraphWindowing } from './use-graph-windowing.ts';

/** MarkdownText 所需的本地化标签。 */
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

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
function LaneCellView({ row, isHead, isMerge, isUncommitted }) {
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

const LaneCell = React.memo(LaneCellView);

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
function RefChipView({ label, expanded = false }) {
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

const RefChip = React.memo(RefChipView);

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
 * @param props.onCancelTranslate - 取消该提交的翻译，回到原文。
 * @returns 卡片正文元素。
 */
function CommitCard({
	commit, labels, stats, formatDate, formatDetail, markdown, showAvatars, message,
	translation, translatedFrom, translating, translateReady, onTranslate, onCancelTranslate,
}) {
	const isUncommitted = commit.hash === '*';
	const dated = typeof commit.date === 'number' && Number.isFinite(commit.date);
	const timeText = dated ? formatDate(commit.date) : '';
	const detail = dated ? formatDetail(commit.date) : '';
	const timeLabel = detail === '' || detail === timeText ? timeText : `${timeText}（${detail}）`;
	// 完整提交信息优先：列表里的 message 来自 `%s`，只有标题一行。
	const original = typeof message === 'string' && message !== '' ? message : String(commit.message ?? '');
	// 整条信息已翻译且内容未变时正文用译文；只译了标题时正文仍用原文。
	const fullTranslated = translation !== null && translation !== undefined && translatedFrom === original;
	const fullMessage = fullTranslated ? translation : original;
	// 首行是标题，保持卡片自身字号；其余是正文，字号更小、行距更紧，且不留空行。
	const [originalTitle, ...bodyLines] = fullMessage.split('\n');
	// 标题：批量翻译只译标题，单条翻译译整条信息；两者都取译文首行。
	const titleLine = translatedTitle(
		titleOf(commit), original, translation ?? null, translatedFrom ?? null,
	) ?? originalTitle;
	const body = bodyLines.filter((line) => line.trim() !== '');
	const avatars = showAvatars && !isUncommitted ? avatarUrlsOf(commit.email ?? commit.author, 40) : [];
	// key 取首个候选：换作者时重建，尝试进度不跨提交沿用。
	const avatarEl = avatars.length > 0
		? React.createElement(AvatarImage, { key: avatars[0], urls: avatars })
		: React.createElement(IconUserOutlineRegular, { size: 13, className: css.cardIcon });
	// 判定与提交信息框共用同一函数：服务可用、内容非空且以非当前语言为主。
	const translatable = !isUncommitted && showTranslateEntry({
		ready: translateReady === true, busy: false, text: original,
		locale: interfaceLanguage(), translatedFrom,
	});
	// 已翻译或正在翻译时一律保留入口：进行中隐藏会让按钮在点击后消失，取消无处可点。
	const showTranslate = !isUncommitted && (fullTranslated || translating === true || translatable);
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
			// 翻译入口排在时间右侧：未译时发起翻译，已译时反色并再点即取消。
			showTranslate && React.createElement('button', {
				type: 'button',
				className: cx(css.cardAction, fullTranslated && css.cardActionOn),
				title: fullTranslated
					? '取消翻译，显示原文'
					: (translating === true ? '正在翻译…' : '把提交信息翻译为当前语言'),
				'aria-label': fullTranslated ? '取消翻译' : '翻译',
				'data-translated': fullTranslated ? '1' : undefined,
				'data-translating': translating === true ? '1' : undefined,
				onClick: () => {
					// 进行中或已译时再点即取消；否则发起翻译。
					if (translating === true || fullTranslated) onCancelTranslate?.();
					else onTranslate?.(original);
				},
			}, React.createElement(TranslateIcon, { inverted: fullTranslated }),
				fullTranslated ? '取消翻译' : (translating === true ? '翻译中…' : '翻译')),
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
		const id = groupText(match, 1) ?? match[0];
		const url = template.replace(/%ID%/g, encodeURIComponent(id));
		if (match.index > last) parts.push(message.slice(last, match.index));
		parts.push(React.createElement(
			'a',
			{ key: `issue-${key++}`, className: css.issueLink, href: url, target: '_blank', rel: 'noreferrer', onClick: (event) => { event.stopPropagation(); } },
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
 * @param props.onTranslateCommit - 请求翻译该行的提交信息（哈希 + 文本）。
 * @param props.onCancelTranslateCommit - 取消该行的翻译，回到原文。
 * @param props.widthAnchorRef - 卡片宽度对齐用的图区元素。
 * @returns 行元素。
 */
function CommitRowView({
	commit, row, head, selected, onSelect, onContextMenu, formatDate, formatDetail, issueLinking,
	markdown, showAvatars, muteMergeCommits,
	stats, message, onHover, widthAnchorRef,
	translation, translatedFrom, translating, translateReady, onTranslateCommit, onCancelTranslateCommit,
}) {
	const isUncommitted = commit.hash === '*';
	// 贮藏标记行不是提交：与它的引用标记同源，右键走引用菜单，也不显示提交浮动卡片。
	const stashSelector = commit.stash?.selector ?? null;
	const labels = labelsOf(commit, head);
	const isHead = !isUncommitted && head !== null && (commit.heads ?? []).includes(head);
	const isMerge = (commit.parents ?? []).length > 1;
	const isMuted = muteMergeCommits && isMerge && !isHead;
	// 行标题：批量翻译或单条翻译的译文首行可用时用它，否则用原文。
	const title = titleOf(commit);
	const shownTitle = translatedTitle(title, message, translation, translatedFrom) ?? title;
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
				const refInfo = refElement !== null
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
			...renderSubject(shownTitle, issueLinking),
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
			translation, translatedFrom, translating, translateReady,
			// 行内按哈希自建闭包，父组件因此只传稳定的两个回调。
			onTranslate: (text) => { onTranslateCommit?.(commit.hash, text); },
			onCancelTranslate: () => { onCancelTranslateCommit?.(commit.hash); },
		}),
		variant: 'preview',
		widthAnchorRef,
	});
}

const CommitRow = React.memo(CommitRowView);

/**
 * 领先/落后指示行：虚拟行，没有对应提交。
 *
 * @param props.row - 该行的布局。
 * @param props.indicator - 'incoming' 云端领先、'outgoing' 本地领先。
 * @returns 行元素。
 */
function IndicatorRowView({ row, indicator }) {
	return React.createElement(
		'div',
		{ className: cx(css.row, css.rowIndicator) },
		React.createElement(LaneCell, { row, isUncommitted: false, isHead: false, isMerge: false }),
		React.createElement('span', { className: css.subject },
			indicator === 'incoming' ? '云端领先' : '本地领先'),
	);
}

const IndicatorRow = React.memo(IndicatorRowView);

/**
 * 展开块左侧的泳道续画：把该行画到行底的线段在展开块高度内继续向下延伸。
 *
 * @param props.row - 该行的布局。
 * @returns SVG 元素；没有向下线段时返回 null。
 */
function DetailGutterView({ row }) {
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

const DetailGutter = React.memo(DetailGutterView);

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
function CommitGraphView({
	commits, head, selectedHash, onSelect, onLoadMore, moreCommitsAvailable,
	onContextMenu, formatDate, formatDetail, issueLinking, commitStats, commitMessages, onHoverCommit, renderDetail,
	localTip, remoteTip, baseTip, upstream,
	markdown, showAvatars, muteMergeCommits, graphColours: _graphColours,
	translatedMessages, translatedFrom, translatingHash, translateReady, onTranslateCommit, onCancelTranslateCommit,
	onVisibleCommits,
}) {
	const layout = React.useMemo(
		() => layoutCommits(commits, { head, upstream, baseTip, localTip, remoteTip }),
		[commits, head, upstream, baseTip, localTip, remoteTip],
	);
	const rows = layout.rows;
	const dateFmt = formatDate ?? ((seconds) => new Date(seconds * 1000).toLocaleString());
	const detailFmt = formatDetail ?? ((seconds) => new Date(seconds * 1000).toLocaleString());

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
	const { graphRef, offsets, range, loadingMore, handleScroll, measureDetail, hoverOrDefer } = useGraphWindowing({
		rows, selectedIndex, commits, moreCommitsAvailable, onLoadMore, onHoverCommit,
	});

	// 上报可见窗口内的提交：标题栏的批量翻译按这一批下发。
	const visibleCommits = React.useMemo(() => {
		const out: { hash: string; text: string }[] = [];
		for (let index = range.first; index < range.last; index++) {
			const row = rows[index];
			if (row.indicator !== undefined) continue;
			const commit = commitByHash.get(row.hash);
			// 未提交行与贮藏行不是提交，没有可翻译的提交信息。
			if (commit === undefined || commit.hash === '*' || commit.stash !== null && commit.stash !== undefined) continue;
			out.push({ hash: commit.hash, text: titleOf(commit) });
		}
		return out;
	}, [rows, range, commitByHash]);
	const onVisibleCommitsRef = React.useRef(onVisibleCommits);
	onVisibleCommitsRef.current = onVisibleCommits;
	React.useEffect(() => { onVisibleCommitsRef.current?.(visibleCommits); }, [visibleCommits]);
	if (commits.length === 0) {
		return React.createElement('div', { className: shared.empty }, '这个仓库还没有提交');
	}
	const { first, last } = range;
	const items = [];
	for (let index = first; index < last; index++) {
		const row = rows[index];
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
			onTranslateCommit,
			onCancelTranslateCommit,
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

export const CommitGraph = React.memo(CommitGraphView);
