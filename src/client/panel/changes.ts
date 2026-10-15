/**
 * 变更区：工作区变更的目录树纯函数，以及文件行、展开块与变更分组三个展示组件。
 *
 * 纯函数只做数据变换；数据加载与动作编排留在面板。
 */
import React from 'react';
import {
	FileTypeIcon, IconChevronDownOutlineRegular, IconCloseOutlineRegular,
	IconFolderOpenOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { copyText, showContextMenu, type ContextMenuItem } from '../context-menu.ts';
import { showConfirmation } from '../dialog.ts';
import { changeRowsOf, type ChangeRow } from './change-tree.ts';
import type { BusyScope, CommitFile, WorkingTreeEntry } from '../types.ts';
import css from '../css/changes.module.css';
import shared from '../css/shared.module.css';
import { MENU_TARGET_CLASS } from '../css/state-classes.ts';
import { cx } from '../css/cx.ts';

/** 变更条目的展示信息：状态字符与是否已暂存。 */
export interface ChangeInfo {
	readonly staged: boolean;
	readonly type: string;
	readonly untracked: boolean;
}

/**
 * 变更条目的展示信息：状态字符与是否已暂存。
 *
 * @param entry - 工作区条目。
 * @returns 展示信息。
 */
export function changeOf(entry: WorkingTreeEntry): ChangeInfo {
	const indexStatus = entry.index;
	const worktreeStatus = entry.worktree;
	const staged = indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '';
	// 展示用状态：已暂存看索引列，未暂存看工作区列。
	const type = staged ? indexStatus : (worktreeStatus === '?' ? 'U' : worktreeStatus);
	const untracked = indexStatus === '?' && worktreeStatus === '?';
	return { staged, type, untracked };
}

/** 拆分路径为「目录 + 文件名」，用于右侧对齐显示。 */
export function splitPath(path: string): { dir: string; name: string } {
	const at = path.lastIndexOf('/');
	return at === -1 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** 按 depth 生成的竖线层级占位。 */
function guidesOf(depth: number): React.ReactElement[] {
	const guides: React.ReactElement[] = [];
	for (let i = 0; i < depth; i++) guides.push(React.createElement('span', { key: i, className: shared.repoGuide }));
	return guides;
}

/** 变更树内的文件夹行或文件行。 */
export interface ChangeNodeRowProps {
	readonly row: ChangeRow;
	readonly busy: boolean;
	readonly open: boolean;
	readonly staged: boolean;
	readonly onToggle: (path: string) => void;
	readonly onStage: (paths: readonly string[]) => void;
	readonly onUnstage: (paths: readonly string[]) => void;
	readonly onDiscard: (paths: readonly string[], untracked: boolean) => void;
	/** 打开文件：isNew 为 true 时按普通文件打开（新文件没有可比差异）。 */
	readonly onOpen: (entry: WorkingTreeEntry, isNew: boolean) => void;
	readonly descendantsOf: (folderPath: string) => string[];
	/** 把路径加入 .gitignore。 */
	readonly onAddToGitignore: (path: string) => void;
	/** 把路径加入本地排除文件。 */
	readonly onAddToLocalExclude: (path: string) => void;
}

/**
 * 是否是新增文件：已暂存的新增（`A`）与未跟踪（`?`）都没有旧侧内容。
 *
 * @param entry - 工作区条目。
 * @returns 是新增文件时为 true。
 */
export function isNewFile(entry: WorkingTreeEntry): boolean {
	return entry.index === 'A' || (entry.index === '?' && entry.worktree === '?');
}

/** 文件夹行或文件行（变更树内）。 */
export function ChangeNodeRow({
	row, busy, open, staged, onToggle, onStage, onUnstage, onDiscard, onOpen, descendantsOf,
	onAddToGitignore, onAddToLocalExclude,
}: ChangeNodeRowProps): React.ReactElement {
	if (row.kind === 'folder') {
		const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
			event.preventDefault();
			event.stopPropagation();
			const target = event.currentTarget;
			target.classList.add(MENU_TARGET_CLASS);
			const paths = descendantsOf(row.path);
			const items: ContextMenuItem[] = [];
			if (staged) {
				items.push({ title: `取消暂存此文件夹（${paths.length}）`, disabled: busy || paths.length === 0, onClick: () => onUnstage(paths) });
			} else {
				items.push({ title: `暂存此文件夹（${paths.length}）`, disabled: busy || paths.length === 0, onClick: () => onStage(paths) });
				// 忽略规则只对未暂存的路径提出：已暂存的内容已经在版本控制里。
				items.push(
					{ type: 'divider' },
					{ title: '添加到 .gitignore', disabled: busy, onClick: () => onAddToGitignore(row.path) },
					{ title: '添加到本地排除', disabled: busy, onClick: () => onAddToLocalExclude(row.path) },
				);
			}
			items.push({ type: 'divider' }, { title: '复制路径', onClick: () => { void copyText(row.path); } });
			showContextMenu({ x: event.clientX, y: event.clientY, items, onClose: () => target.classList.remove(MENU_TARGET_CLASS) });
		};
		return React.createElement(
			'div',
			{
				className: cx(css.change, css.folder), title: row.path,
				onClick: () => onToggle(row.path), onContextMenu: handleContextMenu,
			},
			...guidesOf(row.depth),
			React.createElement('span', {
				className: cx(shared.repoChevron, !open && shared.isCollapsed),
			}, React.createElement(IconChevronDownOutlineRegular, { size: 12 })),
			React.createElement(IconFolderOpenOutlineRegular, { size: 14 }),
			React.createElement('span', { className: css.changeName }, row.name),
			React.createElement('span', { className: cx(css.rowTail, css.count) }, String(row.count)),
		);
	}
	const entry = row.entry;
	const fileStaged = staged;
	const type = staged ? entry.index : (entry.worktree === '?' ? 'U' : entry.worktree);
	const untracked = entry.index === '?' && entry.worktree === '?';
	// 新增文件（A 或未跟踪）没有旧侧内容，按普通文件打开。
	const isNew = isNewFile(entry);
	const { name } = splitPath(entry.path);
	const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
		event.preventDefault();
		const target = event.currentTarget;
		target.classList.add(MENU_TARGET_CLASS);
		const items: ContextMenuItem[] = [{ title: isNew ? '打开文件' : '打开', onClick: () => onOpen(entry, isNew) }, { type: 'divider' }];
		if (fileStaged) {
			items.push({ title: '取消暂存', disabled: busy, onClick: () => onUnstage([entry.path]) });
		} else {
			items.push({ title: '暂存改动', disabled: busy, onClick: () => onStage([entry.path]) });
			items.push({ title: '丢弃改动', danger: true, disabled: busy, onClick: () => onDiscard([entry.path], untracked) });
			// 忽略规则只对未暂存的路径提出：已暂存的内容已经在版本控制里。
			items.push(
				{ type: 'divider' },
				{ title: '添加到 .gitignore', disabled: busy, onClick: () => onAddToGitignore(entry.path) },
				{ title: '添加到本地排除', disabled: busy, onClick: () => onAddToLocalExclude(entry.path) },
			);
		}
		items.push({ type: 'divider' }, { title: '复制路径', onClick: () => { void copyText(entry.path); } });
		showContextMenu({ x: event.clientX, y: event.clientY, items, onClose: () => target.classList.remove(MENU_TARGET_CLASS) });
	};
	// 整行可点：点击文件行即打开该文件；悬停按钮只留暂存/丢弃这类会改状态的动作。
	const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
		if (busy) return;
		event.preventDefault();
		onOpen(entry, isNew);
	};
	return React.createElement(
		'div',
		{ className: cx(css.change, css.changeOpenable), title: entry.path, onClick: handleClick, onContextMenu: handleContextMenu },
		...guidesOf(row.depth),
		React.createElement(FileTypeIcon, { path: name, size: 14 }),
		React.createElement('span', { className: css.changeName },
			React.createElement('span', { className: css.changeText }, name)),
		// 悬停按钮排在状态字符之前：不悬停时状态字符落在最右列，与文件夹数量同列。
		fileStaged
			? React.createElement('button', {
				type: 'button', className: css.changeBtn, title: '取消暂存', disabled: busy,
				onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onUnstage([entry.path]); },
			}, React.createElement(IconCloseOutlineRegular, { size: 14 }))
			: React.createElement(
				React.Fragment,
				null,
				React.createElement('button', {
					type: 'button', className: css.changeBtn, title: '丢弃改动', disabled: busy,
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onDiscard([entry.path], untracked); },
				}, React.createElement(IconTrashOutlineRegular, { size: 14 })),
				React.createElement('button', {
					type: 'button', className: css.changeBtn, title: '暂存改动', disabled: busy,
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onStage([entry.path]); },
				}, React.createElement(IconPlusOutlineRegular, { size: 14 })),
			),
		React.createElement('span', { className: cx(css.rowTail, css.status), 'data-type': type }, type),
	);
}

/** 提交展开块里的改动文件列表。 */
export interface CommitDetailProps {
	readonly files: readonly CommitFile[];
	readonly busy: boolean;
	/** 是否仍在读取文件列表；false 时 files 为空即该提交确实没有改动。 */
	readonly loading: boolean;
	readonly collapsed: ReadonlySet<string>;
	readonly onToggle: (path: string) => void;
	/** 打开文件：isNew 为 true 时按普通文件打开（新增文件没有可比差异）。 */
	readonly onOpen: (path: string, isNew: boolean) => void;
}

/**
 * 提交改动文件列表；点击文件行在侧边栏打开文件视图。
 *
 * @param props - 见 {@link CommitDetailProps}。
 * @returns 文件列表元素。
 */
export function CommitDetail({ files, busy, loading, collapsed, onToggle, onOpen }: CommitDetailProps): React.ReactElement {
	if (files.length === 0) {
		// 读取中与「确实没有改动」必须分开：空提交（如 --allow-empty）不是加载中。
		return React.createElement('div', { className: shared.hint },
			loading ? '正在加载改动文件…' : '该提交没有文件改动');
	}
	const rows: ChangeRow<CommitFile>[] = changeRowsOf(files, collapsed);
	return React.createElement(
		'div',
		{ className: cx(css.changes, css.detailChanges) },
		...rows.map((row) => {
			if (row.kind === 'folder') {
				return React.createElement(
					'div',
					{
						key: `f:${row.path}`, className: cx(css.change, css.folder), title: row.path,
						onClick: () => onToggle(row.path),
					},
					...guidesOf(row.depth),
					React.createElement('span', {
						className: cx(shared.repoChevron, !row.open && shared.isCollapsed),
					}, React.createElement(IconChevronDownOutlineRegular, { size: 12 })),
					React.createElement(IconFolderOpenOutlineRegular, { size: 14 }),
					React.createElement('span', { className: css.changeName }, row.name),
					React.createElement('span', { className: css.count }, String(row.count)),
				);
			}
			const entry = row.entry;
			const { name } = splitPath(entry.path);
			const stat = entry.additions !== null && entry.additions !== undefined;
			// 提交里的 `A` 与工作区伪提交里的 `A`/`U` 都没有旧侧内容。
			const isNew = entry.type === 'A' || entry.type === 'U';
			return React.createElement(
				'div',
				{
					key: `e:${entry.path}`, className: cx(css.change, css.changeOpenable), title: entry.path,
					onClick: () => { if (!busy) onOpen(entry.path, isNew); },
				},
				...guidesOf(row.depth),
				React.createElement(FileTypeIcon, { path: name, size: 14 }),
				React.createElement('span', { className: css.status, 'data-type': entry.type }, entry.type),
				React.createElement('span', { className: css.changeName },
					React.createElement('span', { className: css.changeText }, name)),
				stat && React.createElement(
					'span',
					{ className: css.detailStat },
					React.createElement('span', { className: css.detailAdd }, `+${entry.additions}`),
					React.createElement('span', { className: css.detailDel }, `-${entry.deletions}`),
				),
			);
		}),
	);
}

/** 一个变更分组：暂存的更改 / 更改。 */
export interface ChangeGroupProps {
	readonly staged: boolean;
	readonly entries: readonly WorkingTreeEntry[];
	readonly busy: boolean;
	readonly workingTreePath: string;
	readonly collapsed: ReadonlySet<string>;
	readonly toggleChange: (key: string, path: string) => void;
	readonly groupKey: string;
	readonly open: boolean;
	readonly onToggleGroup: () => void;
	readonly run: (scope: BusyScope, operation: () => Promise<void>) => Promise<void>;
	readonly stagePaths: (cwd: string, paths: readonly string[]) => Promise<unknown>;
	readonly unstagePaths: (cwd: string, paths: readonly string[]) => Promise<unknown>;
	readonly discardPaths: (cwd: string, paths: readonly string[], untracked: boolean) => Promise<unknown>;
	readonly openDiff: (hash: string, path: string, staged: boolean, isNew?: boolean) => Promise<void>;
	/** 把路径加入 .gitignore。 */
	readonly onAddToGitignore: (path: string) => void;
	/** 把路径加入本地排除文件。 */
	readonly onAddToLocalExclude: (path: string) => void;
	readonly forceShow?: boolean;
}

/**
 * 一个变更分组：暂存的更改 / 更改。
 *
 * @param props - 见 {@link ChangeGroupProps}。
 * @returns 分组元素；无对应条目时返回空数组。
 */
export function ChangeGroup({
	staged, entries, busy, workingTreePath, collapsed, toggleChange, groupKey, open, onToggleGroup, run,
	stagePaths, unstagePaths, discardPaths, openDiff, onAddToGitignore, onAddToLocalExclude, forceShow,
}: ChangeGroupProps): React.ReactElement | [] {
	const visible = entries.filter((entry) => staged
		? (entry.index !== ' ' && entry.index !== '?')
		: (entry.worktree !== ' '));
	if (visible.length === 0 && !forceShow) return [];
	const rows: ChangeRow<WorkingTreeEntry>[] = changeRowsOf(visible, collapsed);
	const title = staged ? '暂存的更改' : '更改';
	const allPaths = visible.map((entry) => entry.path);
	const onStage = (paths: readonly string[]): void => { void run('commit', async () => { await stagePaths(workingTreePath, paths); }); };
	const onUnstage = (paths: readonly string[]): void => { void run('commit', async () => { await unstagePaths(workingTreePath, paths); }); };
	const onDiscard = (paths: readonly string[], untracked: boolean): void => {
		// 丢弃改动不可撤销：文件与文件夹右键、行内按钮、丢弃全部都经这里，统一先确认。
		void (async () => {
			const ok = await showConfirmation({
				title: '丢弃改动',
				// 未跟踪文件是被真正删除，而不是还原到某个版本，措辞需说清。
				message: untracked
					? (paths.length === 1
						? `确定删除未跟踪文件 ${paths[0]}？删除后无法恢复。`
						: `确定删除这 ${paths.length} 个未跟踪文件？删除后无法恢复。`)
					: (paths.length === 1
						? `确定丢弃 ${paths[0]} 的改动？未提交的改动会丢失，且无法恢复。`
						: `确定丢弃这 ${paths.length} 个文件的改动？未提交的改动会丢失，且无法恢复。`),
				confirmLabel: untracked ? '删除' : '丢弃', danger: true,
			});
			if (!ok) return;
			await run('commit', async () => { await discardPaths(workingTreePath, paths, untracked); });
		})();
	};
	/**
	 * 丢弃该分组内全部改动。
	 *
	 * 未跟踪文件要经 `git clean` 删除、已跟踪文件要经 `git restore` 还原，两者是不同的
	 * 命令；混在一批里下发会让 `git restore` 因无效 pathspec 整体失败。
	 */
	const onDiscardAll = (): void => {
		const tracked = visible.filter((entry) => !(entry.index === '?' && entry.worktree === '?')).map((entry) => entry.path);
		const untrackedPaths = visible.filter((entry) => entry.index === '?' && entry.worktree === '?').map((entry) => entry.path);
		void (async () => {
			const ok = await showConfirmation({
				title: '丢弃改动',
				message: untrackedPaths.length > 0
					? `确定丢弃这 ${allPaths.length} 个文件的改动？其中 ${untrackedPaths.length} 个未跟踪文件会被删除，均无法恢复。`
					: `确定丢弃这 ${allPaths.length} 个文件的改动？未提交的改动会丢失，且无法恢复。`,
				confirmLabel: '丢弃', danger: true,
			});
			if (!ok) return;
			await run('commit', async () => {
				if (tracked.length > 0) await discardPaths(workingTreePath, tracked, false);
				if (untrackedPaths.length > 0) await discardPaths(workingTreePath, untrackedPaths, true);
			});
		})();
	};
	const onOpen = (item: WorkingTreeEntry, isNew: boolean): void => { void openDiff('*', item.path, staged, isNew); };
	const descendantsOf = (folderPath: string): string[] => {
		const prefix = `${folderPath}/`;
		return visible.filter((entry) => entry.path.startsWith(prefix)).map((entry) => entry.path);
	};
	const handleHeadContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget;
		target.classList.add(MENU_TARGET_CLASS);
		const items: ContextMenuItem[] = staged
			? [{ title: `取消暂存全部（${allPaths.length}）`, disabled: busy, onClick: () => onUnstage(allPaths) }]
			: [
				{ title: `暂存全部（${allPaths.length}）`, disabled: busy, onClick: () => onStage(allPaths) },
				{ type: 'divider' },
				{ title: `丢弃全部（${allPaths.length}）`, danger: true, disabled: busy, onClick: onDiscardAll },
			];
		showContextMenu({ x: event.clientX, y: event.clientY, items, onClose: () => target.classList.remove(MENU_TARGET_CLASS) });
	};
	return React.createElement(
		'div',
		{ className: css.changeGroup },
		React.createElement(
			'div',
			{
				className: cx(css.change, css.groupRoot),
				onClick: () => onToggleGroup(),
				onContextMenu: handleHeadContextMenu,
			},
			React.createElement('span', {
				className: cx(shared.repoChevron, !open && shared.isCollapsed),
			}, React.createElement(IconChevronDownOutlineRegular, { size: 14 })),
			React.createElement('span', { className: css.groupTitle }, title),
			React.createElement('span', { className: css.count }, String(visible.length)),
		),
		open && React.createElement(
			'div',
			{ className: css.changes },
			...rows.map((row) => React.createElement(ChangeNodeRow, {
				key: row.kind === 'folder' ? `f:${row.path}` : `e:${row.entry.path}`,
				row, busy,
				open: row.kind === 'folder' && !collapsed.has(row.path),
				staged,
				onToggle: (path: string) => toggleChange(groupKey, path),
				onStage, onUnstage, onDiscard, onOpen,
				descendantsOf,
				onAddToGitignore, onAddToLocalExclude,
			})),
		),
	);
}
