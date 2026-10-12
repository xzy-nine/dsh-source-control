/**
 * Git Graph 面板主体：顶部工具栏、存储库区、变更区（提交框）、提交图。
 *
 * 布局对齐 VS Code 的「源代码管理 + 图形」视图，控件使用 DSH 的
 * ui-primitives，因此外观与 Harness 本身一致。提交图与分支、远程、
 * 标签、贮藏的右键菜单在此组装，并把动作串到宿主后端（api.js）。
 */
import React from 'react';
import {
	Button, Checkbox, FileTypeIcon,
	IconBranchOutlineRegular, IconCheckOutlineRegular,
	IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconCompareSplitOutlineRegular,
	IconArchiveOutlineRegular, IconDownloadOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular,
	IconGoalOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSettingsOutlineRegular, IconSparkleRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
	defaultSettings, formatDate, loadSettings, saveSettings, SettingsPanel,
} from './settings.js';
import {
	addTag, applyStash, branchFromStash, checkoutBranch, checkoutCommit, cherrypickCommit,
	commitStaged, createBranch, deleteBranch, deleteRemote, deleteRemoteBranch, deleteTag,
	discardPaths, discoverRepositories, dropStash, fetchIntoLocalBranch, fetchRepo, loadCommitFiles,
	loadGraph, loadRepoSync, loadWorkingTree, merge, popStash, pushBranch, pushStash, pushTag,
	rebase, renameBranch, resetToCommit, revertCommit, stagePaths, unstagePaths,
} from './api.js';
import { CommitGraph } from './graph.js';
import { RepoIcon, TagRefIcon, RemoteRefIcon } from './ref-icons.js';
import { copyText, openExternal, showContextMenu } from './context-menu.js';
import {
	ancestryOf, findNode, flattenVisible, loadExpanded, loadSelection, saveExpanded, saveSelection, selectInitial,
} from './repo-tree.js';
import {
	showCheckbox, showConfirmation, showSelect, showText,
} from './dialog.js';

/** 会话级存储（窗口存活期内有效）：读取时回退到默认值。 */
function loadSession(key, fallback) {
	try {
		const raw = sessionStorage.getItem(key);
		return raw === null ? fallback : JSON.parse(raw);
	} catch {
		return fallback;
	}
}

/** 会话级存储（窗口存活期内有效）：写入。 */
function saveSession(key, value) {
	try {
		sessionStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* 忽略写入失败 */
	}
}

/**
 * 取远端列表里 GitHub 仓库的提交页地址。
 *
 * @param remotes - 远端列表：{ name, url }。
 * @param hash - 提交哈希。
 * @returns 提交页地址；没有 GitHub 远端时返回 null。
 */
function githubCommitUrl(remotes, hash) {
	const ordered = [...remotes].sort((left, right) => (right.name === 'origin' ? 1 : 0) - (left.name === 'origin' ? 1 : 0));
	for (const remote of ordered) {
		const url = typeof remote.url === 'string' ? remote.url.trim().replace(/\/+$/, '') : '';
		const match = /^(?:https?:\/\/|git@)(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
		if (match !== null) return `https://github.com/${match[1]}/${match[2]}/commit/${hash}`;
	}
	return null;
}

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

/** 空树节点：文件夹挂在 folders，文件挂在 files。 */
function emptyTree() {
	return { folders: new Map(), files: [] };
}

/** 把变更条目按「目录/文件」拆成可折叠的文件夹树。 */
function buildChangeTree(entries) {
	const root = emptyTree();
	for (const entry of entries) {
		const parts = entry.path.split('/');
		let node = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			if (!node.folders.has(part)) node.folders.set(part, emptyTree());
			node = node.folders.get(part);
		}
		node.files.push(entry);
	}
	return root;
}

/** 统计一个子树（含子文件夹）下的文件总数。 */
function countLeaves(node) {
	let total = node.files.length;
	for (const child of node.folders.values()) total += countLeaves(child);
	return total;
}

/** 把文件夹树拍平成可见行；出现在 collapsed 里的文件夹不展开其子节点。 */
function flattenChangeTree(node, prefix, depth, collapsed, out) {
	const folderNames = [...node.folders.keys()].sort();
	for (const name of folderNames) {
		const child = node.folders.get(name);
		const path = prefix === '' ? name : `${prefix}/${name}`;
		const open = !collapsed.has(path);
		out.push({ kind: 'folder', name, path, depth, open, count: countLeaves(child) });
		if (open) flattenChangeTree(child, path, depth + 1, collapsed, out);
	}
	const files = node.files.slice().sort((a, b) => a.path.localeCompare(b.path));
	for (const entry of files) out.push({ kind: 'file', entry, depth });
}

/** 按 depth 生成的竖线层级占位。 */
function guidesOf(depth) {
	const guides = [];
	for (let i = 0; i < depth; i++) guides.push(React.createElement('span', { key: i, className: 'ggg-repo-guide' }));
	return guides;
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

/** 文件夹行或文件行（变更树内）。 */
function ChangeNodeRow({ row, busy, open, staged, onToggle, onStage, onUnstage, onDiscard, onOpen, descendantsOf }) {
	if (row.kind === 'folder') {
		const handleContextMenu = (event) => {
			event.preventDefault();
			event.stopPropagation();
			const target = event.currentTarget;
			target.classList.add('ggg-menu-target');
			const paths = descendantsOf(row.path);
			const items = [];
			if (staged) {
				items.push({ title: `取消暂存此文件夹（${paths.length}）`, disabled: busy || paths.length === 0, onClick: () => onUnstage(paths) });
			} else {
				items.push({ title: `暂存此文件夹（${paths.length}）`, disabled: busy || paths.length === 0, onClick: () => onStage(paths) });
			}
			items.push({ type: 'divider' }, { title: '复制路径', onClick: () => { void copyText(row.path); } });
			showContextMenu({ x: event.clientX, y: event.clientY, items, onClose: () => target.classList.remove('ggg-menu-target') });
		};
		return React.createElement(
			'div',
			{
				className: 'ggg-change ggg-folder', title: row.path,
				onClick: () => onToggle(row.path), onContextMenu: handleContextMenu,
			},
			...guidesOf(row.depth),
			React.createElement('span', {
				className: `ggg-repo-chevron${open ? '' : ' is-collapsed'}`,
			}, React.createElement(IconChevronDownOutlineRegular, { size: 12 })),
			React.createElement(IconFolderOpenOutlineRegular, { size: 14 }),
			React.createElement('span', { className: 'ggg-change-name' }, row.name),
			React.createElement('span', { className: 'ggg-count' }, String(row.count)),
		);
	}
	const entry = row.entry;
	const fileStaged = staged;
	const type = staged ? entry.index : (entry.worktree === '?' ? 'U' : entry.worktree);
	const untracked = entry.index === '?' && entry.worktree === '?';
	const { name } = splitPath(entry.path);
	const handleContextMenu = (event) => {
		event.preventDefault();
		const target = event.currentTarget;
		target.classList.add('ggg-menu-target');
		const items = [{ title: '打开差异', onClick: () => onOpen(entry) }, { type: 'divider' }];
		if (fileStaged) {
			items.push({ title: '取消暂存', disabled: busy, onClick: () => onUnstage([entry.path]) });
		} else {
			items.push({ title: '暂存改动', disabled: busy, onClick: () => onStage([entry.path]) });
			items.push({ title: '丢弃改动', danger: true, disabled: busy, onClick: () => onDiscard([entry.path], untracked) });
		}
		items.push({ type: 'divider' }, { title: '复制路径', onClick: () => { void copyText(entry.path); } });
		showContextMenu({ x: event.clientX, y: event.clientY, items, onClose: () => target.classList.remove('ggg-menu-target') });
	};
	return React.createElement(
		'div',
		{ className: 'ggg-change', title: entry.path, onContextMenu: handleContextMenu },
		...guidesOf(row.depth),
		React.createElement(FileTypeIcon, { path: name, size: 14 }),
		React.createElement('span', { className: 'ggg-status', 'data-type': type }, type),
		React.createElement('span', { className: 'ggg-change-name' }, name),
		React.createElement('button', {
			type: 'button', className: 'ggg-change-btn', title: '打开差异', disabled: busy,
			onClick: () => onOpen(entry),
		}, React.createElement(IconCompareSplitOutlineRegular, { size: 14 })),
		fileStaged
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
 * 展开块里的改动文件树：与工作区变更区同构，但文件行只提供「打开差异」。
 *
 * @param props.files - 改动文件列表：{ path, type, additions, deletions }。
 * @param props.busy - 是否正在执行操作。
 * @param props.collapsed - 已折叠的文件夹路径集合。
 * @param props.onToggle - 切换文件夹折叠。
 * @param props.onOpen - 打开某个文件的差异。
 * @returns 展开块元素。
 */
function CommitDetail({ files, busy, collapsed, onToggle, onOpen }) {
	if (files.length === 0) {
		return React.createElement('div', { className: 'ggg-hint' }, '正在加载改动文件…');
	}
	const rows = [];
	flattenChangeTree(buildChangeTree(files), '', 1, collapsed, rows);
	return React.createElement(
		'div',
		{ className: 'ggg-changes ggg-detail-changes' },
		...rows.map((row) => {
			if (row.kind === 'folder') {
				return React.createElement(
					'div',
					{
						key: `f:${row.path}`, className: 'ggg-change ggg-folder', title: row.path,
						onClick: () => onToggle(row.path),
					},
					...guidesOf(row.depth),
					React.createElement('span', {
						className: `ggg-repo-chevron${row.open ? '' : ' is-collapsed'}`,
					}, React.createElement(IconChevronDownOutlineRegular, { size: 12 })),
					React.createElement(IconFolderOpenOutlineRegular, { size: 14 }),
					React.createElement('span', { className: 'ggg-change-name' }, row.name),
					React.createElement('span', { className: 'ggg-count' }, String(row.count)),
				);
			}
			const entry = row.entry;
			const { name } = splitPath(entry.path);
			const stat = entry.additions !== null && entry.additions !== undefined;
			return React.createElement(
				'div',
				{ key: `e:${entry.path}`, className: 'ggg-change', title: entry.path },
				...guidesOf(row.depth),
				React.createElement(FileTypeIcon, { path: name, size: 14 }),
				React.createElement('span', { className: 'ggg-status', 'data-type': entry.type }, entry.type),
				React.createElement('span', { className: 'ggg-change-name' }, name),
				stat && React.createElement(
					'span',
					{ className: 'ggg-detail-stat' },
					React.createElement('span', { className: 'ggg-detail-add' }, `+${entry.additions}`),
					React.createElement('span', { className: 'ggg-detail-del' }, `-${entry.deletions}`),
				),
				React.createElement('button', {
					type: 'button', className: 'ggg-change-btn', title: '打开差异', disabled: busy,
					onClick: () => onOpen(entry.path),
				}, React.createElement(IconCompareSplitOutlineRegular, { size: 14 })),
			);
		}),
	);
}

/**
 * 一个变更分组：暂存的更改 / 更改。
 *
 * @param props.staged - 是否处理已暂存条目。
 * @param props.entries - 全部工作区条目。
 * @param props.busy - 是否正在执行操作。
 * @param props.workingTreePath - 当前工作树路径。
 * @param props.collapsed - 本分组内已折叠的文件夹路径集合（默认空＝全部展开）。
 * @param props.toggleChange - 切换本分组内文件夹的折叠状态。
 * @param props.open - 分组是否展开。
 * @param props.onToggleGroup - 切换分组展开。
 * @param props.run - 执行异步动作的包装器。
 * @param props.stagePaths - 暂存。
 * @param props.unstagePaths - 取消暂存。
 * @param props.discardPaths - 丢弃。
 * @param props.openDiff - 打开差异。
 * @returns 分组元素；无对应条目时返回空数组。
 */
function ChangeGroup({
	staged, entries, busy, workingTreePath, collapsed, toggleChange, groupKey, open, onToggleGroup, run,
	stagePaths, unstagePaths, discardPaths, openDiff,
}) {
	const visible = entries.filter((entry) => staged
		? (entry.index !== ' ' && entry.index !== '?')
		: (entry.worktree !== ' '));
	if (visible.length === 0) return [];
	const tree = buildChangeTree(visible);
	const rows = [];
	flattenChangeTree(tree, '', 1, collapsed, rows);
	const title = staged ? '暂存的更改' : '更改';
	const allPaths = visible.map((entry) => entry.path);
	const onStage = (paths) => { void run(async () => { await stagePaths(workingTreePath, paths); }); };
	const onUnstage = (paths) => { void run(async () => { await unstagePaths(workingTreePath, paths); }); };
	const onDiscard = (paths, untracked) => { void run(async () => { await discardPaths(workingTreePath, paths, untracked); }); };
	const onOpen = (item) => { void openDiff('*', item.path, staged); };
	const descendantsOf = (folderPath) => {
		const prefix = `${folderPath}/`;
		return visible.filter((entry) => entry.path.startsWith(prefix)).map((entry) => entry.path);
	};
	const handleHeadContextMenu = (event) => {
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget;
		target.classList.add('ggg-menu-target');
		const items = staged
			? [{ title: `取消暂存全部（${allPaths.length}）`, disabled: busy, onClick: () => onUnstage(allPaths) }]
			: [
				{ title: `暂存全部（${allPaths.length}）`, disabled: busy, onClick: () => onStage(allPaths) },
				{ type: 'divider' },
				{ title: `丢弃全部（${allPaths.length}）`, danger: true, disabled: busy, onClick: () => onDiscard(allPaths, false) },
			];
		showContextMenu({ x: event.clientX, y: event.clientY, items, onClose: () => target.classList.remove('ggg-menu-target') });
	};
	return React.createElement(
		'div',
		{ className: 'ggg-change-group' },
		React.createElement(
			'div',
			{
				className: 'ggg-change ggg-group-root',
				onClick: () => onToggleGroup(),
				onContextMenu: handleHeadContextMenu,
			},
			React.createElement('span', {
				className: `ggg-repo-chevron${open ? '' : ' is-collapsed'}`,
			}, React.createElement(IconChevronDownOutlineRegular, { size: 14 })),
			React.createElement('span', { className: 'ggg-group-title' }, title),
			React.createElement('span', { className: 'ggg-count' }, String(visible.length)),
		),
		open && React.createElement(
			'div',
			{ className: 'ggg-changes' },
			...rows.map((row) => React.createElement(ChangeNodeRow, {
				key: row.kind === 'folder' ? `f:${row.path}` : `e:${row.entry.path}`,
				row, busy,
				open: row.kind === 'folder' && !collapsed.has(row.path),
				staged,
				onToggle: (path) => toggleChange(groupKey, path),
				onStage, onUnstage, onDiscard, onOpen,
				descendantsOf,
			})),
		),
	);
}

/**
 * 存储库树的一行。
 *
 * @param props.node - 仓库、工作树或子模块节点。
 * @param props.depth - 缩进层级。
 * @param props.active - 是否选中。
 * @param props.expanded - 是否有子节点且已展开。
 * @param props.sync - 领先/落后信息；尚未取到时为 undefined。
 * @param props.onSelect - 选中回调。
 * @param props.onToggle - 展开/收起回调。
 * @returns 行元素。
 */
function RepoRow({ node, depth, active, expanded, sync, onSelect, onToggle, onMoreActions, onBranchClick, headHash }) {
	const hasChildren = (node.children ?? []).length > 0;
	const isWorktree = node.kind === 'worktree';
	const isSubmodule = node.kind === 'submodule';
	const guides = [];
	for (let i = 0; i < depth; i++) guides.push(React.createElement('span', { key: i, className: 'ggg-repo-guide' }));
	const branchName = (sync?.branch ?? node.branch) ?? '';
	const isDetached = branchName === '' && headHash !== null && headHash !== undefined;
	const refText = isDetached ? headHash.slice(0, 7) : branchName;
	return React.createElement(
		'div',
		{
			className: `ggg-repo${active ? ' is-active' : ''}${node.available === false ? ' is-missing' : ''}`,
			title: node.path,
			onClick: () => onSelect(node),
		},
		...guides,
		React.createElement('span', {
			className: `ggg-repo-chevron${expanded ? '' : ' is-collapsed'}${hasChildren ? '' : ' is-empty'}`,
			onClick: (event) => { event.stopPropagation(); if (hasChildren) onToggle(node); },
		}, React.createElement(IconChevronDownOutlineRegular, { size: 12 })),
		isWorktree
			? React.createElement(IconBranchOutlineRegular, { size: 14, className: 'ggg-repo-icon' })
			: isSubmodule
				? React.createElement(IconArchiveOutlineRegular, { size: 14, className: 'ggg-repo-icon' })
				: React.createElement(RepoIcon),
		React.createElement('span', { className: 'ggg-repo-name' }, node.name),
		refText !== '' && React.createElement(IconBranchOutlineRegular, { size: 12, className: 'ggg-repo-branch-icon' }),
		refText !== '' && React.createElement('span', {
			className: 'ggg-repo-branch' + (onBranchClick !== undefined && !isDetached ? ' is-clickable' : ''),
			onClick: (event) => { if (onBranchClick !== undefined && !isDetached) { event.stopPropagation(); onBranchClick(node, event); } },
		}, refText),
		sync !== undefined && (sync.ahead > 0 || sync.behind > 0) && React.createElement(
			'span',
			{ className: 'ggg-repo-sync', title: `领先 ${sync.ahead}、落后 ${sync.behind}` },
			sync.behind > 0 && React.createElement('span', null, `↓${sync.behind}`),
			sync.ahead > 0 && React.createElement('span', null, `↑${sync.ahead}`),
		),
		React.createElement('button', {
			type: 'button', className: 'ggg-repo-more', title: '更多操作',
			onClick: (event) => { event.stopPropagation(); onMoreActions?.(node, event); },
		}, React.createElement(IconEllipsisOutlineRegular, { size: 14 })),
	);
}

/**
 * Git Graph 面板。
 *
 * @param props.cwd - 会话工作区路径；没有工作区时为 undefined。
 * @param props.sessionId - 会话 id，用于持久化存储库选中与展开状态。
 * @param props.onOpenDiff - 打开文件差异（打开右侧栏 Diff 页）。
 * @returns 面板元素。
 */

/**
 * 从提交列表收集所有引用（分支、远程、标签），去重后按类型排序。
 *
 * @param commits - 提交列表。
 * @returns 引用列表：{ name, hash, type, kind }。
 */
function collectRefs(commits) {
	const seen = new Set();
	const refs = [];
	for (const commit of commits) {
		for (const name of commit.heads ?? []) {
			const key = `b:${name}`;
			if (!seen.has(key)) { seen.add(key); refs.push({ name, hash: commit.hash, type: 'branch', kind: '分支' }); }
		}
		for (const remote of commit.remotes ?? []) {
			const key = `r:${remote.name}`;
			if (!seen.has(key)) { seen.add(key); refs.push({ name: remote.name, hash: commit.hash, type: 'remote', kind: '远程' }); }
		}
		for (const tag of commit.tags ?? []) {
			const key = `t:${tag.name}`;
			if (!seen.has(key)) { seen.add(key); refs.push({ name: tag.name, hash: commit.hash, type: 'tag', kind: '标记' }); }
		}
	}
	return refs;
}

/**
 * 计算「自动」模式应显示的分支：当前分支及向其合并的分支（祖先提交上的分支）。
 *
 * @param commits - 提交列表。
 * @param head - 当前分支名。
 * @returns 分支名称集合。
 */
function computeAutoRefs(commits, head) {
	if (head === null) return new Set();
	const commitByHash = new Map();
	for (const commit of commits) {
		if (commit.hash !== '*') commitByHash.set(commit.hash, commit);
	}
	let headHash = null;
	for (const commit of commits) {
		if ((commit.heads ?? []).includes(head)) { headHash = commit.hash; break; }
	}
	if (headHash === null) return new Set();
	// 祖先提交（含 HEAD 自身）
	const ancestorHashes = new Set();
	const queue = [headHash];
	while (queue.length > 0) {
		const hash = queue.shift();
		if (ancestorHashes.has(hash)) continue;
		ancestorHashes.add(hash);
		const commit = commitByHash.get(hash);
		if (commit !== undefined) for (const p of commit.parents ?? []) queue.push(p);
	}
	// 收集祖先提交上的分支名
	const result = new Set();
	for (const hash of ancestorHashes) for (const name of commitByHash.get(hash)?.heads ?? []) result.add(name);
	return result;
}

/**
 * 按选中的引用名称过滤提交列表：仅保留选中引用可达的提交（含工作区伪提交）。
 *
 * @param commits - 全部提交。
 * @param selectedNames - 选中的引用名称集合；空集表示不过滤。
 * @returns 过滤后的提交列表。
 */
function filterCommitsByRefs(commits, selectedNames) {
	if (selectedNames.size === 0) return commits;
	const commitByHash = new Map();
	for (const commit of commits) {
		if (commit.hash !== '*') commitByHash.set(commit.hash, commit);
	}
	const rootHashes = new Set();
	for (const commit of commits) {
		if (commit.hash === '*') continue;
		for (const name of commit.heads ?? []) if (selectedNames.has(name)) rootHashes.add(commit.hash);
		for (const remote of commit.remotes ?? []) if (selectedNames.has(remote.name)) rootHashes.add(commit.hash);
		for (const tag of commit.tags ?? []) if (selectedNames.has(tag.name)) rootHashes.add(commit.hash);
	}
	const reachable = new Set();
	const queue = [...rootHashes];
	while (queue.length > 0) {
		const hash = queue.shift();
		if (reachable.has(hash)) continue;
		reachable.add(hash);
		const commit = commitByHash.get(hash);
		if (commit !== undefined) for (const p of commit.parents ?? []) queue.push(p);
	}
	return commits.filter((commit) => commit.hash === '*' || reachable.has(commit.hash));
}

/**
 * 计算领先与落后的提交哈希集合。
 *
 * 领先：本地 HEAD 可达但远程跟踪分支不可达的提交。
 * 落后：远程跟踪分支可达但本地 HEAD 不可达的提交。
 *
 * @param commits - 提交列表。
 * @param head - 本地分支名。
 * @param upstream - 远程跟踪分支名（如 origin/main）。
 * @returns {{ ahead: Set<string>, behind: Set<string> }}
 */
function computeAheadBehind(commits, head, upstream) {
	const empty = { ahead: new Set(), behind: new Set() };
	if (head === null || upstream === null) return empty;
	const commitByHash = new Map();
	for (const commit of commits) {
		if (commit.hash !== '*') commitByHash.set(commit.hash, commit);
	}
	// 找本地 HEAD 和远程跟踪分支的提交哈希
	let localHash = null;
	let remoteHash = null;
	for (const commit of commits) {
		if (commit.hash === '*') continue;
		if (localHash === null && (commit.heads ?? []).includes(head)) localHash = commit.hash;
		for (const remote of commit.remotes ?? []) {
			if (remote.name === upstream) remoteHash = commit.hash;
		}
	}
	if (localHash === null || remoteHash === null) return empty;
	// 收集各自祖先
	const ancestorsOf = (rootHash) => {
		const seen = new Set();
		const queue = [rootHash];
		while (queue.length > 0) {
			const hash = queue.shift();
			if (seen.has(hash)) continue;
			seen.add(hash);
			const commit = commitByHash.get(hash);
			if (commit !== undefined) for (const p of commit.parents ?? []) queue.push(p);
		}
		return seen;
	};
	const localAncestors = ancestorsOf(localHash);
	const remoteAncestors = ancestorsOf(remoteHash);
	const ahead = new Set();
	const behind = new Set();
	for (const hash of localAncestors) if (!remoteAncestors.has(hash)) ahead.add(hash);
	for (const hash of remoteAncestors) if (!localAncestors.has(hash)) behind.add(hash);
	return { ahead, behind };
}

/**
 * 引用筛选弹窗：搜索、快捷勾选、多选列表。
 *
 * @param props.refs - 全部引用列表。
 * @param props.selected - 已选引用名称集合。
 * @param props.onToggle - 切换某引用的选中状态。
 * @param props.onSelectAll - 全选/全不选。
 * @param props.onClose - 关闭弹窗。
 * @returns 弹窗元素。
 */
function RefFilterDialog({ refs, selected, search, onSearch, onToggle, onSelectAll, autoChecked, onToggleAuto, onClose }) {
	const filtered = refs.filter((ref) => search === '' || ref.name.includes(search) || ref.hash.includes(search));
	const allChecked = refs.length > 0 && refs.every((ref) => selected.has(ref.name));
	return React.createElement(
		'div',
		{ className: 'ggg-filter-backdrop', onClick: onClose },
		React.createElement(
			'div',
			{ className: 'ggg-filter-dialog', onClick: (event) => event.stopPropagation() },
			// 顶部：搜索框 + 已选徽章 + 确定按钮
			React.createElement(
				'div',
				{ className: 'ggg-filter-top' },
				React.createElement('input', {
					type: 'text', className: 'ggg-filter-search', placeholder: '搜索分支、标签…',
					value: search, onChange: (event) => onSearch(event.currentTarget.value),
				}),
				React.createElement('span', { className: 'ggg-filter-badge' }, `${selected.size}`),
				React.createElement(Button, { variant: 'primary', size: 'sm', onClick: onClose }, '确定'),
			),
			// 快捷选项
			React.createElement(
				'div',
				{ className: 'ggg-filter-quick' },
				React.createElement('label', { className: 'ggg-filter-quick-item' },
					React.createElement(Checkbox, { checked: allChecked, onChange: () => onSelectAll(!allChecked) }),
					React.createElement('span', { className: 'ggg-filter-quick-label' }, '全部'),
					React.createElement('span', { className: 'ggg-filter-quick-hint' }, '显示所有分支与标签'),
				),
				React.createElement('label', { className: 'ggg-filter-quick-item' },
					React.createElement(Checkbox, { checked: autoChecked, onChange: onToggleAuto }),
					React.createElement('span', { className: 'ggg-filter-quick-label' }, '自动'),
					React.createElement('span', { className: 'ggg-filter-quick-hint' }, '仅显示当前分支及向其合并的分支'),
				),
			),
			// 引用列表
			React.createElement(
				'div',
				{ className: 'ggg-filter-list' },
				...filtered.map((ref) => {
					const isChecked = selected.has(ref.name);
					return React.createElement(
						'label',
						{ key: `${ref.type}:${ref.name}`, className: `ggg-filter-row${isChecked ? ' is-checked' : ''}` },
						React.createElement(Checkbox, { checked: isChecked, onChange: () => onToggle(ref.name) }),
						ref.type === 'branch' && React.createElement(IconBranchOutlineRegular, { size: 14, className: 'ggg-filter-icon' }),
						ref.type === 'remote' && React.createElement(RemoteRefIcon),
						ref.type === 'tag' && React.createElement(TagRefIcon),
						React.createElement('span', { className: 'ggg-filter-name' }, ref.name),
						React.createElement('span', { className: 'ggg-filter-hash' }, ref.hash.slice(0, 7)),
						React.createElement('span', { className: 'ggg-filter-kind' }, ref.kind),
					);
				}),
			),
		),
	);
}

export function GitGraphPanel({ cwd, sessionId, onOpenDiff }) {
	const [state, setState] = React.useState({
		phase: 'loading', error: null, commits: [], head: null, more: false,
		entries: [], selectedHash: null, detail: null, busy: false, remotes: [],
	});
	const [message, setMessage] = React.useState('');
	const [amend, setAmend] = React.useState(false);
	const [maxCommits, setMaxCommits] = React.useState(200);
	const [settings, setSettings] = React.useState(() => loadSettings());
	const [settingsOpen, setSettingsOpen] = React.useState(false);
	const [filterOpen, setFilterOpen] = React.useState(false);
	const [filterSearch, setFilterSearch] = React.useState('');
	const [filterSelected, setFilterSelected] = React.useState(() => new Set());
	const [filterAuto, setFilterAuto] = React.useState(false);
	const [repoNodes, setRepoNodes] = React.useState([]);
	const [treeStatus, setTreeStatus] = React.useState('loading');
	const [treeNote, setTreeNote] = React.useState(null);
	const [selectedId, setSelectedId] = React.useState(null);
	const [expandedIds, setExpandedIds] = React.useState(() => loadExpanded(sessionId));
	// 分组各自的「已折叠」文件夹集合（默认空＝全部展开）；会话级、不持久化。
	// detail 是图形区内展开块的文件夹集合。
	const [collapsedByGroup, setCollapsedByGroup] = React.useState(() => ({ staged: new Set(), unstaged: new Set(), detail: new Set() }));
	const [groupExpanded, setGroupExpanded] = React.useState(() => ({ staged: true, unstaged: true }));
	const [syncById, setSyncById] = React.useState(() => new Map());
	// 存储库、图形两区可收起（默认展开）；会话级持久化。
	const [repoSecOpen, setRepoSecOpen] = React.useState(() => loadSession('dsh-git-graph-repo-open', true));
	const [graphSecOpen, setGraphSecOpen] = React.useState(() => loadSession('dsh-git-graph-graph-open', true));
	// 图形区高度（像素）；会话级持久化，默认 320。
	const [graphHeight, setGraphHeight] = React.useState(() => loadSession('dsh-git-graph-graph-height', 320));
	// 存储库区高度（像素）；会话级持久化，默认 200。
	const [repoHeight, setRepoHeight] = React.useState(() => loadSession('dsh-git-graph-repo-height', 200));
	// 悬停卡片的改动统计：按提交哈希缓存，悬停时按需拉取。
	const [statsByHash, setStatsByHash] = React.useState(() => new Map());
	const statsInFlight = React.useRef(new Map());
	const hoverTimer = React.useRef(null);
	const graphScrollRef = React.useRef(null);
	const toggleRepoSec = React.useCallback(() => {
		setRepoSecOpen((previous) => { const next = !previous; saveSession('dsh-git-graph-repo-open', next); return next; });
	}, []);
	const toggleGraphSec = React.useCallback(() => {
		setGraphSecOpen((previous) => { const next = !previous; saveSession('dsh-git-graph-graph-open', next); return next; });
	}, []);
	const commitGraphHeight = React.useCallback((value) => {
		const clamped = Math.max(120, Math.min(value, 720));
		setGraphHeight(clamped);
		saveSession('dsh-git-graph-graph-height', clamped);
	}, []);
	// 拖拽图形区上沿（工作区与图形的分界线）：向上拖＝图形变高。
	const startGraphResize = React.useCallback((event) => {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = graphHeight;
		const handle = event.currentTarget;
		handle.classList.add('is-dragging');
		const onMove = (moveEvent) => {
			commitGraphHeight(startHeight - (moveEvent.clientY - startY));
		};
		const onUp = () => {
			handle.classList.remove('is-dragging');
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}, [graphHeight, commitGraphHeight]);

	const commitRepoHeight = React.useCallback((value) => {
		const clamped = Math.max(80, Math.min(value, 600));
		setRepoHeight(clamped);
		saveSession('dsh-git-graph-repo-height', clamped);
	}, []);
	// 拖拽存储库区下沿（存储库与更改的分界线）：向下拖＝存储库变高。
	const startRepoResize = React.useCallback((event) => {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = repoHeight;
		const handle = event.currentTarget;
		handle.classList.add('is-dragging');
		const onMove = (moveEvent) => {
			commitRepoHeight(startHeight + (moveEvent.clientY - startY));
		};
		const onUp = () => {
			handle.classList.remove('is-dragging');
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}, [repoHeight, commitRepoHeight]);

	const selectedNode = React.useMemo(() => findNode(repoNodes, selectedId), [repoNodes, selectedId]);
	// 发现结束前不按工作区根加载，避免先加载一次再被选中结果覆盖。
	const workingTreePath = selectedNode !== null
		? selectedNode.path
		: (treeStatus === 'loading' ? null : (cwd ?? null));
	const hasWorkspace = cwd !== undefined && cwd !== null;

	const generationRef = React.useRef(0);
	const controllerRef = React.useRef(null);
	const entriesSigRef = React.useRef('');
	const busyRef = React.useRef(false);

	/* ── 仓库发现 ─────────────────────────────────────────── */

	React.useEffect(() => {
		if (!hasWorkspace) {
			setRepoNodes([]);
			setTreeStatus('empty');
			return undefined;
		}
		const controller = new AbortController();
		setTreeStatus('loading');
		setTreeNote(null);
		discoverRepositories(cwd, {}, controller.signal).then((result) => {
			if (controller.signal.aborted) return;
			const initial = selectInitial(result.nodes, cwd, loadSelection(sessionId));
			setRepoNodes(result.nodes);
			setSelectedId(initial === null ? null : initial.id);
			setExpandedIds((previous) => {
				const next = new Set(previous);
				if (initial !== null) for (const id of ancestryOf(result.nodes, initial.id)) next.add(id);
				return next;
			});
			setTreeStatus('ready');
			if (result.truncated) setTreeNote('已达到扫描上限，仅显示部分仓库');
		}).catch((error) => {
			if (controller.signal.aborted) return;
			setRepoNodes([]);
			setTreeStatus('error');
			setTreeNote(error instanceof Error ? error.message : String(error));
		});
		return () => { controller.abort(); };
	}, [cwd, sessionId, hasWorkspace]);

	/** 选中一个仓库节点并持久化。 */
	const selectNode = React.useCallback((node) => {
		if (node.id === selectedId) return;
		setSelectedId(node.id);
		saveSelection(sessionId, node.id);
		setState((previous) => ({
			...previous, phase: 'loading', commits: [], entries: [],
			detail: null, selectedHash: null, error: null,
		}));
	}, [sessionId, selectedId]);

	/** 展开或收起一个仓库节点。 */
	const toggleNode = React.useCallback((node) => {
		setExpandedIds((previous) => {
			const next = new Set(previous);
			if (next.has(node.id)) next.delete(node.id);
			else next.add(node.id);
			saveExpanded(sessionId, next);
			return next;
		});
	}, [sessionId]);

	const toggleChange = React.useCallback((key, path) => {
		setCollapsedByGroup((previous) => {
			const current = previous[key];
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return { ...previous, [key]: next };
		});
	}, []);

	const toggleGroup = React.useCallback((key) => {
		setGroupExpanded((previous) => ({ ...previous, [key]: !previous[key] }));
	}, []);

	const visibleRows = React.useMemo(() => flattenVisible(repoNodes, expandedIds), [repoNodes, expandedIds]);

	/* ── 后台预取可见节点的领先/落后 ─────────────────────── */

	React.useEffect(() => {
		const pending = visibleRows.filter(({ node }) => !syncById.has(node.id));
		if (pending.length === 0) return undefined;
		let cancelled = false;
		const idle = typeof window.requestIdleCallback === 'function'
			? (fn) => window.requestIdleCallback(fn, { timeout: 1200 })
			: (fn) => window.setTimeout(fn, 80);
		const cancelIdle = typeof window.cancelIdleCallback === 'function'
			? (handle) => window.cancelIdleCallback(handle)
			: (handle) => window.clearTimeout(handle);
		const handle = idle(() => {
			void (async () => {
				for (const { node } of pending.slice(0, 3)) {
					if (cancelled) return;
					let sync = { branch: null, upstream: null, ahead: 0, behind: 0 };
					try {
						sync = await loadRepoSync(node.path);
					} catch {
						/* 无上游或非仓库时保留空徽标 */
					}
					if (cancelled) return;
					setSyncById((previous) => new Map(previous).set(node.id, sync));
				}
			})();
		});
		return () => { cancelled = true; cancelIdle(handle); };
	}, [visibleRows, syncById]);

	/* ── 选中仓库的按需加载 ───────────────────────────────── */

	/** 重新加载选中仓库的提交图与工作区。 */
	const refresh = React.useCallback(async () => {
		if (workingTreePath === null) {
			setState((previous) => ({
				...previous, phase: hasWorkspace ? 'loading' : 'no-workspace', error: null,
			}));
			return;
		}
		const generation = generationRef.current + 1;
		generationRef.current = generation;
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;
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
				signal: controller.signal,
			});
			const entries = await loadWorkingTree(workingTreePath, controller.signal);
			if (generation !== generationRef.current) return;
			setState((previous) => ({
				...previous, phase: 'ready', error: null,
				commits: graph.commits, head: graph.head, more: graph.moreCommitsAvailable,
				remotes: graph.remotes, entries,
			}));
			// 刷新选中仓库的领先/落后状态
			try {
				const sync = await loadRepoSync(workingTreePath, controller.signal);
				if (generation === generationRef.current && selectedId !== null) {
					setSyncById((previous) => new Map(previous).set(selectedId, sync));
				}
			} catch { /* 忽略 sync 刷新失败 */ }
		} catch (error) {
			if (generation !== generationRef.current || controller.signal.aborted) return;
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, maxCommits, settings, hasWorkspace, selectedId]);

	React.useEffect(() => { void refresh(); }, [refresh]);

	/* ── 低频轮询：检测外部工作区变更 ─────────────────────── */
	entriesSigRef.current = state.entries.map((e) => `${e.path}:${e.status}`).join('\n');
	busyRef.current = state.busy;
	React.useEffect(() => {
		if (workingTreePath === null) return undefined;
		let cancelled = false;
		const intervalId = setInterval(() => {
			if (cancelled || document.visibilityState !== 'visible' || busyRef.current) return;
			void (async () => {
				try {
					const entries = await loadWorkingTree(workingTreePath);
					if (cancelled) return;
					const newSig = entries.map((e) => `${e.path}:${e.status}`).join('\n');
					if (entriesSigRef.current !== newSig) void refresh();
				} catch { /* 忽略轮询失败 */ }
			})();
		}, 15000);
		return () => { cancelled = true; clearInterval(intervalId); };
	}, [workingTreePath, refresh]);

	// 换仓库后旧的统计不再适用。
	React.useEffect(() => { setStatsByHash(new Map()); }, [workingTreePath]);

	// 卸载时取消未完成的统计请求与悬停计时。
	React.useEffect(() => () => {
		if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
		for (const controller of statsInFlight.current.values()) controller.abort();
		statsInFlight.current.clear();
	}, []);

	/**
	 * 拉取某个提交的改动统计并缓存；已在缓存或请求中的跳过。
	 *
	 * @param hash - 提交哈希，`*` 表示工作区未提交变更。
	 * @returns 无。
	 */
	const requestCommitStats = React.useCallback((hash) => {
		if (workingTreePath === null || statsByHash.has(hash) || statsInFlight.current.has(hash)) return;
		const controller = new AbortController();
		statsInFlight.current.set(hash, controller);
		loadCommitFiles(workingTreePath, hash, controller.signal).then((files) => {
			statsInFlight.current.delete(hash);
			if (controller.signal.aborted) return;
			let additions = 0;
			let deletions = 0;
			for (const file of files) {
				additions += typeof file.additions === 'number' ? file.additions : 0;
				deletions += typeof file.deletions === 'number' ? file.deletions : 0;
			}
			setStatsByHash((previous) => new Map(previous).set(hash, { files: files.length, additions, deletions }));
		}).catch(() => {
			// 统计失败只影响卡片上的那一行，不再提示。
			statsInFlight.current.delete(hash);
		});
	}, [workingTreePath, statsByHash]);

	/**
	 * 悬停提交行：延时预取统计，避免指针扫过时连发请求。
	 *
	 * @param hash - 进入的提交哈希；离开时为 null。
	 * @returns 无。
	 */
	const hoverCommit = React.useCallback((hash) => {
		if (hoverTimer.current !== null) {
			clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
		if (hash === null) return;
		hoverTimer.current = setTimeout(() => {
			hoverTimer.current = null;
			requestCommitStats(hash);
		}, 220);
	}, [requestCommitStats]);

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

	/** 仓库行「更多操作」右键菜单。 */
	const handleRepoMoreActions = React.useCallback((node, event) => {
		const target = event.currentTarget;
		target.classList.add('ggg-menu-target');
		const branchName = node.branch ?? '';
		showContextMenu({
			x: event.clientX, y: event.clientY,
			onClose: () => target.classList.remove('ggg-menu-target'),
			items: [
				{ title: '刷新', onClick: () => { selectNode(node); void run(() => refresh()); } },
				{ title: '抓取', disabled: state.busy, onClick: () => { selectNode(node); void run(async () => { await fetchRepo(node.path, null); }); } },
				{ title: '推送', disabled: state.busy || branchName === '', onClick: () => { selectNode(node); void run(async () => { await pushBranch(node.path, branchName, []); }); } },
				{ type: 'divider' },
				{ title: '复制路径', onClick: () => { void copyText(node.path); } },
			],
		});
	}, [selectNode, run, refresh, state.busy]);

	/** 仓库行分支名点击：弹出分支切换菜单。 */
	const handleBranchClick = React.useCallback((node, event) => {
		const branches = new Set();
		for (const commit of state.commits) {
			for (const name of commit.heads ?? []) branches.add(name);
		}
		if (branches.size === 0) return;
		const target = event.currentTarget;
		target.classList.add('ggg-menu-target');
		showContextMenu({
			x: event.clientX, y: event.clientY,
			onClose: () => target.classList.remove('ggg-menu-target'),
			items: [...branches].sort().map((name) => ({
				title: name,
				onClick: () => { selectNode(node); void run(async () => { await checkoutBranch(node.path, name); }); },
			})),
		});
	}, [state.commits, selectNode, run]);

	/** 选中仓库的 HEAD 提交哈希（用于检出提交状态显示）。 */
	const headCommitHash = state.commits.find((commit) => commit.hash !== '*')?.hash ?? null;

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

	/** 点击提交行：展开改动文件；再次点击同一行收起。 */
	const toggleCommit = React.useCallback((hash) => {
		if (state.selectedHash === hash) {
			setState((previous) => ({ ...previous, selectedHash: null, detail: null }));
			return;
		}
		void selectCommit(hash);
	}, [state.selectedHash, selectCommit]);

	/** 转到当前 HEAD 提交：选中并展开其改动文件。 */
	const goToHead = React.useCallback(() => {
		const headCommit = state.commits.find((commit) => commit.hash !== '*' && (commit.heads ?? []).includes(state.head ?? ''));
		const target = headCommit ?? state.commits.find((commit) => commit.hash !== '*');
		if (target === undefined) return;
		const container = graphScrollRef.current;
		if (container === null) return;
		const row = container.querySelector(`[data-hash="${target.hash}"]`);
		if (row !== null) row.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}, [state.commits, state.head]);

	const stagedPaths = state.entries.filter((entry) => changeOf(entry).staged).map((entry) => entry.path);

	/** 勾选「修补上一次提交」时自动填入上一提交消息；取消勾选时清空。 */
	const toggleAmend = React.useCallback((checked) => {
		setAmend(checked);
		if (checked) {
			const lastCommit = state.commits.find((commit) => commit.hash !== '*');
			if (lastCommit !== undefined) setMessage(lastCommit.message ?? '');
		} else {
			setMessage('');
		}
	}, [state.commits]);

	/** 提交暂存区。 */
	const submit = () => {
		if (state.busy || message.trim() === '' || stagedPaths.length === 0) return;
		void run(async () => {
			await commitStaged(workingTreePath, message, amend);
			setMessage('');
			setAmend(false);
		});
	};

	const currentSync = syncById.get(selectedId);
	const aheadBehind = React.useMemo(
		() => computeAheadBehind(state.commits, state.head, currentSync?.upstream ?? null),
		[state.commits, state.head, currentSync],
	);
	const workAreaEmpty = state.entries.length === 0;
	const hasRemoteDiff = currentSync !== undefined && (currentSync.ahead > 0 || currentSync.behind > 0);
	const showSyncButton = workAreaEmpty && hasRemoteDiff;
	const handleSync = () => {
		if (state.busy || workingTreePath === null) return;
		void run(async () => {
			await fetchRepo(workingTreePath, null);
			if (currentSync !== undefined && currentSync.behind > 0 && currentSync.upstream !== null) {
				await merge(workingTreePath, currentSync.upstream);
			}
			if (currentSync !== undefined && currentSync.ahead > 0 && state.head !== null) {
				await pushBranch(workingTreePath, state.head, []);
			}
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
		const remoteRefs = commit.remotes ?? [];
		const isHead = commit.hash === '*';
		const githubUrl = isHead ? null : githubCommitUrl(state.remotes, commit.hash);
		// 指向该提交的分支（本地 + 远程）与标签：删除动作的二级菜单目标。
		const branchItems = [
			...branchNames.map((name) => ({
				title: name,
				onClick: async () => {
					const ok = await showCheckbox({
						title: '删除本地分支', message: `确定删除本地分支 ${name}？`,
						checkboxLabel: '同时强制删除未合并分支', danger: true,
					});
					if (ok) void run(async () => { await deleteBranch(workingTreePath, name, true); });
				},
			})),
			...remoteRefs.map((remote) => ({
				title: remote.name,
				onClick: async () => {
					const ok = await showCheckbox({
						title: '删除远程分支', message: `确定删除远程分支 ${remote.name}？`,
						checkboxLabel: '我已知晓并继续', danger: true,
					});
					if (ok) void run(async () => {
						await deleteRemoteBranch(workingTreePath, remote.name.replace(/^[^/]+\//, ''), remote.remote ?? '');
					});
				},
			})),
		];
		const tagItems = tagNames.map((name) => ({
			title: name,
			onClick: async () => {
				const ok = await showCheckbox({
					title: '删除标签', message: `确定删除标签 ${name}？`,
					checkboxLabel: '同时删除远程标签', danger: true,
				});
				if (ok) void run(async () => { await deleteTag(workingTreePath, name, state.remotes.length > 0 ? state.remotes[0].name : null); });
			},
		}));
		const target = event.currentTarget;
		target.classList.add('ggg-menu-target');
		showContextMenu({
			x: event.clientX, y: event.clientY,
			onClose: () => target.classList.remove('ggg-menu-target'),
			items: [
				{ title: '查看提交', disabled: isHead, onClick: () => { void selectCommit(commit.hash); } },
				{ title: '在 GitHub 上打开', visible: githubUrl !== null, onClick: () => { openExternal(githubUrl); } },
				{ type: 'divider' },
				{ title: '检出此提交', disabled: isHead, onClick: () => { void run(async () => { await checkoutCommit(workingTreePath, commit.hash); }); } },
				{ type: 'divider' },
				{ title: '从此提交创建分支…', disabled: isHead, onClick: async () => {
					const name = await showText({ title: '从此提交创建分支', label: '新分支名', placeholder: 'feature/xxx' });
					if (name !== null && name !== '') void run(async () => { await createBranch(workingTreePath, name, commit.hash, true); });
				} },
				{ title: '删除分支', disabled: isHead || branchItems.length === 0, children: branchItems },
				{ title: '从此提交创建标签…', disabled: isHead, onClick: async () => {
					const name = await showText({ title: '创建标签', label: '标签名', placeholder: 'v1.0.0' });
					if (name !== null && name !== '') void run(async () => { await addTag(workingTreePath, name, commit.hash, 0, '', false, null); });
				} },
				{ title: '删除标签', disabled: isHead || tagItems.length === 0, children: tagItems },
				{ type: 'divider' },
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
	}, [workingTreePath, run, selectCommit, state.remotes]);

	/** 分支标签（head / remote / tag）右键菜单。 */
	const openRefMenu = React.useCallback(({ commit, refInfo, event }) => {
		const x = event.clientX, y = event.clientY;
		const target = event.currentTarget;
		target.classList.add('ggg-menu-target');
		const onClose = () => target.classList.remove('ggg-menu-target');
		if (refInfo.type === 'head') {
			const name = refInfo.name;
			const isCurrent = name === state.head;
			showContextMenu({
				x, y, onClose,
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
				x, y, onClose,
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
				x, y, onClose,
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
			x, y, onClose,
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
	// 悬停卡片的括号内始终是详细时间：与主标签同源比较，相同就不重复。
	const dateDetail = React.useCallback(
		(seconds) => formatDate(seconds, { type: 0, iso: settings.dateFormat.iso === true }),
		[settings.dateFormat.iso],
	);
	const issueLinking = React.useCallback(() => issueLinkingConfigOf(settings), [settings]);

	if (state.phase === 'no-workspace') {
		return React.createElement('div', { className: 'ggg-empty' }, '该会话没有工作区目录');
	}

	return React.createElement(
		'div',
		{ className: 'ggg-root' },
		state.error !== null && React.createElement('div', { className: 'ggg-error' }, state.error),

		React.createElement(SettingsPanel, {
			open: settingsOpen, onClose: () => setSettingsOpen(false),
			settings, onChange: changeSettings, remotes: state.remotes, onDeleteRemote: deleteRemoteByName,
		}),

		filterOpen && React.createElement(RefFilterDialog, {
			refs: collectRefs(state.commits),
			selected: filterSelected, search: filterSearch,
			onSearch: setFilterSearch,
			onToggle: (name) => { setFilterAuto(false); setFilterSelected((previous) => {
				const next = new Set(previous);
				if (next.has(name)) next.delete(name);
				else next.add(name);
				return next;
			}); },
			onSelectAll: (checked) => { setFilterAuto(false); setFilterSelected(() => {
				if (!checked) return new Set();
				return new Set(collectRefs(state.commits).map((ref) => ref.name));
			}); },
			autoChecked: filterAuto,
			onToggleAuto: (checked) => {
				setFilterAuto(checked);
				if (checked) setFilterSelected(() => computeAutoRefs(state.commits, state.head));
				else setFilterSelected(new Set());
			},
			onClose: () => setFilterOpen(false),
		}),

		// ── 存储库 ──────────────────────────────────────────────
		React.createElement(
			'div',
			{ className: 'ggg-sec' },
			React.createElement('div', {
				className: 'ggg-sec-head' + (repoSecOpen ? '' : ' collapsed'),
				onClick: toggleRepoSec,
			},
				React.createElement(IconChevronDownOutlineRegular, { size: 14, className: 'ggg-chevron' }),
				'存储库',
				treeNote !== null && React.createElement('span', { className: 'ggg-sec-note', title: treeNote }, '⚠'),
				React.createElement('span', { className: 'ggg-head-actions' },
					React.createElement('button', {
						type: 'button', className: 'ggg-icon-btn', title: '设置', disabled: state.busy,
						onClick: (event) => { event.stopPropagation(); setSettingsOpen(true); },
					}, React.createElement(IconSettingsOutlineRegular, { size: 14 })),
				),
			),
			repoSecOpen && React.createElement(
				'div',
				{ className: 'ggg-repos', style: { maxHeight: repoHeight, overflowY: 'auto' } },
				treeStatus === 'loading' && React.createElement('div', { className: 'ggg-hint' }, '正在发现仓库…'),
				treeStatus !== 'loading' && visibleRows.length === 0
					&& React.createElement('div', { className: 'ggg-hint' }, '没有发现 git 仓库'),
				...visibleRows.map(({ node, depth }) => React.createElement(RepoRow, {
					key: node.id, node, depth,
					active: node.id === selectedId,
					expanded: expandedIds.has(node.id),
					sync: syncById.get(node.id),
					onSelect: selectNode,
					onToggle: toggleNode,
					onMoreActions: handleRepoMoreActions,
					onBranchClick: handleBranchClick,
					headHash: headCommitHash,
				})),
			),
			repoSecOpen && React.createElement('div', {
				className: 'ggg-sec-resize',
				title: '拖动调整存储库区高度',
				onPointerDown: startRepoResize,
			}),
		),

		// ── 更改 ──────────────────────────────────────────────
		React.createElement(
			'div',
			{ className: 'ggg-sec ggg-workspace' },
			React.createElement(
				'div',
				{ className: 'ggg-sec-head' },
				React.createElement(IconChevronDownOutlineRegular, { size: 14, className: 'ggg-chevron' }),
				'更改',
				React.createElement('span', { className: 'ggg-head-actions' },
					React.createElement('button', {
						type: 'button', className: 'ggg-icon-btn', title: '刷新', disabled: state.busy,
						onClick: (event) => { event.stopPropagation(); void run(() => refresh()); },
					}, React.createElement(IconRefreshOutlineRegular, { size: 14 })),
				),
			),
			React.createElement(
				'div',
				{ className: 'ggg-workspace-body' },
				// ── 提交框 ────────────────────────────────────────
				React.createElement(
					'div',
					{ className: 'ggg-commit-box' },
					React.createElement('div', { className: 'ggg-commit-input-wrap' },
						React.createElement('textarea', {
							className: 'ggg-commit-input',
							placeholder: `提交变更内容(Ctrl+Enter 在 '${state.head ?? 'master'}'提交)`,
							value: message,
							onChange: (event) => setMessage(event.currentTarget.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
									event.preventDefault();
									submit();
								}
							},
						}),
						React.createElement('div', { className: 'ggg-commit-input-actions' },
							React.createElement('button', {
								type: 'button', className: 'ggg-commit-input-btn', title: 'AI 辅助提交',
							}, React.createElement(IconSparkleRegular, { size: 14 })),
							React.createElement('button', {
								type: 'button', className: 'ggg-commit-input-btn', title: '选择提交方式',
							}, React.createElement(IconChevronDownOutlineRegular, { size: 14 })),
						),
					),
					React.createElement(Checkbox, { checked: amend, onChange: toggleAmend, label: '修补上一次提交' }),
					showSyncButton
						? React.createElement(Button, {
							variant: 'primary', size: 'sm', disabled: state.busy,
							onClick: handleSync,
						}, '同步更改',
							currentSync.behind > 0 && React.createElement('span', null, ` ↓${currentSync.behind}`),
							currentSync.ahead > 0 && React.createElement('span', null, ` ↑${currentSync.ahead}`),
						)
						: React.createElement(Button, {
							variant: 'primary', size: 'sm', disabled: state.busy || message.trim() === '' || stagedPaths.length === 0,
							onClick: submit,
						}, React.createElement(IconCheckOutlineRegular, { size: 15 }), '提交 Ctrl+Enter'),
				),
				ChangeGroup({
					staged: true, entries: state.entries, busy: state.busy, workingTreePath,
					groupKey: 'staged', collapsed: collapsedByGroup.staged, toggleChange, open: groupExpanded.staged, onToggleGroup: () => toggleGroup('staged'),
					run, stagePaths, unstagePaths, discardPaths, openDiff,
				}),
				ChangeGroup({
					staged: false, entries: state.entries, busy: state.busy, workingTreePath,
					groupKey: 'unstaged', collapsed: collapsedByGroup.unstaged, toggleChange, open: groupExpanded.unstaged, onToggleGroup: () => toggleGroup('unstaged'),
					run, stagePaths, unstagePaths, discardPaths, openDiff,
				}),
			),
		),

		// ── 图形 ────────────────────────────────────────────────
		React.createElement(
			'div',
			{ className: 'ggg-sec ggg-graph-sec' },
			// 拖拽手柄落在工作区与图形的分界线上（图形标题之前）。
			graphSecOpen && React.createElement('div', {
				className: 'ggg-sec-resize',
				title: '拖动调整图形区高度',
				onPointerDown: startGraphResize,
			}),
			React.createElement('div', {
				className: 'ggg-sec-head' + (graphSecOpen ? '' : ' collapsed'),
				onClick: toggleGraphSec,
			},
				React.createElement(IconChevronDownOutlineRegular, { size: 14, className: 'ggg-chevron' }),
				'图形',
				React.createElement('span', { className: 'ggg-head-actions' },
					selectedNode !== null && React.createElement('span', { className: 'ggg-head-repo' },
						React.createElement(RepoIcon),
						React.createElement('span', null, selectedNode.name),
					),
					React.createElement('button', {
						type: 'button', className: 'ggg-icon-btn', title: '筛选分支与标签',
						onClick: (event) => { event.stopPropagation(); setFilterOpen(true); },
					}, React.createElement(IconBranchOutlineRegular, { size: 14 }), '分支'),
					React.createElement('button', {
						type: 'button', className: 'ggg-icon-btn', title: '转到当前历史记录',
						onClick: (event) => { event.stopPropagation(); goToHead(); },
					}, React.createElement(IconGoalOutlineRegular, { size: 14 })),
					React.createElement('button', {
						type: 'button', className: 'ggg-icon-btn', title: '从所有远程抓取', disabled: state.busy,
						onClick: (event) => { event.stopPropagation(); void run(async () => { await fetchRepo(workingTreePath, null); }); },
					}, React.createElement(IconDownloadOutlineRegular, { size: 14 })),
					React.createElement('button', {
						type: 'button', className: 'ggg-icon-btn', title: '刷新', disabled: state.busy,
						onClick: (event) => { event.stopPropagation(); void run(() => refresh()); },
					}, React.createElement(IconRefreshOutlineRegular, { size: 14 })),
				),
			),
			graphSecOpen && (
				state.phase === 'loading' && state.commits.length === 0
					? React.createElement('div', { className: 'ggg-empty', style: { height: graphHeight } }, '正在加载提交图…')
					: React.createElement('div', {
						ref: graphScrollRef,
						style: { height: graphHeight, display: 'flex', flexDirection: 'column', minHeight: 0 },
					}, React.createElement(CommitGraph, {
						commits: filterCommitsByRefs(state.commits, filterSelected),
						head: state.head,
						selectedHash: state.selectedHash,
						aheadHashes: aheadBehind.ahead,
						behindHashes: aheadBehind.behind,
						onSelect: (hash) => { toggleCommit(hash); },
						onLoadMore: () => setMaxCommits((previous) => previous + 200),
						moreCommitsAvailable: state.more,
						onContextMenu: handleContextMenu,
						formatDate: dateFmt,
						formatDetail: dateDetail,
						issueLinking: issueLinking(),
						commitStats: statsByHash,
						onHoverCommit: hoverCommit,
						renderDetail: ({ commit }) => (state.detail !== null && state.detail.commit.hash === commit.hash
							? React.createElement(CommitDetail, {
								files: state.detail.files,
								busy: state.busy,
								collapsed: collapsedByGroup.detail,
								onToggle: (path) => toggleChange('detail', path),
								onOpen: (path) => { void openDiff(commit.hash, path, false); },
							})
							: null),
					}))
			),
		),
	);
}
