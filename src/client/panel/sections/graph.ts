/**
 * 图形分区：标题栏 + 提交图 + 触底加载。
 *
 * 只接收已算好的数据与回调，状态与数据加载由面板主体持有。
 */
import React from 'react';
import {
	IconChevronDownOutlineRegular, IconDownloadOutlineRegular,
	IconGoalOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { CommitGraph } from '../../graph/index.ts';
import { RepoIcon, TranslateIcon } from '../../ui/ref-icons.ts';
import { GitGraphIcon } from '../../ui/plugin-icon.ts';
import { CommitDetail } from '../changes.ts';
import { interfaceLanguage, needsTranslationMemo } from '../language.ts';
import type { BusyFlags, Commit, CommitCacheMaps, CommitFile, PanelPhase, RepoNode, Settings } from '../../shared/types.ts';
/** 进入提交对比用的修饰键名，按平台显示：macOS 用 ⌘、其余用 Ctrl。 */
const COMPARE_MODIFIER = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent)
	? '⌘'
	: 'Ctrl';

import { refreshButton } from './refresh-button.ts';
import css from '../../css/sections.module.css';
import shared from '../../css/shared.module.css';
import { cx } from '../../css/cx.ts';


export interface GraphSectionProps extends CommitCacheMaps {
	readonly open: boolean;
	readonly height: number;
	readonly busy: BusyFlags;
	readonly phase: PanelPhase;
	readonly commitCount: number;
	readonly selectedNode: RepoNode | null;
	readonly graphScrollRef: React.RefObject<HTMLDivElement | null>;
	readonly commits: readonly Commit[];
	readonly head: string | null;
	readonly selectedHash: string | null;
	/** 领先/落后标记：云端领先的上游尖端与本地领先的 HEAD。 */
	readonly localTip: string | null;
	readonly remoteTip: string | null;
	/** 本地与上游的合并基提交哈希；分叉点据此单独着色。 */
	readonly baseTip: string | null;
	/** 上游远程跟踪分支名，决定泳道引用色。 */
	readonly upstream: string | null;
	readonly moreCommitsAvailable: boolean;
	/** 因留存封顶而丢弃的提交总数。 */
	/** 留存提交之前的泳道状态；裁头后由此续算。 */
	/** 正在翻译的提交哈希；空闲时为 null。 */
	readonly translatingHash: string | null;
	/** 翻译服务是否可用；不可用时提交浮窗不给翻译入口。 */
	readonly translateReady: boolean;
	/** 翻译一个提交的提交信息。 */
	readonly onTranslateCommit: (hash: string, text: string) => void;
	/** 取消一个提交的翻译。 */
	readonly onCancelTranslateCommit: (hash: string) => void;
	/** 图形区标题栏的批量翻译是否已生效。 */
	readonly graphTranslated: boolean;
	/** 图形区批量翻译的进度；未进行时为 null。 */
	readonly graphTranslating: { done: number; total: number } | null;
	/** 批量翻译当前可见窗口内的提交标题。 */
	readonly onTranslateVisible: (items: readonly { hash: string; text: string }[]) => void;
	/** 取消图形区的批量翻译。 */
	readonly onCancelTranslate: () => void;
	readonly detail: { commit: Commit; files: CommitFile[]; compareWith: Commit | null; loading: boolean } | null;
	readonly detailCollapsed: ReadonlySet<string>;
	readonly settings: Settings;
	readonly onToggleSection: () => void;
	readonly onToggleChange: (key: string, path: string) => void;
	readonly onOpenDiff: (hash: string, path: string, staged: boolean, isNew?: boolean, baseHash?: string) => Promise<void>;
	readonly onToggleCommit: (hash: string, additive?: boolean) => void;
	readonly onLoadMore: () => void;
	/** 取回更早的一段（窗口头部之前）。 */
	/** 窗口头部之前是否还有更早的提交。 */
	readonly onContextMenu: (args: { commit: Commit; refInfo: { type: string | null; name: string | null } | null; event: React.MouseEvent<HTMLElement> }) => void;
	readonly onHoverCommit: (hash: string | null) => void;
	readonly onOpenFilter: () => void;
	/** 引用筛选摘要：显示当前模式或已选数量。 */
	readonly filterSummary: string;
	/** 当前筛选是否收窄了提交范围。 */
	readonly filterActive: boolean;
	readonly onGoToHead: () => void;
	readonly onFetch: () => void;
	readonly onRefresh: () => void;
	readonly onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
	readonly formatDate: (seconds: number) => string;
	readonly formatDetail: (seconds: number) => string;
	readonly issueLinking: unknown;
	/** 提交图是否正在后台刷新；标题栏据此给出进行中指示。 */
	readonly refreshing: boolean;
	/** 「上次刷新」文案；为空串时不显示。 */
	readonly lastRefresh: string;
}

/**
 * 图形分区：标题栏（筛选/定位/抓取/刷新）+ 提交图 + 上沿拖拽手柄。
 *
 * @param props - 见 {@link GraphSectionProps}。
 * @returns 分区元素。
 */
function GraphSectionView({
	open, height, busy, phase, commitCount, selectedNode, graphScrollRef, commits, head, selectedHash,
	localTip, remoteTip, baseTip, upstream, moreCommitsAvailable, statsByHash, messageByHash, detail, detailCollapsed, settings,
	onToggleSection, onToggleChange, onOpenDiff, onToggleCommit, onLoadMore, onContextMenu, onHoverCommit,
	translatedByHash, translatedFromByHash, translatingHash, translateReady, onTranslateCommit, onCancelTranslateCommit,
	graphTranslated, graphTranslating, onTranslateVisible, onCancelTranslate,
	onOpenFilter, filterSummary, filterActive, onGoToHead, onFetch, onRefresh, onResizeStart, formatDate, formatDetail, issueLinking,
	refreshing, lastRefresh,
}: GraphSectionProps): React.ReactElement {
	// 当前可见窗口内的提交；由提交图上报，标题栏的批量翻译据此下发。
	const [visible, setVisible] = React.useState<readonly { hash: string; text: string }[]>([]);
	/*
	 * 标题栏入口与提交信息框同一判据：翻译服务可用、可见窗口内有非当前语言的标题。
	 *
	 * 已翻译或正在翻译时一律保留：进行中隐藏会让按钮在点击后消失，进度与取消都无处可点。
	 */
	const locale = interfaceLanguage();
	const visibleTranslatable = React.useMemo(
		() => visible.some((item) => needsTranslationMemo(item.text, locale)),
		[visible, locale],
	);
	const showGraphTranslate = translateReady && (graphTranslated || graphTranslating !== null || visibleTranslatable);
	const translating = graphTranslating !== null;
	/** 选中提交行：传给提交图，属性不变时已有的行不重渲染。 */
	const handleSelect = React.useCallback((hash: string, additive?: boolean) => {
		onToggleCommit(hash, additive);
	}, [onToggleCommit]);
	/** 展开块内的文件夹折叠。 */
	const handleDetailToggle = React.useCallback((path: string) => {
		onToggleChange('detail', path);
	}, [onToggleChange]);
	/** 展开块内的文件打开。 */
	const handleDetailOpen = React.useCallback((path: string, isNew: boolean) => {
		if (detail === null) return;
		// 对比模式下新增文件仍有可比差异（旧侧为空），不按普通文件打开。
		void onOpenDiff(detail.commit.hash, path, false, detail.compareWith === null && isNew, detail.compareWith?.hash);
	}, [detail, onOpenDiff]);
	/** 展开块内容：只随选中提交与详情数据变化。 */
	const renderDetail = React.useCallback(({ commit }: { commit: Commit }) => (detail !== null && detail.commit.hash === commit.hash
		? React.createElement(
			React.Fragment,
			null,
			// 对比模式在文件列表前标出方向：旧 → 新。
			detail.compareWith !== null
				? React.createElement('div', { className: css.detailCompare },
					'对比 ' + detail.compareWith.hash.slice(0, 7) + ' → ' + commit.hash.slice(0, 7))
				// 未进入对比时提示入口：按住修饰键点击另一提交即可对比。
				: React.createElement('div', { className: css.detailCompareHint },
					'按住 ' + COMPARE_MODIFIER + ' 点击另一个提交可对比两者'),
			React.createElement(CommitDetail, {
				files: detail.files,
				busy: busy.read,
				loading: detail.loading,
				collapsed: detailCollapsed,
				onToggle: handleDetailToggle,
				onOpen: handleDetailOpen,
			}),
		)
		: null), [detail, detailCollapsed, busy.read, handleDetailOpen, handleDetailToggle]);
	return React.createElement(
		'div',
		{ className: cx(css.sec, css.graphSec) },
		// 拖拽手柄落在工作区与图形的分界线上（图形标题之前）。
		open && React.createElement('div', {
			className: shared.secResize,
			title: '拖动调整图形区高度',
			onPointerDown: onResizeStart,
		}),
		React.createElement('div', {
			className: cx(css.secHead, !open && css.collapsed),
			onClick: onToggleSection,
		},
			React.createElement(IconChevronDownOutlineRegular, { size: 14, className: css.chevron }),
			'图形',
			React.createElement(StateDot, { state: refreshing ? 'ongoing' : 'idle', size: 8, className: css.headDot }),
			lastRefresh !== '' && React.createElement('span', { className: css.headRefreshNote }, lastRefresh),
			// 翻译当前可见窗口内的提交标题，紧随标题文本；已翻译时图标反色，再点即取消。
			showGraphTranslate && React.createElement('button', {
				type: 'button',
				className: cx(css.iconBtn, css.headAction, graphTranslated && css.actionOn),
				title: graphTranslated
					? '取消翻译提交标题'
					: (translating ? `正在翻译 ${graphTranslating.done}/${graphTranslating.total}` : '翻译可见的提交标题'),
				'aria-label': graphTranslated ? '取消翻译' : '翻译可见的提交标题',
				'data-translated': graphTranslated ? '1' : undefined,
				'data-translating': translating ? '1' : undefined,
				onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
					event.stopPropagation();
					// 进行中再点即取消；否则按当前状态发起或撤销。
					if (translating || graphTranslated) onCancelTranslate();
					else onTranslateVisible(visible);
				},
			}, React.createElement(TranslateIcon, { inverted: graphTranslated })),
			React.createElement('span', { className: css.headActions },
				selectedNode !== null && React.createElement('span', { className: css.headRepo },
					React.createElement(RepoIcon),
					React.createElement('span', null, selectedNode.name),
				),
				React.createElement('button', {
					type: 'button', className: cx(css.iconBtn, filterActive && css.actionOn), title: '筛选分支与标签',
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onOpenFilter(); },
				}, React.createElement(GitGraphIcon, { size: 14 }), filterSummary),
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '转到当前历史记录',
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onGoToHead(); },
				}, React.createElement(IconGoalOutlineRegular, { size: 14 })),
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '从所有远程抓取', disabled: busy.network,
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onFetch(); },
				}, React.createElement(IconDownloadOutlineRegular, { size: 14 })),
				refreshButton(busy.read, refreshing, lastRefresh, onRefresh),
			),
		),
		open && (
			phase === 'loading' && commitCount === 0
				? React.createElement('div', { className: shared.empty, style: { height } }, '正在加载提交图…')
				: React.createElement('div', {
					ref: graphScrollRef,
					style: { height, display: 'flex', flexDirection: 'column', minHeight: 0 },
				}, React.createElement(CommitGraph, {
					commits,
					head,
					selectedHash,
					localTip,
					remoteTip,
					baseTip,
					upstream,
					onSelect: handleSelect,
					onLoadMore,
					moreCommitsAvailable,
					onContextMenu,
					formatDate,
					formatDetail,
					issueLinking,
					markdown: settings.markdown,
					showAvatars: settings.showAvatars,
					muteMergeCommits: settings.muteMergeCommits,
					graphColours: settings.graphColours,
					commitStats: statsByHash,
					commitMessages: messageByHash,
					translatedMessages: translatedByHash,
					translatedFrom: translatedFromByHash,
					translatingHash,
					translateReady,
					onTranslateCommit,
					onCancelTranslateCommit,
					onVisibleCommits: setVisible,
					onHoverCommit,
					renderDetail,
				}))
		),
	);
}

export const GraphSection = React.memo(GraphSectionView);