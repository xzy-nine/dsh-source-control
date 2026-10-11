/**
 * Git Graph 面板主体：顶部工具栏、存储库区、变更区（提交框）、提交图。
 *
 * 布局对齐 VS Code 的「源代码管理 + 图形」视图，控件使用 DSH 的
 * ui-primitives，因此外观与 Harness 本身一致。
 */
import React from 'react';
import {
	Button, Checkbox, FileTypeIcon, Input,
	IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
	IconCloseOutlineRegular, IconCompareSplitOutlineRegular, IconPlusOutlineRegular,
	IconRefreshOutlineRegular, IconSettingsOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
	commitStaged, discardPaths, fetchRepo, loadCommitFiles, loadGraph, loadWorkingTree, pushBranch, stagePaths, unstagePaths,
} from './api.js';
import { CommitGraph } from './graph.js';

/** 变更条目的展示信息：状态字符与是否已暂存。 */
function changeOf(entry) {
	const indexStatus = entry.index;
	const worktreeStatus = entry.worktree;
	const staged = indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '';
	// 展示用状态：已暂存看索引列，未暂存看工作区列。
	const type = staged ? indexStatus : (worktreeStatus === '?' ? 'U' : worktreeStatus);
	const untracked = indexStatus === '?' && worktreeStatus === '?';
	return { staged, type, untracked };
}

/** 拆分路径为「目录 + 文件名」，用于右侧对齐显示。 */
function splitPath(path) {
	const at = path.lastIndexOf('/');
	return at === -1 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/**
 * 相对时间文本。
 *
 * @param unixSeconds - 提交时间（秒）。
 * @returns 中文相对时间。
 */
function relativeLabel(unixSeconds) {
	const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
	if (diff < 60) return '刚刚';
	if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
	if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
	if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
	if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} 个月前`;
	return `${Math.floor(diff / (86400 * 365))} 年前`;
}

/**
 * 一条变更行。
 *
 * @param props.entry - 工作区条目。
 * @param props.busy - 是否正在执行操作。
 * @param props.onStage - 暂存。
 * @param props.onUnstage - 取消暂存。
 * @param props.onDiscard - 丢弃。
 * @param props.onOpen - 打开该文件的差异。
 * @returns 行元素。
 */
function ChangeRow({ entry, busy, onStage, onUnstage, onDiscard, onOpen }) {
	const { staged, type, untracked } = changeOf(entry);
	const { dir, name } = splitPath(entry.path);
	return React.createElement(
		'div',
		{ className: 'ggg-change', title: entry.path },
		React.createElement(FileTypeIcon, { path: name, size: 14 }),
		React.createElement('span', { className: 'ggg-status', 'data-type': type }, type),
		React.createElement('span', { className: 'ggg-change-name' },
			React.createElement('span', { className: 'ggg-change-dir' }, dir),
			name,
		),
		React.createElement('button', {
			type: 'button', className: 'ggg-change-btn', title: '打开差异', disabled: busy,
			onClick: () => onOpen(entry),
		}, React.createElement(IconCompareSplitOutlineRegular, { size: 14 })),
		staged
			? React.createElement('button', {
				type: 'button', className: 'ggg-change-btn', title: '取消暂存', disabled: busy,
				onClick: () => onUnstage([entry.path]),
			}, React.createElement(IconCloseOutlineRegular, { size: 14 }))
			: React.createElement(
				React.Fragment,
				null,
				React.createElement('button', {
					type: 'button', className: 'ggg-change-btn', title: '丢弃改动', disabled: busy,
					onClick: () => onDiscard([entry.path], untracked),
				}, React.createElement(IconTrashOutlineRegular, { size: 14 })),
				React.createElement('button', {
					type: 'button', className: 'ggg-change-btn', title: '暂存改动', disabled: busy,
					onClick: () => onStage([entry.path]),
				}, React.createElement(IconPlusOutlineRegular, { size: 14 })),
			),
	);
}

/**
 * Git Graph 面板。
 *
 * @param props.sessionId - 会话 id。
 * @param props.cwd - 会话工作区路径；没有工作区时为 undefined。
 * @param props.useSessions - 会话快照 hook。
 * @param props.onOpenDiff - 打开文件差异（打开右侧栏 Diff 页）。
 * @returns 面板元素。
 */
export function GitGraphPanel({ cwd, onOpenDiff }) {
	const [state, setState] = React.useState({
		phase: 'loading', error: null, commits: [], head: null, more: false,
		entries: [], selectedHash: null, detail: null, busy: false,
	});
	const [message, setMessage] = React.useState('');
	const [amend, setAmend] = React.useState(false);
	const [maxCommits, setMaxCommits] = React.useState(200);

	const workingTreePath = cwd ?? null;

	/** 重新加载提交图与工作区。 */
	const refresh = React.useCallback(async () => {
		if (workingTreePath === null) {
			setState((previous) => ({ ...previous, phase: 'no-workspace', error: null }));
			return;
		}
		setState((previous) => ({ ...previous, phase: 'loading', error: null }));
		try {
			const [graph, entries] = await Promise.all([
				loadGraph(workingTreePath, maxCommits),
				loadWorkingTree(workingTreePath),
			]);
			setState((previous) => ({
				...previous, phase: 'ready', error: null,
				commits: graph.commits, head: graph.head, more: graph.moreCommitsAvailable, entries,
			}));
		} catch (error) {
			setState((previous) => ({ ...previous, phase: 'error', error: error instanceof Error ? error.message : String(error) }));
		}
	}, [workingTreePath, maxCommits]);

	React.useEffect(() => { void refresh(); }, [refresh]);

	/** 执行一次工作区操作并刷新。 */
	const run = React.useCallback(async (operation) => {
		if (workingTreePath === null) return;
		setState((previous) => ({ ...previous, busy: true }));
		try {
			await operation();
			await refresh();
		} catch (error) {
			setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
		} finally {
			setState((previous) => ({ ...previous, busy: false }));
		}
	}, [workingTreePath, refresh]);

	/** 打开某个提交或工作区文件的差异。 */
	const openDiff = React.useCallback(async (hash, path, staged) => {
		const diff = hash === '*'
			? { kind: 'worktree', path, staged, untracked: false, repoRoot: workingTreePath }
			: { kind: 'commit', hash: hash.slice(0, 8), hashFull: hash, subject: `${hash.slice(0, 7)} ${path}`, path, repoRoot: workingTreePath };
		if (typeof onOpenDiff === 'function') onOpenDiff({ id: `gg-diff:${hash}:${path}:${staged ? 's' : 'u'}`, type: 'diff', title: path.split('/').pop() ?? 'Diff', diff });
	}, [onOpenDiff, workingTreePath]);

	/** 选中一个提交，并加载其改动文件。 */
	const selectCommit = React.useCallback(async (hash) => {
		setState((previous) => ({ ...previous, selectedHash: hash, detail: null }));
		if (workingTreePath === null) return;
		try {
			const commit = state.commits.find((item) => item.hash === hash);
			setState((previous) => ({
				...previous,
				detail: commit === undefined ? null : { commit, files: [] },
			}));
			// `*` 是移植版插入的未提交变更伪提交，没有可读取的提交对象。
			if (hash === '*') {
				const files = state.entries.map((entry) => ({ path: entry.path, type: changeOf(entry).type, additions: null, deletions: null }));
				setState((previous) => (previous.selectedHash === hash && previous.detail !== null
					? { ...previous, detail: { ...previous.detail, files } }
					: previous));
				return;
			}
			const files = await loadCommitFiles(workingTreePath, hash);
			setState((previous) => (previous.selectedHash === hash && previous.detail !== null
				? { ...previous, detail: { ...previous.detail, files } }
				: previous));
		} catch (error) {
			setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
		}
	}, [workingTreePath, state.commits, state.entries]);

	const stagedPaths = state.entries.filter((entry) => changeOf(entry).staged).map((entry) => entry.path);
	const unstaged = state.entries.filter((entry) => !changeOf(entry).staged);
	const repoName = workingTreePath === null ? '' : (workingTreePath.split(/[\\/]/).filter(Boolean).pop() ?? workingTreePath);

	if (state.phase === 'no-workspace') {
		return React.createElement('div', { className: 'ggg-empty' }, '该会话没有工作区目录');
	}

	/** 提交暂存区。 */
	const submit = () => {
		if (message.trim() === '' || stagedPaths.length === 0) return;
		void run(async () => {
			await commitStaged(workingTreePath, message, amend);
			setMessage('');
			setAmend(false);
		});
	};

	return React.createElement(
		'div',
		{ className: 'ggg-root' },
		// ── 工具栏 ──────────────────────────────────────────────
		React.createElement(
			'div',
			{ className: 'ggg-bar' },
			React.createElement(Button, {
				variant: 'toolbar', size: 'sm', title: '刷新', disabled: state.busy,
				onClick: () => { void run(() => refresh()); },
			}, React.createElement(IconRefreshOutlineRegular, { size: 15 })),
			React.createElement(Button, {
				variant: 'toolbar', size: 'sm', title: '抓取', disabled: state.busy,
				onClick: () => { void run(async () => { await fetchRepo(workingTreePath, null); }); },
			}, React.createElement(IconChevronDownOutlineRegular, { size: 15 })),
			React.createElement(Button, {
				variant: 'toolbar', size: 'sm', title: '推送当前分支', disabled: state.busy || state.head === null,
				onClick: () => { void run(async () => { await pushBranch(workingTreePath, state.head, []); }); },
			}, React.createElement(IconBranchOutlineRegular, { size: 15 })),
			React.createElement('span', { className: 'ggg-bar-spacer' }),
			React.createElement(Button, {
				variant: 'toolbar', size: 'sm', title: '重新加载', disabled: state.busy,
				onClick: () => { void refresh(); },
			}, React.createElement(IconSettingsOutlineRegular, { size: 15 })),
		),
		state.error !== null && React.createElement('div', { className: 'ggg-error' }, state.error),

		// ── 存储库 ──────────────────────────────────────────────
		React.createElement(
			'div',
			{ className: 'ggg-sec' },
			React.createElement('div', { className: 'ggg-sec-head' },
				React.createElement(IconChevronDownOutlineRegular, { size: 14 }),
				'存储库',
			),
			React.createElement(
				'div',
				{ className: 'ggg-repos' },
				React.createElement(
					'div',
					{ className: 'ggg-repo is-active' },
					React.createElement(FileTypeIcon, { path: repoName, size: 14 }),
					React.createElement('span', { className: 'ggg-repo-name' }, repoName),
					React.createElement('span', { className: 'ggg-repo-branch' }, state.head ?? ''),
				),
			),
		),

		// ── 变更 ────────────────────────────────────────────────
		React.createElement(
			'div',
			{ className: 'ggg-sec' },
			React.createElement(
				'div',
				{ className: 'ggg-sec-head' },
				React.createElement(IconChevronDownOutlineRegular, { size: 14 }),
				'更改',
				React.createElement('span', { className: 'ggg-count' }, String(state.entries.length)),
				React.createElement(
					'span',
					{ className: 'ggg-head-actions' },
					state.entries.length > 0 && React.createElement(Button, {
						variant: 'toolbar', size: 'sm', title: '全部丢弃', disabled: state.busy,
						onClick: () => { void run(async () => { await discardPaths(workingTreePath, state.entries.map((entry) => entry.path), false); }); },
					}, React.createElement(IconTrashOutlineRegular, { size: 14 })),
					React.createElement(Button, {
						variant: 'toolbar', size: 'sm', title: '全部暂存', disabled: state.busy || state.entries.length === 0,
						onClick: () => { void run(async () => { await stagePaths(workingTreePath, []); }); },
					}, React.createElement(IconPlusOutlineRegular, { size: 14 })),
				),
			),
			state.entries.length === 0
				? React.createElement('div', { className: 'ggg-empty' }, '工作区没有未提交的变更')
				: React.createElement(
					'div',
					{ className: 'ggg-changes' },
					...state.entries.map((entry) => React.createElement(ChangeRow, {
						key: entry.path, entry, busy: state.busy,
						onStage: (paths) => { void run(async () => { await stagePaths(workingTreePath, paths); }); },
						onUnstage: (paths) => { void run(async () => { await unstagePaths(workingTreePath, paths); }); },
						onDiscard: (paths, untracked) => { void run(async () => { await discardPaths(workingTreePath, paths, untracked); }); },
						onOpen: (item) => { void openDiff('*', item.path, changeOf(item).staged); },
					})),
				),
			// ── 提交框 ────────────────────────────────────────────
			React.createElement(
				'div',
				{ className: 'ggg-commit-box' },
				React.createElement(Input, {
					value: message,
					placeholder: state.head === null ? '提交信息（Ctrl+Enter 提交）' : `提交信息（Ctrl+Enter 在“${state.head}”上提交）`,
					disabled: state.busy,
					onChange: (event) => setMessage(event.target.value),
					onKeyDown: (event) => {
						if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
					},
				}),
				React.createElement(Checkbox, { checked: amend, onChange: setAmend, label: '修补上一次提交' }),
				React.createElement(Button, {
					variant: 'primary', size: 'sm', disabled: state.busy || message.trim() === '' || stagedPaths.length === 0,
					onClick: submit,
				}, React.createElement(IconCheckOutlineRegular, { size: 15 }), `提交（${stagedPaths.length}）`),
			),
		),

		// ── 图形 ────────────────────────────────────────────────
		state.phase === 'loading' && state.commits.length === 0
			? React.createElement('div', { className: 'ggg-empty' }, '正在加载提交图…')
			: React.createElement(CommitGraph, {
				commits: state.commits,
				head: state.head,
				selectedHash: state.selectedHash,
				onSelect: (hash) => { void selectCommit(hash); },
				onLoadMore: () => setMaxCommits((previous) => previous + 200),
				moreCommitsAvailable: state.more,
				relativeLabel,
			}),
		state.detail !== null && React.createElement(
			'div',
			{ className: 'ggg-detail' },
			React.createElement('div', { className: 'ggg-detail-title' }, state.detail.commit.message),
			React.createElement('div', { className: 'ggg-detail-meta' },
				`${state.detail.commit.hash.slice(0, 8)} · ${state.detail.commit.author}`,
			),
			...(state.detail.commit.parents ?? []).length > 0
				? [React.createElement('div', { key: 'parents', className: 'ggg-detail-meta' },
					`父提交：${state.detail.commit.parents.map((parent) => parent.slice(0, 8)).join('、')}`)]
				: [],
			...state.detail.files.map((file) => React.createElement(
				'div',
				{ key: file.path, className: 'ggg-change' },
				React.createElement(FileTypeIcon, { path: file.path.split('/').pop() ?? file.path, size: 13 }),
				React.createElement('span', { className: 'ggg-status', 'data-type': file.type }, file.type),
				React.createElement('span', { className: 'ggg-change-name' }, file.path),
				React.createElement(Button, {
					variant: 'toolbar', size: 'sm', title: '打开差异', disabled: state.busy,
					onClick: () => { void openDiff(state.detail.commit.hash, file.path, false); },
				}, React.createElement(IconCompareSplitOutlineRegular, { size: 13 })),
			)),
			state.detail.files.length === 0 && React.createElement('div', { className: 'ggg-hint' }, '正在加载改动文件…'),
		),
	);
}
