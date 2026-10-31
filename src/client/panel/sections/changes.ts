/**
 * 更改分区：提交框 + 变更列表。
 *
 * 只接收已算好的数据与回调，状态与数据加载由面板主体持有。
 */
import React from 'react';
import {
	Button, Checkbox, IconArchiveOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
	IconCloseOutlineRegular, IconSparkleRegular, FileTypeIcon, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { PublishIcon, TranslateIcon } from '../../ui/ref-icons.ts';
import { ChangeGroup } from '../changes.ts';
import { anyBusy } from '../busy.ts';
import { commitButtonDisabledOf } from '../submit-state.ts';
import type { AiStats, BusyFlags, ChangeActions, PanelPhase, WorkingTreeEntry } from '../../shared/types.ts';
import { refreshButton } from './refresh-button.ts';
import css from '../../css/sections.module.css';
import shared from '../../css/shared.module.css';
import { cx } from '../../css/cx.ts';


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
	/** 同步按钮的右键菜单；双向分叉时给出覆盖入口，其余情形为 undefined。 */
	readonly onSyncContextMenu?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
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
	/** 工作区快照是否正在后台刷新；标题栏据此给出进行中指示。 */
	readonly refreshing: boolean;
	/** 「上次刷新」文案；为空串时不显示。 */
	readonly lastRefresh: string;
}

/** 提交框的属性：更改分区属性中与提交信息、AI 与主按钮有关的部分。 */
export type CommitBoxProps = Pick<ChangesSectionProps,
	| 'entries' | 'busy' | 'phase' | 'head' | 'message' | 'onMessageChange' | 'amend' | 'onToggleAmend'
	| 'hooksActive' | 'runHooks' | 'onToggleRunHooks' | 'onStash' | 'onAbortMerge'
	| 'showTranslate' | 'translateBusy' | 'onTranslate' | 'aiBusy' | 'aiWarning' | 'aiStats' | 'onAiCommit'
	| 'showSyncButton' | 'syncBehind' | 'syncAhead' | 'onSync' | 'showPublishButton' | 'onPublish'
	| 'canSubmit' | 'onSubmit' | 'hasLocalExclude' | 'onShowLocalExclude' | 'merging' | 'onSyncContextMenu'>;

/**
 * 提交框：提交信息、AI 入口与主按钮；只随这些属性重渲染。
 *
 * @param props - 见 {@link CommitBoxProps}。
 * @returns 提交框元素。
 */
function CommitBoxView({
	entries, busy, phase, head, message, onMessageChange, amend, onToggleAmend, hooksActive, runHooks, onToggleRunHooks,
	onStash, onAbortMerge, showTranslate, translateBusy, onTranslate, aiBusy, aiWarning, aiStats, onAiCommit,
	showSyncButton, syncBehind, syncAhead, onSync, showPublishButton, onPublish, canSubmit, onSubmit,
	hasLocalExclude, onShowLocalExclude, merging, onSyncContextMenu,
}: CommitBoxProps): React.ReactElement {
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
		{ className: css.commitBox },
		(aiBusy || anyBusy(busy) || phase === 'loading') && React.createElement('div', { className: css.aiLoadingBar }),
		React.createElement('div', { className: css.commitInputWrap },
			React.createElement('textarea', {
				className: css.commitInput,
				placeholder: aiBusy ? 'AI 正在生成…' : '提交变更内容(Ctrl+Enter 在 ' + (head ?? 'master') + '提交)',
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
		merging && React.createElement('div', { className: css.mergeHint }, '合并中：提交即结束合并，提交信息留空时沿用 git 生成的合并信息。'),
		aiStats !== null && React.createElement('div', { className: css.commitAiStats },
			String(aiStats.tps) + ' tok/s',
			' · 输入 ' + String(aiStats.inputTokens),
			' · 输出 ' + String(aiStats.outputTokens),
			' · 缓存读 ' + String(aiStats.cacheReadTokens),
			' · 缓存写 ' + String(aiStats.cacheWriteTokens),
			' · ' + aiStats.elapsed + '+' + aiStats.ttft,
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
				onClick: onSync, onContextMenu: onSyncContextMenu,
			}, '同步更改',
				syncBehind > 0 && React.createElement('span', null, ' ↓' + String(syncBehind)),
				syncAhead > 0 && React.createElement('span', null, ' ↑' + String(syncAhead)),
			)
			: showPublishButton
				? React.createElement(Button, {
					variant: 'primary', size: 'sm', disabled: busy.network,
					title: '把当前分支推送到远程并建立跟踪',
					onClick: onPublish,
				}, React.createElement(PublishIcon), '发布')
				: React.createElement(Button, {
					variant: 'primary', size: 'sm',
					disabled: commitButtonDisabledOf({ busy: busy.commit, canSubmit, messageEmpty: message.trim() === '', merging }),
					onClick: onSubmit,
				}, React.createElement(IconCheckOutlineRegular, { size: 15 }), '提交 Ctrl+Enter'),
	);
}

const CommitBox = React.memo(CommitBoxView);

/**
 * 更改分区：标题栏 + 提交框 + 变更列表。
 *
 * 提交框与变更列表是两个独立子树：输入提交信息只重渲染提交框，条目与折叠状态变化只重渲染列表。
 *
 * @param props - 见 {@link ChangesSectionProps}。
 * @returns 分区元素。
 */
export function ChangesSection(props: ChangesSectionProps): React.ReactElement {
	const {
		entries, busy, phase, workingTreePath, refreshing, lastRefresh, onRefresh,
		collapsedByGroup, groupExpanded, toggleChange, toggleGroup, run,
		stagePaths, unstagePaths, discardPaths, openDiff, onAddToGitignore, onAddToLocalExclude,
	} = props;
	return React.createElement(
		'div',
		{ className: cx(css.sec, css.workspace) },
		React.createElement(
			'div',
			{ className: css.secHead },
			React.createElement(IconChevronDownOutlineRegular, { size: 14, className: css.chevron }),
			'更改',
			React.createElement(StateDot, { state: refreshing ? 'ongoing' : 'idle', size: 8, className: css.headDot }),
			lastRefresh !== '' && React.createElement('span', { className: css.headRefreshNote }, lastRefresh),
			React.createElement('span', { className: css.headActions },
				refreshButton(busy.read, refreshing, lastRefresh, onRefresh),
			),
		),
		React.createElement(
			'div',
			{ className: css.workspaceBody },
			React.createElement(CommitBox, {
				entries, busy, phase,
				head: props.head, message: props.message, onMessageChange: props.onMessageChange,
				amend: props.amend, onToggleAmend: props.onToggleAmend,
				hooksActive: props.hooksActive, runHooks: props.runHooks, onToggleRunHooks: props.onToggleRunHooks,
				onStash: props.onStash, onAbortMerge: props.onAbortMerge,
				showTranslate: props.showTranslate, translateBusy: props.translateBusy, onTranslate: props.onTranslate,
				aiBusy: props.aiBusy, aiWarning: props.aiWarning, aiStats: props.aiStats, onAiCommit: props.onAiCommit,
				showSyncButton: props.showSyncButton, syncBehind: props.syncBehind, syncAhead: props.syncAhead, onSync: props.onSync,
				showPublishButton: props.showPublishButton, onPublish: props.onPublish,
				canSubmit: props.canSubmit, onSubmit: props.onSubmit,
				hasLocalExclude: props.hasLocalExclude, onShowLocalExclude: props.onShowLocalExclude,
				merging: props.merging, onSyncContextMenu: props.onSyncContextMenu,
			}),
			// 提交框与两个分组分开：提交框固定，只有变更列表滚动。
			React.createElement(
				'div',
				{ className: css.changesScroll },
				/*
				 * 加载占位：切换仓库时条目已清空，快照返回前显示占位，避免空白一片。
				 * 有条目时不显示——刷新期间保留旧数据正是 reconcile 模式的目的。
				 */
				phase === 'loading' && entries.length === 0
					&& React.createElement('div', { className: shared.hint, style: { padding: '12px 10px' } }, '正在读取工作区…'),
				React.createElement(ChangeLists, {
					entries, busy: props.busy, workingTreePath, collapsedByGroup, groupExpanded, toggleChange, toggleGroup, run,
					stagePaths, unstagePaths, discardPaths, openDiff, onAddToGitignore, onAddToLocalExclude,
				}),
			),
		),
	);
}

/** 变更分组列表的属性：更改分区属性中与变更列表有关的部分。 */
export type ChangeListsProps = Pick<ChangesSectionProps,
	| 'entries' | 'busy' | 'workingTreePath' | 'collapsedByGroup' | 'groupExpanded'
	| 'toggleChange' | 'toggleGroup' | 'run' | 'stagePaths' | 'unstagePaths' | 'discardPaths'
	| 'openDiff' | 'onAddToGitignore' | 'onAddToLocalExclude'>;

/**
 * 变更分组列表：两个分组的折叠状态与条目。
 *
 * @param props - 见 {@link ChangeListsProps}。
 * @returns 两个分组元素。
 */
function ChangeListsView({
	entries, busy, workingTreePath, collapsedByGroup, groupExpanded, toggleChange, toggleGroup, run,
	stagePaths, unstagePaths, discardPaths, openDiff, onAddToGitignore, onAddToLocalExclude,
}: ChangeListsProps): React.ReactElement {
	// 已暂存一侧有条目时，未暂存分组即使为空也显示：折叠标题上的分组菜单仍需可达。
	const forceShow = React.useMemo(
		() => entries.some((entry) => entry.index !== ' ' && entry.index !== '?'),
		[entries],
	);
	const toggleStaged = React.useCallback(() => { toggleGroup('staged'); }, [toggleGroup]);
	const toggleUnstaged = React.useCallback(() => { toggleGroup('unstaged'); }, [toggleGroup]);
	return React.createElement(
		React.Fragment,
		null,
		React.createElement(ChangeGroup, {
			staged: true, entries, busy: busy.commit, workingTreePath: workingTreePath as string,
			groupKey: 'staged', collapsed: collapsedByGroup.staged, toggleChange,
			open: groupExpanded.staged, onToggleGroup: toggleStaged,
			run, stagePaths, unstagePaths, discardPaths, openDiff,
			onAddToGitignore, onAddToLocalExclude,
		}),
		React.createElement(ChangeGroup, {
			staged: false, entries, busy: busy.commit, workingTreePath: workingTreePath as string,
			groupKey: 'unstaged', collapsed: collapsedByGroup.unstaged, toggleChange,
			open: groupExpanded.unstaged, onToggleGroup: toggleUnstaged,
			run, stagePaths, unstagePaths, discardPaths, openDiff,
			onAddToGitignore, onAddToLocalExclude,
			forceShow,
		}),
	);
}

const ChangeLists = React.memo(ChangeListsView);