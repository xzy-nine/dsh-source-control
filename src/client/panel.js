/**
 * Git Graph 面板主体：顶部工具栏、存储库区、变更区（提交框）、提交图。
 *
 * 布局对齐 VS Code 的「源代码管理 + 图形」视图，控件使用 DSH 的
 * ui-primitives，因此外观与 Harness 本身一致。提交图与分支、远程、
 * 标签、贮藏的右键菜单在此组装，并把动作串到宿主后端（api.js）。
 */
import React from 'react';
import {
	Button, Checkbox, FileTypeIcon, Input,
	IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
	IconCloseOutlineRegular, IconCompareSplitOutlineRegular, IconDownloadOutlineRegular,
	IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSettingsOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
	defaultSettings, formatDate, loadSettings, saveSettings, SettingsPanel,
} from './settings.js';
import {
	addTag, applyStash, branchFromStash, checkoutBranch, checkoutCommit, cherrypickCommit,
	commitStaged, createBranch, deleteBranch, deleteRemote, deleteRemoteBranch, deleteTag,
	discardPaths, dropStash, fetchIntoLocalBranch, fetchRepo, loadCommitFiles,
	loadGraph, loadWorkingTree, merge, popStash, pushBranch, pushStash, pushTag,
	rebase, renameBranch, resetToCommit, revertCommit, stagePaths, unstagePaths,
} from './api.js';
import { CommitGraph } from './graph.js';
import { copyText, showContextMenu } from './context-menu.js';
import {
	showCheckbox, showConfirmation, showSelect, showText,
} from './dialog.js';

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
 * 把错误文本显示在面板上。
 *
 * @param {object} state - 面板状态。
 * @param {function} setState - 状态更新。
 * @param {string|null} error - 错误文本；null 表示清除。
 * @returns 无。
 */
function reportError(setState, error) {
	setState((previous) => ({ ...previous, error }));
}

/** 提交信息中的 Issue 是否开启链接（依赖设置）。 */
function issueLinkingConfigOf(settings) {
	return settings.issueLinkingConfig ?? null;
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
 * @param props.cwd - 会话工作区路径；没有工作区时为 undefined。
 * @param props.onOpenDiff - 打开文件差异（打开右侧栏 Diff 页）。
 * @returns 面板元素。
 */
export function GitGraphPanel({ cwd, onOpenDiff }) {
	const [state, setState] = React.useState({
		phase: 'loading', error: null, commits: [], head: null, more: false,
		entries: [], selectedHash: null, detail: null, busy: false, remotes: [],
	});
	const [message, setMessage] = React.useState('');
	const [amend, setAmend] = React.useState(false);
	const [maxCommits, setMaxCommits] = React.useState(200);
	const [settings, setSettings] = React.useState(() => loadSettings());
	const [settingsOpen, setSettingsOpen] = React.useState(false);

	const workingTreePath = cwd ?? null;

	/** 重新加载提交图与工作区。 */
	const refresh = React.useCallback(async () => {
		if (workingTreePath === null) {
			setState((previous) => ({ ...previous, phase: 'no-workspace', error: null }));
			return;
		}
		setState((previous) => ({ ...previous, phase: 'loading', error: null }));
		try {
			const graph = await loadGraph(workingTreePath, {
				maxCommits,
				commitOrdering: settings.commitOrdering,
				showStashes: settings.showStashes,
				showTags: settings.showTags,
				showRemoteBranches: settings.showRemoteBranches,
				onlyFollowFirstParent: settings.onlyFollowFirstParent,
				includeCommitsMentionedByReflogs: settings.includeCommitsMentionedByReflogs,
			});
			const entries = await loadWorkingTree(workingTreePath);
			setState((previous) => ({
				...previous, phase: 'ready', error: null,
				commits: graph.commits, head: graph.head, more: graph.moreCommitsAvailable,
				remotes: graph.remotes, entries,
			}));
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, maxCommits, settings]);

	React.useEffect(() => { void refresh(); }, [refresh]);

	/** 执行一次工作区操作并刷新。 */
	const run = React.useCallback(async (operation) => {
		if (workingTreePath === null) return;
		setState((previous) => ({ ...previous, busy: true, error: null }));
		try {
			await operation();
			await refresh();
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
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
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, state.commits, state.entries]);

	const stagedPaths = state.entries.filter((entry) => changeOf(entry).staged).map((entry) => entry.path);
	const repoName = workingTreePath === null ? '' : (workingTreePath.split(/[\\/]/).filter(Boolean).pop() ?? workingTreePath);

	/** 提交暂存区。 */
	const submit = () => {
		if (message.trim() === '' || stagedPaths.length === 0) return;
		void run(async () => {
			await commitStaged(workingTreePath, message, amend);
			setMessage('');
			setAmend(false);
		});
	};

	/** 写入设置并刷新（排序/显示项变化需要重新拉取提交图）。 */
	const changeSettings = React.useCallback((next) => {
		setSettings(next);
		saveSettings(next);
	}, []);

	/** 删除远程并刷新。 */
	const deleteRemoteByName = React.useCallback((name) => {
		void run(async () => { await deleteRemote(workingTreePath, name); });
	}, [workingTreePath, run]);

	/** 报错提示：依赖 VS Code 的动作在 DSH 中不可用。 */
	const unsupported = React.useCallback(async (label) => {
		reportError(setState, `${label}：DSH 版本暂不支持，请在对应工具中操作`);
		setTimeout(() => reportError(setState, null), 2600);
	}, []);

	/* ── 右键菜单组装 ─────────────────────────────────────────── */

	/** 提交行右键菜单。 */
	const openCommitMenu = React.useCallback(({ commit, event }) => {
		const branchNames = commit.heads ?? [];
		const tagNames = (commit.tags ?? []).map((tag) => tag.name);
		const remoteNames = (commit.remotes ?? []).map((remote) => remote.name);
		const isHead = commit.hash === '*';
		showContextMenu({
			x: event.clientX, y: event.clientY,
			items: [
				{ title: '查看提交', disabled: isHead, onClick: () => { void selectCommit(commit.hash); } },
				{ title: '检出此提交', disabled: isHead, onClick: () => { void run(async () => { await checkoutCommit(workingTreePath, commit.hash); }); } },
				{ type: 'divider' },
				{ title: '从此提交创建分支…', disabled: isHead, onClick: async () => {
					const name = await showText({ title: '从此提交创建分支', label: '新分支名', placeholder: 'feature/xxx' });
					if (name !== null && name !== '') void run(async () => { await createBranch(workingTreePath, name, commit.hash, true); });
				} },
				{ title: '从此提交创建标签…', disabled: isHead, onClick: async () => {
					const name = await showText({ title: '创建标签', label: '标签名', placeholder: 'v1.0.0' });
					if (name !== null && name !== '') void run(async () => { await addTag(workingTreePath, name, commit.hash, 0, '', false, null); });
				} },
				{ title: '从此提交拣选…', disabled: isHead, onClick: () => { void run(async () => { await cherrypickCommit(workingTreePath, commit.hash); }); } },
				{ title: '从此提交还原…', disabled: isHead, onClick: () => { void run(async () => { await revertCommit(workingTreePath, commit.hash); }); } },
				{ type: 'divider' },
				{ title: '重置当前分支到此处…', disabled: isHead, onClick: async () => {
					const mode = await showSelect({
						title: '重置模式', message: '选择重置到该提交的方式', value: 'mixed',
						options: [{ value: 'soft', label: '软' }, { value: 'mixed', label: '混合' }, { value: 'hard', label: '硬' }],
					});
					if (mode === null) return;
					const ok = await showCheckbox({
						title: '重置当前分支', message: `当前分支将重置到 ${commit.hash.slice(0, 7)}（${mode}）。未提交的改动可能丢失。`,
						checkboxLabel: '我已知晓并继续', danger: true,
					});
					if (ok) void run(async () => { await resetToCommit(workingTreePath, commit.hash, mode); });
				} },
				{ title: '合并到当前分支…', disabled: isHead, onClick: async () => {
					const ok = await showConfirmation({ title: '合并提交', message: `把 ${commit.hash.slice(0, 7)} 合并进当前分支？`, confirmLabel: '合并', danger: true });
					if (ok) void run(async () => { await merge(workingTreePath, commit.hash); });
				} },
				{ title: '变基当前分支到此处…', disabled: isHead, onClick: async () => {
					const ok = await showConfirmation({ title: '变基', message: `把当前分支变基到 ${commit.hash.slice(0, 7)}？`, confirmLabel: '变基', danger: true });
					if (ok) void run(async () => { await rebase(workingTreePath, commit.hash); });
				} },
				{ type: 'divider' },
				{ title: '复制哈希', onClick: async () => { await copyText(commit.hash); } },
				{ title: '复制提交信息', onClick: async () => { await copyText(commit.message); } },
			],
		});
	}, [workingTreePath, run, selectCommit]);

	/** 分支标签（head / remote / tag）右键菜单。 */
	const openRefMenu = React.useCallback(({ commit, refInfo, event }) => {
		const x = event.clientX, y = event.clientY;
		if (refInfo.type === 'head') {
			const name = refInfo.name;
			const isCurrent = name === state.head;
			showContextMenu({
				x, y,
				items: [
					{ title: '检出此分支', disabled: isCurrent, onClick: () => { void run(async () => { await checkoutBranch(workingTreePath, name, null); }); } },
					{ title: '从此分支创建新分支…', onClick: async () => {
						const newName = await showText({ title: '创建分支', label: '新分支名', value: name, placeholder: 'feature/xxx' });
						if (newName !== null && newName !== '') void run(async () => { await createBranch(workingTreePath, newName, `refs/heads/${name}`, true); });
					} },
					{ title: '重命名分支…', disabled: isCurrent, onClick: async () => {
						const newName = await showText({ title: '重命名分支', label: '新分支名', value: name });
						if (newName !== null && newName !== '' && newName !== name) void run(async () => { await renameBranch(workingTreePath, name, newName); });
					} },
					{ title: '合并到当前分支…', disabled: isCurrent, onClick: async () => {
						const ok = await showConfirmation({ title: '合并分支', message: `把 ${name} 合并进当前分支？`, confirmLabel: '合并', danger: true });
						if (ok) void run(async () => { await merge(workingTreePath, name); });
					} },
					{ title: '变基当前分支到此处…', disabled: isCurrent, onClick: async () => {
						const ok = await showConfirmation({ title: '变基', message: `把当前分支变基到 ${name}？`, confirmLabel: '变基', danger: true });
						if (ok) void run(async () => { await rebase(workingTreePath, name); });
					} },
					{ type: 'divider' },
					{ title: '复制分支名', onClick: async () => { await copyText(name); } },
					{ title: '在当前分支上删除…', disabled: isCurrent, onClick: async () => {
						const ok = await showCheckbox({
							title: '删除本地分支', message: `确定删除本地分支 ${name}？`, checkboxLabel: '同时强制删除未合并分支', danger: true,
						});
						if (ok) void run(async () => { await deleteBranch(workingTreePath, name, true); });
					} },
				],
			});
			return;
		}
		if (refInfo.type === 'remote') {
			const name = refInfo.name;
			const short = name.replace(/^[^/]+\//, '');
			showContextMenu({
				x, y,
				items: [
					{ title: '检出远程分支…', onClick: async () => {
						const localName = await showText({ title: '检出远程分支', label: '本地分支名', value: short, placeholder: 'feature/xxx' });
						if (localName !== null && localName !== '') void run(async () => { await checkoutBranch(workingTreePath, localName, name); });
					} },
					{ title: '从远程分支创建本地分支…', onClick: async () => {
						const localName = await showText({ title: '创建本地分支', label: '本地分支名', value: short });
						if (localName !== null && localName !== '') void run(async () => { await fetchIntoLocalBranch(workingTreePath, refInfo.remote ?? '', short, localName, false); });
					} },
					{ title: '合并到当前分支…', onClick: async () => {
						const ok = await showConfirmation({ title: '合并', message: `把 ${name} 合并进当前分支？`, confirmLabel: '合并', danger: true });
						if (ok) void run(async () => { await merge(workingTreePath, name); });
					} },
					{ title: '变基当前分支到此处…', onClick: async () => {
						const ok = await showConfirmation({ title: '变基', message: `把当前分支变基到 ${name}？`, confirmLabel: '变基', danger: true });
						if (ok) void run(async () => { await rebase(workingTreePath, name); });
					} },
					{ type: 'divider' },
					{ title: '删除远程分支…', onClick: async () => {
						const ok = await showCheckbox({
							title: '删除远程分支', message: `确定删除远程分支 ${name}？`, checkboxLabel: '我已知晓并继续', danger: true,
						});
						if (ok) void run(async () => { await deleteRemoteBranch(workingTreePath, short, refInfo.remote ?? ''); });
					} },
					{ title: '复制远程分支名', onClick: async () => { await copyText(name); } },
				],
			});
			return;
		}
		if (refInfo.type === 'tag') {
			const name = refInfo.name;
			showContextMenu({
				x, y,
				items: [
					{ title: '检出此标签', onClick: () => { void run(async () => { await checkoutCommit(workingTreePath, commit.hash); }); } },
					{ title: '从此标签创建分支…', onClick: async () => {
						const newName = await showText({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' });
						if (newName !== null && newName !== '') void run(async () => { await createBranch(workingTreePath, newName, commit.hash, true); });
					} },
					{ title: '推送标签到远程…', onClick: async () => {
						if (state.remotes.length === 0) return unsupported('推送标签');
						const remote = state.remotes.length === 1 ? state.remotes[0].name : await showSelect({
							title: '推送标签到远程', options: state.remotes.map((item) => ({ value: item.name, label: item.name })),
						});
						if (remote !== null && remote !== '') void run(async () => { await pushTag(workingTreePath, name, [remote], commit.hash, false); });
					} },
					{ type: 'divider' },
					{ title: '复制标签名', onClick: async () => { await copyText(name); } },
					{ title: '删除标签…', onClick: async () => {
						const ok = await showCheckbox({
							title: '删除标签', message: `确定删除标签 ${name}？`, checkboxLabel: '同时删除远程标签', danger: true,
						});
						if (ok) void run(async () => { await deleteTag(workingTreePath, name, state.remotes.length > 0 ? state.remotes[0].name : null); });
					} },
				],
			});
			return;
		}
		// stash
		const selector = refInfo.name;
		showContextMenu({
			x, y,
			items: [
				{ title: '应用贮藏', onClick: () => { void run(async () => { await applyStash(workingTreePath, selector, false); }); } },
				{ title: '弹出贮藏', onClick: () => { void run(async () => { await popStash(workingTreePath, selector, false); }); } },
				{ title: '从贮藏创建分支…', onClick: async () => {
					const newName = await showText({ title: '从贮藏创建分支', label: '新分支名', placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void run(async () => { await branchFromStash(workingTreePath, selector, newName); });
				} },
				{ type: 'divider' },
				{ title: '丢弃贮藏…', onClick: async () => {
					const ok = await showCheckbox({
						title: '丢弃贮藏', message: `确定丢弃贮藏 ${selector}？`, checkboxLabel: '我已知晓并继续', danger: true,
					});
					if (ok) void run(async () => { await dropStash(workingTreePath, selector); });
				} },
				{ title: '复制选择器', onClick: async () => { await copyText(selector); } },
			],
		});
	}, [workingTreePath, run, state.head, state.remotes, unsupported]);

	/** 统一右键入口：有 ref 走 ref 菜单，否则走提交菜单。 */
	const handleContextMenu = React.useCallback(({ commit, refInfo, event }) => {
		if (refInfo !== null && refInfo !== undefined) {
			openRefMenu({ commit, refInfo, event });
		} else {
			openCommitMenu({ commit, event });
		}
	}, [openCommitMenu, openRefMenu]);

	const dateFmt = React.useCallback((seconds) => formatDate(seconds, settings.dateFormat), [settings.dateFormat]);
	const issueLinking = React.useCallback(() => issueLinkingConfigOf(settings), [settings]);

	if (state.phase === 'no-workspace') {
		return React.createElement('div', { className: 'ggg-empty' }, '该会话没有工作区目录');
	}

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
			}, React.createElement(IconDownloadOutlineRegular, { size: 15 })),
			React.createElement(Button, {
				variant: 'toolbar', size: 'sm', title: '推送当前分支', disabled: state.busy || state.head === null,
				onClick: () => { void run(async () => { await pushBranch(workingTreePath, state.head, []); }); },
			}, React.createElement(IconBranchOutlineRegular, { size: 15 })),
			React.createElement('span', { className: 'ggg-bar-spacer' }),
			React.createElement(Button, {
				variant: 'toolbar', size: 'sm', title: '设置', disabled: state.busy,
				onClick: () => setSettingsOpen(true),
			}, React.createElement(IconSettingsOutlineRegular, { size: 15 })),
		),
		state.error !== null && React.createElement('div', { className: 'ggg-error' }, state.error),

		React.createElement(SettingsPanel, {
			open: settingsOpen, onClose: () => setSettingsOpen(false),
			settings, onChange: changeSettings, remotes: state.remotes, onDeleteRemote: deleteRemoteByName,
		}),

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
				onContextMenu: handleContextMenu,
				formatDate: dateFmt,
				issueLinking: issueLinking(),
			}),
		state.detail !== null && React.createElement(
			'div',
			{ className: 'ggg-detail' },
			React.createElement('div', { className: 'ggg-detail-title' }, state.detail.commit.message),
			React.createElement('div', { className: 'ggg-detail-meta' },
				`${state.detail.commit.hash.slice(0, 8)} · ${state.detail.commit.author}`),
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
