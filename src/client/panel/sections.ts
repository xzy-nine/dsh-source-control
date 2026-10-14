/**
 * 面板的三个分区：存储库、更改（含提交框）、图形。
 *
 * 每个分区只接收已算好的数据与回调，状态与数据加载由面板主体持有。
 */
import React from 'react';
import {
	Button, Checkbox, FileTypeIcon, IconArchiveOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
	IconDownloadOutlineRegular, IconGoalOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
	IconSettingsOutlineRegular, IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { CommitGraph } from '../graph.ts';
import { PublishIcon, RepoIcon, TranslateIcon } from '../ref-icons.ts';
import { GitGraphIcon } from '../plugin-icon.ts';
import { ChangeGroup, CommitDetail } from './changes.ts';
import { RepoRow } from './repo-row.ts';
import type {
	AiStats, Commit, CommitFile, CommitStats, PanelPhase, RepoNode, RepoSync, Settings, WorkingTreeEntry,
} from '../types.ts';
import css from '../css/sections.module.css';
import shared from '../css/shared.module.css';
import { cx } from '../css/cx.ts';

/** 进入提交对比用的修饰键名，按平台显示：macOS 用 ⌘、其余用 Ctrl。 */
const COMPARE_MODIFIER = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent ?? '')
	? '⌘'
	: 'Ctrl';

/** 存储库分区。 */
export interface RepoSectionProps {
	readonly open: boolean;
	readonly height: number;
	readonly busy: boolean;
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
					type: 'button', className: css.iconBtn, title: '克隆远程仓库', disabled: busy || cloneBusy,
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onClone(); },
				}, React.createElement(IconPlusOutlineRegular, { size: 14 })),
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '设置', disabled: busy,
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
export interface ChangesSectionProps {
	readonly entries: readonly WorkingTreeEntry[];
	readonly busy: boolean;
	readonly phase: PanelPhase;
	readonly workingTreePath: string | null;
	readonly head: string | null;
	readonly message: string;
	readonly onMessageChange: (message: string) => void;
	readonly amend: boolean;
	readonly onToggleAmend: (checked: boolean) => void;
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
	readonly stagedPaths: readonly string[];
	readonly onSubmit: () => void;
	readonly onRefresh: () => void;
	readonly collapsedByGroup: { staged: ReadonlySet<string>; unstaged: ReadonlySet<string> };
	readonly groupExpanded: { staged: boolean; unstaged: boolean };
	readonly toggleChange: (key: string, path: string) => void;
	readonly toggleGroup: (key: string) => void;
	readonly run: (operation: () => Promise<void>) => Promise<void>;
	readonly stagePaths: (cwd: string, paths: readonly string[]) => Promise<unknown>;
	readonly unstagePaths: (cwd: string, paths: readonly string[]) => Promise<unknown>;
	readonly discardPaths: (cwd: string, paths: readonly string[], untracked: boolean) => Promise<unknown>;
	readonly openDiff: (hash: string, path: string, staged: boolean, isNew?: boolean) => Promise<void>;
	/** 把未暂存的路径加入 .gitignore。 */
	readonly onAddToGitignore: (path: string) => void;
	/** 把未暂存的路径加入本地排除文件。 */
	readonly onAddToLocalExclude: (path: string) => void;
	/** 当前工作树是否有本地排除条目；有才显示查看入口。 */
	readonly hasLocalExclude: boolean;
	/** 查看本地排除的条目。 */
	readonly onShowLocalExclude: () => void;
}

/**
 * 更改分区：标题栏 + 提交框 + 两个变更分组。
 *
 * @param props - 见 {@link ChangesSectionProps}。
 * @returns 分区元素。
 */
export function ChangesSection({
	entries, busy, phase, workingTreePath, head, message, onMessageChange, amend, onToggleAmend, onStash,
	showTranslate, translateBusy, onTranslate,
	aiBusy, aiWarning, aiStats, onAiCommit, showSyncButton, syncBehind, syncAhead, onSync,
	showPublishButton, onPublish,
	stagedPaths, onSubmit, onRefresh, collapsedByGroup, groupExpanded, toggleChange, toggleGroup, run,
	stagePaths, unstagePaths, discardPaths, openDiff,
	onAddToGitignore, onAddToLocalExclude, hasLocalExclude, onShowLocalExclude,
}: ChangesSectionProps): React.ReactElement {
	return React.createElement(
		'div',
		{ className: cx(css.sec, css.workspace) },
		React.createElement(
			'div',
			{ className: css.secHead },
			React.createElement(IconChevronDownOutlineRegular, { size: 14, className: css.chevron }),
			'更改',
			React.createElement('span', { className: css.headActions },
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '刷新', disabled: busy,
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onRefresh(); },
				}, React.createElement(IconRefreshOutlineRegular, { size: 14 })),
			),
		),
		React.createElement(
			'div',
			{ className: css.workspaceBody },
			// ── 提交框 ────────────────────────────────────────
			React.createElement(
				'div',
				{ className: css.commitBox },
				(aiBusy || busy || phase === 'loading') && React.createElement('div', { className: css.aiLoadingBar }),
				React.createElement('div', { className: css.commitInputWrap },
					React.createElement('textarea', {
						className: css.commitInput,
						placeholder: aiBusy ? 'AI 正在生成…' : `提交变更内容(Ctrl+Enter 在 '${head ?? 'master'}'提交)`,
						value: message,
						disabled: aiBusy,
						onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onMessageChange(event.currentTarget.value),
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
							disabled: aiBusy || busy,
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
					React.createElement(Checkbox, { checked: amend, onChange: onToggleAmend, label: '修补上一次提交' }),
					React.createElement('span', { className: css.commitActionsRight },
						// 本地排除有内容时给出打开入口：图标取 .gitignore 的文件图标。
						hasLocalExclude && React.createElement(Button, {
							variant: 'ghost', size: 'sm', disabled: busy,
							className: css.stashBtn, onClick: onShowLocalExclude,
							title: '打开本地排除文件', 'aria-label': '本地排除',
						}, React.createElement(FileTypeIcon, { path: '.gitignore', size: 14 })),
						// AI 生成的内容不是当前语言时提供翻译：仅图标，贴在贮藏左侧。
						showTranslate && React.createElement(Button, {
							variant: 'ghost', size: 'sm', disabled: translateBusy,
							className: css.stashBtn, onClick: onTranslate,
							title: '把提交信息翻译为当前语言', 'aria-label': '翻译',
						}, React.createElement(TranslateIcon)),
						React.createElement(Button, {
							variant: 'ghost', size: 'sm', disabled: busy || entries.length === 0,
							className: css.stashBtn, onClick: onStash, title: '把当前改动存入贮藏',
						}, React.createElement(IconArchiveOutlineRegular, { size: 14 }), '贮藏'),
					),
				),
				showSyncButton
					? React.createElement(Button, {
						variant: 'primary', size: 'sm', disabled: busy,
						onClick: onSync,
					}, '同步更改',
						syncBehind > 0 && React.createElement('span', null, ` ↓${syncBehind}`),
						syncAhead > 0 && React.createElement('span', null, ` ↑${syncAhead}`),
					)
					: showPublishButton
						? React.createElement(Button, {
							variant: 'primary', size: 'sm', disabled: busy,
							title: '把当前分支推送到远程并建立跟踪',
							onClick: onPublish,
						}, React.createElement(PublishIcon), '发布')
						: React.createElement(Button, {
							variant: 'primary', size: 'sm', disabled: busy || message.trim() === '' || stagedPaths.length === 0,
							onClick: onSubmit,
						}, React.createElement(IconCheckOutlineRegular, { size: 15 }), '提交 Ctrl+Enter'),
			),
			// 提交框与两个分组分开：提交框固定，只有变更列表滚动。
			React.createElement(
				'div',
				{ className: css.changesScroll },
				ChangeGroup({
					staged: true, entries, busy, workingTreePath: workingTreePath as string,
					groupKey: 'staged', collapsed: collapsedByGroup.staged, toggleChange, open: groupExpanded.staged, onToggleGroup: () => toggleGroup('staged'),
					run, stagePaths, unstagePaths, discardPaths, openDiff,
					onAddToGitignore, onAddToLocalExclude,
				}),
				ChangeGroup({
					staged: false, entries, busy, workingTreePath: workingTreePath as string,
					groupKey: 'unstaged', collapsed: collapsedByGroup.unstaged, toggleChange, open: groupExpanded.unstaged, onToggleGroup: () => toggleGroup('unstaged'),
					run, stagePaths, unstagePaths, discardPaths, openDiff,
					onAddToGitignore, onAddToLocalExclude,
					forceShow: entries.some((e) => e.index !== ' ' && e.index !== '?'),
				}),
			),
		),
	);
}

/** 图形分区。 */
export interface GraphSectionProps {
	readonly open: boolean;
	readonly height: number;
	readonly busy: boolean;
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
	/** 上游远程跟踪分支名，决定泳道引用色。 */
	readonly upstream: string | null;
	readonly moreCommitsAvailable: boolean;
	readonly statsByHash: ReadonlyMap<string, CommitStats>;
	/** 提交哈希 -> 完整提交信息；悬停时按需取回。 */
	readonly messageByHash: ReadonlyMap<string, string>;
	readonly detail: { commit: Commit; files: CommitFile[]; compareWith: Commit | null } | null;
	readonly detailCollapsed: ReadonlySet<string>;
	readonly settings: Settings;
	readonly onToggleSection: () => void;
	readonly onToggleChange: (key: string, path: string) => void;
	readonly onOpenDiff: (hash: string, path: string, staged: boolean, isNew?: boolean, baseHash?: string) => Promise<void>;
	readonly onToggleCommit: (hash: string, additive?: boolean) => void;
	readonly onLoadMore: () => void;
	readonly onContextMenu: (args: { commit: Commit; refInfo: { type: string | null; name: string | null } | null; event: React.MouseEvent<HTMLElement> }) => void;
	readonly onHoverCommit: (hash: string | null) => void;
	readonly onOpenFilter: () => void;
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
	localTip, remoteTip, upstream, moreCommitsAvailable, statsByHash, messageByHash, detail, detailCollapsed, settings,
	onToggleSection, onToggleChange, onOpenDiff, onToggleCommit, onLoadMore, onContextMenu, onHoverCommit,
	onOpenFilter, onGoToHead, onFetch, onRefresh, onResizeStart, formatDate, formatDetail, issueLinking,
}: GraphSectionProps): React.ReactElement {
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
			React.createElement('span', { className: css.headActions },
				selectedNode !== null && React.createElement('span', { className: css.headRepo },
					React.createElement(RepoIcon),
					React.createElement('span', null, selectedNode.name),
				),
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '筛选分支与标签',
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onOpenFilter(); },
				}, React.createElement(GitGraphIcon, { size: 14 }), '分支'),
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '转到当前历史记录',
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onGoToHead(); },
				}, React.createElement(IconGoalOutlineRegular, { size: 14 })),
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '从所有远程抓取', disabled: busy,
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onFetch(); },
				}, React.createElement(IconDownloadOutlineRegular, { size: 14 })),
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '刷新', disabled: busy,
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onRefresh(); },
				}, React.createElement(IconRefreshOutlineRegular, { size: 14 })),
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
								busy,
								collapsed: detailCollapsed,
								onToggle: (path: string) => onToggleChange('detail', path),
								// 对比模式下新增文件仍有可比差异（旧侧为空），不按普通文件打开。
								onOpen: (path: string, isNew: boolean) => { void onOpenDiff(commit.hash, path, false, detail.compareWith === null && isNew, detail.compareWith?.hash); },
							}),
						)
						: null),
				}))
		),
	);
}
