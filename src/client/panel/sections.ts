/**
 * 面板的三个分区：存储库、更改（含提交框）、图形。
 *
 * 每个分区只接收已算好的数据与回调，状态与数据加载由面板主体持有。
 */
import React from 'react';
import {
	Button, Checkbox, FileTypeIcon, IconArchiveOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
	IconCloseOutlineRegular,
	IconDownloadOutlineRegular, IconGoalOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
	IconSettingsOutlineRegular, IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { CommitGraph } from '../graph/index.ts';
import { PublishIcon, RepoIcon, TranslateIcon } from '../ui/ref-icons.ts';
import { GitGraphIcon } from '../ui/plugin-icon.ts';
import { ChangeGroup, CommitDetail } from './changes.ts';
import { interfaceLanguage, needsTranslation } from './language.ts';
import { RepoRow } from './repo-row.ts';
import { anyBusy } from './busy.ts';
import type {
	AiStats, BusyFlags, ChangeActions, Commit, CommitCacheMaps, CommitFile, PanelPhase, RepoNode, RepoSync, Settings, WorkingTreeEntry,
} from '../shared/types.ts';
import css from '../css/sections.module.css';
import shared from '../css/shared.module.css';
import { cx } from '../css/cx.ts';

/** 进入提交对比用的修饰键名，按平台显示：macOS 用 ⌘、其余用 Ctrl。 */
const COMPARE_MODIFIER = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent)
	? '⌘'
	: 'Ctrl';

/**
 * 分区标题栏的刷新按钮。
 *
 * @param disabled - 是否禁用。
 * @param onRefresh - 点击回调。
 * @returns 按钮元素。
 */
function refreshButton(disabled: boolean, onRefresh: () => void): React.ReactElement {
	return React.createElement('button', {
		type: 'button', className: css.iconBtn, title: '刷新', disabled,
		onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onRefresh(); },
	}, React.createElement(IconRefreshOutlineRegular, { size: 14 }));
}

/** 存储库分区。 */
export interface RepoSectionProps {
	readonly open: boolean;
	readonly height: number;
	readonly busy: BusyFlags;
	readonly treeStatus: 'loading' | 'ready' | 'empty' | 'error';
	readonly treeNote: string | null;
	readonly visibleRows: ReadonlyArray<{ node: RepoNode; depth: number }>;
	readonly selectedId: string | null;
	readonly expandedIds: ReadonlySet<string>;
	readonly syncById: ReadonlyMap<string, RepoSync>;
	readonly headHash: string | null;
	readonly onToggleSection: () => void;
	readonly onOpenSettings: () => void;
	/** 克隆远程仓库：输入地址后选父目录，在其中创建同名子目录。 */
	readonly onClone: () => void;
	/** 克隆进行中：只禁用克隆入口，不影响其它控件。 */
	readonly cloneBusy: boolean;
	readonly onSelect: (node: RepoNode) => void;
	readonly onToggle: (node: RepoNode) => void;
	readonly onMoreActions: (node: RepoNode, event: React.MouseEvent<HTMLElement>) => void;
	readonly onBranchClick: (node: RepoNode, event: React.MouseEvent<HTMLElement>) => void;
	readonly onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * 存储库分区：标题栏 + 仓库树 + 下沿拖拽手柄。
 *
 * @param props - 见 {@link RepoSectionProps}。
 * @returns 分区元素。
 */
export function RepoSection({
	open, height, busy, treeStatus, treeNote, visibleRows, selectedId, expandedIds, syncById, headHash,
	onToggleSection, onOpenSettings, onClone, cloneBusy, onSelect, onToggle, onMoreActions, onBranchClick, onResizeStart,
}: RepoSectionProps): React.ReactElement {
	return React.createElement(
		'div',
		{ className: css.sec },
		React.createElement('div', {
			className: cx(css.secHead, !open && css.collapsed),
			onClick: onToggleSection,
		},
			React.createElement(IconChevronDownOutlineRegular, { size: 14, className: css.chevron }),
			'存储库',
			treeNote !== null && React.createElement('span', { className: css.secNote, title: treeNote }, '⚠'),
			React.createElement('span', { className: css.headActions },
				// 克隆在设置左侧：两个入口都作用于整个存储库区；克隆期间只禁用克隆自身。
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '克隆远程仓库', disabled: busy.network || cloneBusy,
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onClone(); },
				}, React.createElement(IconPlusOutlineRegular, { size: 14 })),
				// 设置是本地入口，不随仓库操作禁用。
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '设置',
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onOpenSettings(); },
				}, React.createElement(IconSettingsOutlineRegular, { size: 14 })),
			),
		),
		open && React.createElement(
			'div',
			{ className: css.repos, style: { maxHeight: height, overflowY: 'auto' } },
			treeStatus === 'loading' && React.createElement('div', { className: shared.hint }, '正在发现仓库…'),
			treeStatus !== 'loading' && visibleRows.length === 0
				&& React.createElement('div', { className: shared.hint }, '没有发现 git 仓库'),
			...visibleRows.map(({ node, depth }) => React.createElement(RepoRow, {
				key: node.id, node, depth,
				active: node.id === selectedId,
				expanded: expandedIds.has(node.id),
				sync: syncById.get(node.id),
				onSelect,
				onToggle,
				onMoreActions,
				onBranchClick,
				headHash,
			})),
		),
		open && React.createElement('div', {
			className: shared.secResize,
			title: '拖动调整存储库区高度',
			onPointerDown: onResizeStart,
		}),
	);
}

/** 更改分区。 */
export interface ChangesSectionProps extends ChangeActions {
	readonly entries: readonly WorkingTreeEntry[];
	readonly busy: BusyFlags;
	readonly phase: PanelPhase;
	readonly workingTreePath: string | null;
	readonly head: string | null;
	readonly message: string;
	readonly onMessageChange: (message: string) => void;
	readonly amend: boolean;
	readonly onToggleAmend: (checked: boolean) => void;
	/**
	 * 钩子处于激活状态时为 true：此时提交框显示 githook 勾选项。
	 *
	 * 提交钩子与推送钩子任一存在即显示：同一个勾选项同时决定提交与推送是否带 `--no-verify`。
	 */
	readonly hooksActive: boolean;
	/** 本次提交与推送是否运行钩子。 */
	readonly runHooks: boolean;
	readonly onToggleRunHooks: (checked: boolean) => void;
	/** 把当前改动存入贮藏。 */
	readonly onStash: () => void;
	/** AI 生成完成且内容以非当前语言为主时，显示翻译按钮。 */
	readonly showTranslate: boolean;
	readonly translateBusy: boolean;
	readonly onTranslate: () => void;
	readonly aiBusy: boolean;
	readonly aiWarning: string;
	readonly aiStats: AiStats | null;
	readonly onAiCommit: () => void;
	readonly showSyncButton: boolean;
	readonly syncBehind: number;
	readonly syncAhead: number;
	readonly onSync: () => void;
	/** 当前分支是纯本地分支（无上游）且无改动时，提交按钮改为发布。 */
	readonly showPublishButton: boolean;
	readonly onPublish: () => void;
	/** 提交按钮是否可用：有暂存改动，或勾选修补（此时可只改提交信息）。 */
	readonly canSubmit: boolean;
	readonly onSubmit: () => void;
	readonly onRefresh: () => void;
	readonly collapsedByGroup: { staged: ReadonlySet<string>; unstaged: ReadonlySet<string> };
	readonly groupExpanded: { staged: boolean; unstaged: boolean };
	readonly toggleChange: (key: string, path: string) => void;
	readonly toggleGroup: (key: string) => void;
	/** 当前工作树是否有本地排除条目；有才显示查看入口。 */
	readonly hasLocalExclude: boolean;
	/** 查看本地排除的条目。 */
	readonly onShowLocalExclude: () => void;
	/** 是否处于未完成的合并：为真时显示取消合并入口。 */
	readonly merging: boolean;
	/** 中止当前合并。 */
	readonly onAbortMerge: () => void;
}

/**
 * 更改分区：标题栏 + 提交框 + 两个变更分组。
 *
 * @param props - 见 {@link ChangesSectionProps}。
 * @returns 分区元素。
 */
export function ChangesSection({
	entries, busy, phase, workingTreePath, head, message, onMessageChange, amend, onToggleAmend, onStash,
	hooksActive, runHooks, onToggleRunHooks,
	showTranslate, translateBusy, onTranslate,
	aiBusy, aiWarning, aiStats, onAiCommit, showSyncButton, syncBehind, syncAhead, onSync,
	showPublishButton, onPublish,
	canSubmit, onSubmit, onRefresh, collapsedByGroup, groupExpanded, toggleChange, toggleGroup, run,
	stagePaths, unstagePaths, discardPaths, openDiff,
	onAddToGitignore, onAddToLocalExclude, hasLocalExclude, onShowLocalExclude,
	merging, onAbortMerge,
}: ChangesSectionProps): React.ReactElement {
	/*
	 * 右侧动作组：贮藏固定在最右端，其余按出现顺序追加，不占固定位置。
	 *
	 * 每项只在自己条件成立时追加，因此同时出现时先追加的靠左，缺项不会留下空档。
	 */
	const rightActions: React.ReactNode[] = [];
	if (hasLocalExclude) {
		// 本地排除有内容时给出打开入口：图标取 .gitignore 的文件图标。
		rightActions.push(React.createElement(Button, {
			key: 'local-exclude',
			variant: 'ghost', size: 'sm',
			className: css.stashBtn, onClick: onShowLocalExclude,
			title: '打开本地排除文件', 'aria-label': '本地排除',
		}, React.createElement(FileTypeIcon, { path: '.gitignore', size: 14 }), '本地排除'));
	}
	if (showTranslate) {
		// AI 生成的内容不是当前语言时提供翻译：仅图标。
		rightActions.push(React.createElement(Button, {
			key: 'translate',
			variant: 'ghost', size: 'sm', disabled: translateBusy,
			className: css.stashBtn, onClick: onTranslate,
			title: '把提交信息翻译为当前语言', 'aria-label': '翻译',
		}, React.createElement(TranslateIcon)));
	}
	if (merging) {
		rightActions.push(React.createElement(Button, {
			key: 'abort-merge',
			variant: 'ghost', size: 'sm', disabled: busy.commit || busy.history,
			className: css.abortMergeBtn, onClick: onAbortMerge,
			title: '中止当前合并，恢复到合并前的状态', 'aria-label': '取消合并',
		}, React.createElement(IconCloseOutlineRegular, { size: 14 }), '取消合并'));
	}
	rightActions.push(React.createElement(Button, {
		key: 'stash',
		variant: 'ghost', size: 'sm', disabled: busy.commit || entries.length === 0,
		className: css.stashBtn, onClick: onStash, title: '把当前改动存入贮藏',
	}, React.createElement(IconArchiveOutlineRegular, { size: 14 }), '贮藏'));
	return React.createElement(
		'div',
		{ className: cx(css.sec, css.workspace) },
		React.createElement(
			'div',
			{ className: css.secHead },
			React.createElement(IconChevronDownOutlineRegular, { size: 14, className: css.chevron }),
			'更改',
			React.createElement('span', { className: css.headActions },
				refreshButton(busy.read, onRefresh),
			),
		),
		React.createElement(
			'div',
			{ className: css.workspaceBody },
			// ── 提交框 ────────────────────────────────────────
			React.createElement(
				'div',
				{ className: css.commitBox },
				(aiBusy || anyBusy(busy) || phase === 'loading') && React.createElement('div', { className: css.aiLoadingBar }),
				React.createElement('div', { className: css.commitInputWrap },
					React.createElement('textarea', {
						className: css.commitInput,
						placeholder: aiBusy ? 'AI 正在生成…' : `提交变更内容(Ctrl+Enter 在 '${head ?? 'master'}'提交)`,
						value: message,
						disabled: aiBusy,
						onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { onMessageChange(event.currentTarget.value); },
						onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
							if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
								event.preventDefault();
								onSubmit();
							}
						},
					}),
					React.createElement('div', { className: css.commitInputActions },
						React.createElement('button', {
							type: 'button', className: cx(css.commitInputBtn, aiBusy && css.isBusy), title: 'AI 辅助提交',
							disabled: aiBusy || busy.commit,
							onClick: onAiCommit,
						}, React.createElement(IconSparkleRegular, { size: 14 })),
						React.createElement('button', {
							type: 'button', className: css.commitInputBtn, title: '选择提交方式',
						}, React.createElement(IconChevronDownOutlineRegular, { size: 14 })),
					),
				),
				aiWarning !== '' && React.createElement('div', { className: css.commitAiWarning }, aiWarning),
				aiStats !== null && React.createElement('div', { className: css.commitAiStats },
					`${aiStats.tps} tok/s`,
					` · 输入 ${aiStats.inputTokens}`,
					` · 输出 ${aiStats.outputTokens}`,
					` · 缓存读 ${aiStats.cacheReadTokens}`,
					` · 缓存写 ${aiStats.cacheWriteTokens}`,
					` · ${aiStats.elapsed}+${aiStats.ttft}`,
				),
				React.createElement('div', { className: css.commitActionsRow },
					React.createElement('span', { className: css.commitActionsLeft },
						React.createElement(Checkbox, { checked: amend, onChange: onToggleAmend, label: '修补上一次提交' }),
						// 一个勾选项同时管提交与推送：主按钮无论落在提交、同步还是发布上，它都在同一处。
						hooksActive && React.createElement('span', { className: css.githookSlot },
							React.createElement(Checkbox, {
								checked: runHooks, onChange: onToggleRunHooks,
								label: 'githook', title: '取消后本次提交与推送跳过 pre-commit / pre-push 等钩子（--no-verify），下次恢复',
							}),
						),
					),
					React.createElement('span', { className: css.commitActionsRight }, ...rightActions),
				),
				showSyncButton
					? React.createElement(Button, {
						variant: 'primary', size: 'sm', disabled: busy.network || busy.history,
						onClick: onSync,
					}, '同步更改',
						syncBehind > 0 && React.createElement('span', null, ` ↓${syncBehind}`),
						syncAhead > 0 && React.createElement('span', null, ` ↑${syncAhead}`),
					)
					: showPublishButton
						? React.createElement(Button, {
							variant: 'primary', size: 'sm', disabled: busy.network,
							title: '把当前分支推送到远程并建立跟踪',
							onClick: onPublish,
						}, React.createElement(PublishIcon), '发布')
						: React.createElement(Button, {
							variant: 'primary', size: 'sm', disabled: busy.commit || message.trim() === '' || !canSubmit,
							onClick: onSubmit,
						}, React.createElement(IconCheckOutlineRegular, { size: 15 }), '提交 Ctrl+Enter'),
			),
			// 提交框与两个分组分开：提交框固定，只有变更列表滚动。
			React.createElement(
				'div',
				{ className: css.changesScroll },
				ChangeGroup({
					staged: true, entries, busy: busy.commit, workingTreePath: workingTreePath as string,
					groupKey: 'staged', collapsed: collapsedByGroup.staged, toggleChange, open: groupExpanded.staged, onToggleGroup: () => { toggleGroup('staged'); },
					run, stagePaths, unstagePaths, discardPaths, openDiff,
					onAddToGitignore, onAddToLocalExclude,
				}),
				ChangeGroup({
					staged: false, entries, busy: busy.commit, workingTreePath: workingTreePath as string,
					groupKey: 'unstaged', collapsed: collapsedByGroup.unstaged, toggleChange, open: groupExpanded.unstaged, onToggleGroup: () => { toggleGroup('unstaged'); },
					run, stagePaths, unstagePaths, discardPaths, openDiff,
					onAddToGitignore, onAddToLocalExclude,
					forceShow: entries.some((e) => e.index !== ' ' && e.index !== '?'),
				}),
			),
		),
	);
}

/** 图形分区。 */
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
}

/**
 * 图形分区：标题栏（筛选/定位/抓取/刷新）+ 提交图 + 上沿拖拽手柄。
 *
 * @param props - 见 {@link GraphSectionProps}。
 * @returns 分区元素。
 */
export function GraphSection({
	open, height, busy, phase, commitCount, selectedNode, graphScrollRef, commits, head, selectedHash,
	localTip, remoteTip, baseTip, upstream, moreCommitsAvailable, statsByHash, messageByHash, detail, detailCollapsed, settings,
	onToggleSection, onToggleChange, onOpenDiff, onToggleCommit, onLoadMore, onContextMenu, onHoverCommit,
	translatedByHash, translatedFromByHash, translatingHash, translateReady, onTranslateCommit, onCancelTranslateCommit,
	graphTranslated, graphTranslating, onTranslateVisible, onCancelTranslate,
	onOpenFilter, filterSummary, filterActive, onGoToHead, onFetch, onRefresh, onResizeStart, formatDate, formatDetail, issueLinking,
}: GraphSectionProps): React.ReactElement {
	// 当前可见窗口内的提交；由提交图上报，标题栏的批量翻译据此下发。
	const [visible, setVisible] = React.useState<readonly { hash: string; text: string }[]>([]);
	/*
	 * 标题栏入口与提交信息框同一判据：翻译服务可用、可见窗口内有非当前语言的标题。
	 *
	 * 已翻译或正在翻译时一律保留：进行中隐藏会让按钮在点击后消失，进度与取消都无处可点。
	 */
	const visibleTranslatable = visible.some((item) => needsTranslation(item.text, interfaceLanguage()));
	const showGraphTranslate = translateReady && (graphTranslated || graphTranslating !== null || visibleTranslatable);
	const translating = graphTranslating !== null;
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
				refreshButton(busy.read, onRefresh),
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
					onSelect: (hash: string, additive?: boolean) => { onToggleCommit(hash, additive); },
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
					renderDetail: ({ commit }: { commit: Commit }) => (detail !== null && detail.commit.hash === commit.hash
						? React.createElement(
							React.Fragment,
							null,
							// 对比模式在文件列表前标出方向：旧 → 新。
							detail.compareWith !== null
								? React.createElement('div', { className: css.detailCompare },
									`对比 ${detail.compareWith.hash.slice(0, 7)} → ${commit.hash.slice(0, 7)}`)
								// 未进入对比时提示入口：按住修饰键点击另一提交即可对比。
								: React.createElement('div', { className: css.detailCompareHint },
									`按住 ${COMPARE_MODIFIER} 点击另一个提交可对比两者`),
							React.createElement(CommitDetail, {
								files: detail.files,
								busy: busy.read,
								loading: detail.loading,
								collapsed: detailCollapsed,
								onToggle: (path: string) => { onToggleChange('detail', path); },
								// 对比模式下新增文件仍有可比差异（旧侧为空），不按普通文件打开。
								onOpen: (path: string, isNew: boolean) => { void onOpenDiff(commit.hash, path, false, detail.compareWith === null && isNew, detail.compareWith?.hash); },
							}),
						)
						: null),
				}))
		),
	);
}
