/**
 * 变更条目到三个分组的归属，以及未合并条目的解决动作可用性。
 *
 * 与 React 无关的纯变换，便于直接单测。分组判据照白名单：索引列只认 `M`/`A`/`D`/`R`/`C`，
 * 工作区列只认 `M`/`D`/`R`/`A`/`T`。未合并条目的两列是 `U`/`A`/`D` 的组合，因此
 * 天然不落进「暂存的更改」与「更改」两组，不必逐条排除冲突。
 */
import { CONFLICT_KIND_CODE, conflictKindOfPair, type ConflictKind } from '../../shared/conflict-kind.ts';
import type { ConflictAction, ConflictStages, WorkingTreeEntry } from '../shared/types.ts';

/** 索引列里算作「已暂存」的状态码。 */
const INDEX_CODES: ReadonlySet<string> = new Set(['M', 'A', 'D', 'R', 'C']);

/** 工作区列里算作「未暂存改动」的状态码。 */
const WORKTREE_CODES: ReadonlySet<string> = new Set(['M', 'D', 'R', 'A', 'T']);

/**
 * 条目是否属于「暂存的更改」分组。
 *
 * @param entry - 工作区条目。
 * @returns 索引列有可暂存状态时为 true。
 */
export function indexGroupOf(entry: WorkingTreeEntry): boolean {
	return !isUnmerged(entry) && INDEX_CODES.has(entry.index);
}

/**
 * 条目是否属于「更改」分组。
 *
 * @param entry - 工作区条目。
 * @returns 工作区列有改动时为 true；未跟踪文件也算。
 */
export function worktreeGroupOf(entry: WorkingTreeEntry): boolean {
	if (isUnmerged(entry)) return false;
	return entry.index === '?' || WORKTREE_CODES.has(entry.worktree);
}

/**
 * 条目是否是未合并（冲突）条目。
 *
 * @param entry - 工作区条目。
 * @returns 宿主标记了 `unmerged`，或两列本身就是冲突组合时为 true。
 */
export function isUnmerged(entry: WorkingTreeEntry): boolean {
	return entry.unmerged === true || conflictKindOfPair(entry.index, entry.worktree) !== null;
}

/**
 * 取条目的冲突种类。
 *
 * @param entry - 工作区条目。
 * @returns 冲突种类；不是未合并条目时为 null。
 */
export function conflictKindOf(entry: WorkingTreeEntry): ConflictKind | null {
	return conflictKindOfPair(entry.index, entry.worktree);
}

/**
 * 取条目的状态字符：冲突条目显示两列原码。
 *
 * @param entry - 工作区条目。
 * @returns 两字符状态；识别不出冲突种类时退回两列原样。
 */
export function conflictCodeOf(entry: WorkingTreeEntry): string {
	const kind = conflictKindOf(entry);
	return kind === null ? entry.index + entry.worktree : CONFLICT_KIND_CODE[kind];
}

/** 把一批条目拆成两个普通组与一个冲突组。 */
export interface ConflictGroups {
	/** 「暂存的更改」分组。 */
	readonly staged: WorkingTreeEntry[];
	/** 「更改」分组。 */
	readonly unstaged: WorkingTreeEntry[];
	/** 「合并冲突」分组。 */
	readonly conflicts: WorkingTreeEntry[];
}

/**
 * 把一批条目按分组拆开。
 *
 * @param entries - 工作区条目。
 * @returns 三个分组各自的条目，保持原有顺序。
 */
export function conflictGroupsOf(entries: readonly WorkingTreeEntry[]): ConflictGroups {
	const staged: WorkingTreeEntry[] = [];
	const unstaged: WorkingTreeEntry[] = [];
	const conflicts: WorkingTreeEntry[] = [];
	for (const entry of entries) {
		if (isUnmerged(entry)) { conflicts.push(entry); continue; }
		// 既有暂存又有工作区改动的条目两组都进：两个分组各自按自己那一列判定。
		if (indexGroupOf(entry)) staged.push(entry);
		if (worktreeGroupOf(entry)) unstaged.push(entry);
	}
	return { staged, unstaged, conflicts };
}

/** 一个解决动作及它当前是否可用。 */
export interface ConflictActionItem {
	/** 动作标识。 */
	readonly action: ConflictAction;
	/** 菜单与按钮文案。 */
	readonly title: string;
	/** 当前是否可以执行。 */
	readonly enabled: boolean;
}

/** 各冲突种类在差异两侧的内容形态。 */
const AVAILABILITY: Readonly<Record<ConflictKind, readonly ConflictAction[]>> = {
	'both-modified': ['ours', 'theirs', 'markResolved', 'restoreMarkers'],
	'both-added': ['ours', 'theirs', 'markResolved', 'restoreMarkers'],
	'added-by-us': ['markResolved', 'restoreMarkers'],
	'added-by-them': ['markResolved', 'restoreMarkers'],
	'deleted-by-us': ['theirs', 'delete', 'markResolved'],
	'deleted-by-them': ['ours', 'delete', 'markResolved'],
	'both-deleted': ['markResolved'],
};

/** 动作文案。 */
const ACTION_TITLE: Readonly<Record<ConflictAction, string>> = {
	ours: '采用我方版本',
	theirs: '采用对方版本',
	delete: '删除文件',
	markResolved: '标记为已解决',
	restoreMarkers: '重新生成冲突标记',
};

/**
 * 取一个条目的可用解决动作。
 *
 * 「采用我方/采用对方」要求该侧在索引里有内容；「重新生成冲突标记」要求三个阶段齐备，
 * 因此阶段信息缺失时按不可用处理。
 *
 * @param entry - 工作区条目。
 * @param stages - 该条目的阶段；未查到时传 null。
 * @returns 动作清单，按固定顺序。
 */
export function conflictActionsOf(entry: WorkingTreeEntry, stages: ConflictStages | null): ConflictActionItem[] {
	const kind = conflictKindOf(entry);
	if (kind === null) return [];
	const actions = AVAILABILITY[kind];
	const usable = (action: ConflictAction): boolean => {
		if (!actions.includes(action)) return false;
		if (stages === null) return action === 'markResolved';
		if (action === 'ours') return stages.ours;
		if (action === 'theirs') return stages.theirs;
		if (action === 'restoreMarkers') return stages.base && stages.ours && stages.theirs;
		return true;
	};
	return (Object.keys(ACTION_TITLE) as ConflictAction[])
		.filter((action) => actions.includes(action))
		.map((action) => ({ action, title: ACTION_TITLE[action], enabled: usable(action) }));
}

/**
 * 数出已暂存的路径数：未合并条目不算已暂存。
 *
 * @param entries - 工作区条目。
 * @returns 已暂存条目数。
 */
export function stagedCountOf(entries: readonly WorkingTreeEntry[]): number {
	return entries.filter((entry) => indexGroupOf(entry)).length;
}

/**
 * 数出未解决的冲突条目数。
 *
 * @param entries - 工作区条目。
 * @returns 未合并条目数。
 */
export function unresolvedConflictCountOf(entries: readonly WorkingTreeEntry[]): number {
	return entries.filter((entry) => isUnmerged(entry)).length;
}
