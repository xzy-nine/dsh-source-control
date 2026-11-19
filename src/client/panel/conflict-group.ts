/**
 * 变更区的「合并冲突」分组：未合并条目的行、行内解决动作与右键菜单。
 *
 * 冲突条目没有 stage 0，暂存与丢弃对它们无效（`git restore` 会以 `is unmerged` 失败），
 * 因此这一组的行内动作换成解决动作。分组常驻在暂存/未暂存两组之前，与 VS Code 的
 * 「Merge Changes」同一位置；没有冲突时不渲染。
 */
import React from 'react';
import { IconChevronDownOutlineRegular, IconCheckOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { showContextMenu } from '../ui/context-menu.ts';
import { changeRowsOf, type ChangeRow } from './change-tree.ts';
import { ChangeFileShell, ChangeFolderRow } from './changes.ts';
import { conflictActionsOf, conflictCodeOf, conflictKindOf } from './conflicts.ts';
import { CONFLICT_KIND_TEXT } from '../../shared/conflict-kind.ts';
import { changeMenuItems } from './change-menu.ts';
import { splitPath } from './changes.ts';
import type { ChangeMenuDeps } from './change-menu.ts';
import type { ChangeActions, ConflictAction, ConflictStages, WorkingTreeEntry } from '../shared/types.ts';
import css from '../css/changes.module.css';
import shared from '../css/shared.module.css';
import { MENU_TARGET_CLASS } from '../css/state-classes.ts';
import { cx } from '../css/cx.ts';

/** 合并冲突分组的属性。 */
export interface ConflictGroupProps extends ChangeActions {
	readonly entries: readonly WorkingTreeEntry[];
	readonly busy: boolean;
	readonly collapsed: ReadonlySet<string>;
	readonly toggleChange: (key: string, path: string) => void;
	readonly groupKey: string;
	readonly open: boolean;
	readonly onToggleGroup: () => void;
	/** 各冲突路径的阶段；未查到或已解决的路径缺省。 */
	readonly stagesByPath: ReadonlyMap<string, ConflictStages>;
	/** 打开冲突文件的差异页。 */
	readonly onOpen: (entry: WorkingTreeEntry) => void;
	/** 执行一个解决动作；失败原因由面板统一报出。 */
	readonly onResolve: (paths: readonly string[], action: ConflictAction) => void;
	/** 菜单依赖面；冲突行的菜单同样走 change-menu 注册表。 */
	readonly menu: ChangeMenuDeps;
}

/**
 * 生成某个冲突行在其种类下可用的动作按钮。
 *
 * @param entry - 冲突条目。
 * @param stages - 该条目的阶段。
 * @param busy - 是否正在执行仓库操作。
 * @param onResolve - 执行动作。
 * @returns 按钮元素。
 */
function conflictButtons(
	entry: WorkingTreeEntry,
	stages: ConflictStages | null,
	busy: boolean,
	onResolve: (paths: readonly string[], action: ConflictAction) => void,
): React.ReactNode[] {
	const usable = conflictActionsOf(entry, stages).filter((item) => item.enabled && item.action !== 'restoreMarkers');
	const nodes: React.ReactNode[] = [];
	for (const item of usable) {
		nodes.push(React.createElement('button', {
			key: item.action, type: 'button', className: css.changeBtn, title: item.title,
			disabled: busy,
			onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
				event.stopPropagation();
				onResolve([entry.path], item.action);
			},
		}, item.action === 'markResolved'
			? React.createElement(IconCheckOutlineRegular, { size: 14 })
			: React.createElement('span', { className: css.conflictActionText }, item.action === 'ours' ? '我' : item.action === 'theirs' ? '他' : '删')));
	}
	return nodes;
}

/**
 * 合并冲突分组。
 *
 * @param props - 见 {@link ConflictGroupProps}。
 * @returns 分组元素；没有未合并条目时返回空数组。
 */
function ConflictGroupView({
	entries, busy, collapsed, toggleChange, groupKey, open, onToggleGroup, stagesByPath, onOpen, onResolve, menu,
}: ConflictGroupProps): React.ReactElement | [] {
	const conflicts = React.useMemo(() => entries.filter((entry) => conflictKindOf(entry) !== null), [entries]);
	const rows = React.useMemo<ChangeRow[]>(() => changeRowsOf(conflicts, collapsed), [conflicts, collapsed]);
	if (conflicts.length === 0) return [];
	const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>, entry: WorkingTreeEntry): void => {
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget;
		target.classList.add(MENU_TARGET_CLASS);
		showContextMenu({
			x: event.clientX, y: event.clientY,
			items: changeMenuItems({
				target: 'file', deps: menu, path: entry.path, paths: [entry.path], count: 1, entry, untracked: false,
			}),
			onClose: () => { target.classList.remove(MENU_TARGET_CLASS); },
		});
	};
	return React.createElement(
		'div',
		{ className: css.changeGroup },
		React.createElement(
			'div',
			{ className: cx(css.change, css.groupRoot), onClick: () => { onToggleGroup(); } },
			React.createElement('span', { className: cx(shared.repoChevron, !open && shared.isCollapsed) },
				React.createElement(IconChevronDownOutlineRegular, { size: 14 })),
			React.createElement('span', { className: css.groupTitle }, '合并冲突'),
			React.createElement('span', { className: css.count }, String(conflicts.length)),
		),
		open && React.createElement(
			'div',
			{ className: css.changes },
			...rows.map((row) => {
				if (row.kind === 'folder') {
					return React.createElement(ChangeFolderRow, {
						key: 'f:' + row.path, row, open: row.open,
						onToggle: () => { toggleChange(groupKey, row.path); },
					});
				}
				const entry = row.entry;
				const kind = conflictKindOf(entry);
				const { name } = splitPath(entry.path);
				const code = conflictCodeOf(entry);
				return React.createElement(
					ChangeFileShell,
					{
						key: 'e:' + entry.path, name, depth: row.depth,
						title: kind === null ? entry.path : `${entry.path}（${CONFLICT_KIND_TEXT[kind]}）`,
						onClick: () => { if (!busy) onOpen(entry); },
						onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => { handleContextMenu(event, entry); },
					},
					...conflictButtons(entry, stagesByPath.get(entry.path) ?? null, busy, onResolve),
					React.createElement('span', { className: cx(css.rowTail, css.status, css.conflictStatus), 'data-type': code }, code),
				);
			}),
		),
	);
}

export const ConflictGroup = React.memo(ConflictGroupView);
