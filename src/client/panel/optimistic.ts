/**
 * 乐观更新：写操作成功后按 git 的索引/工作区语义就地推算新的条目，不必等整轮重读。
 *
 * 状态码为 `git status --porcelain` 的 XY 两列，语义与 changeOf 一致。推算结果只是即时反馈，
 * 随后由一次对账刷新纠正：推算与实际不一致时以刷新结果为准。
 */
import type { WorkingTreeEntry } from '../shared/types.ts';

/** 目标路径的两种形态：精确路径与目录 pathspec（带尾斜杠）。 */
interface PathTargets {
	readonly files: ReadonlySet<string>;
	/** 目录 pathspec，带尾斜杠；命中其下全部条目。 */
	readonly directories: readonly string[];
}

/**
 * 把路径列表拆成精确路径与目录 pathspec。
 *
 * 目录行下发的是带尾斜杠的目录：git 按目录整体执行，这里同样按目录匹配条目，
 * 不把子文件逐条展开。
 *
 * @param paths - 目标路径。
 * @returns 两种形态。
 */
function pathTargets(paths: readonly string[]): PathTargets {
	const files = new Set<string>();
	const directories: string[] = [];
	for (const path of paths) {
		if (path.endsWith('/')) directories.push(path);
		else files.add(path);
	}
	return { files, directories };
}

/**
 * 是否命中给定路径集合：当前路径、重命名/复制前的路径与所在目录 pathspec 都算命中。
 *
 * @param entry - 工作区条目。
 * @param targets - 目标路径的两种形态。
 * @returns 命中时为 true。
 */
function matches(entry: WorkingTreeEntry, targets: PathTargets): boolean {
	if (targets.files.has(entry.path)) return true;
	if (typeof entry.origPath === 'string' && targets.files.has(entry.origPath)) return true;
	return targets.directories.some((directory) => entry.path.startsWith(directory));
}

/**
 * 工作区变更的签名：路径与状态码逐条拼接。
 *
 * @param entries - 工作区条目。
 * @returns 签名文本。
 */
export function entriesSignature(entries: readonly WorkingTreeEntry[]): string {
	return entries.map((entry) => `${entry.path}:${entry.index}${entry.worktree}`).join('\n');
}

/**
 * 暂存路径：把工作区的内容与状态并入索引。
 *
 * - 未跟踪（`??`）变成新增（`A `）。
 * - 其余把工作区列的状态移到索引列，工作区列清空（` M` → `M `、`MM` → `M `）。
 *
 * @param entries - 当前条目。
 * @param paths - 被暂存的路径。
 * @returns 新条目。
 */
export function stageEntries(entries: readonly WorkingTreeEntry[], paths: readonly string[]): WorkingTreeEntry[] {
	const target = pathTargets(paths);
	return entries.map((entry) => {
		if (!matches(entry, target)) return entry;
		if (entry.index === '?' && entry.worktree === '?') {
			return { ...entry, index: 'A', worktree: ' ' };
		}
		const nextIndex = entry.worktree !== ' ' ? entry.worktree : entry.index;
		return { ...entry, index: nextIndex, worktree: ' ' };
	});
}

/**
 * 取消暂存路径：把索引列的状态退回工作区。
 *
 * - 新增（`A `）退回为未跟踪（`??`）：该文件此前不在版本控制中。
 * - 其余把索引列的状态移到工作区列（`M ` → ` M`、`D ` → ` D`）。
 *
 * @param entries - 当前条目。
 * @param paths - 被取消暂存的路径。
 * @returns 新条目。
 */
export function unstageEntries(entries: readonly WorkingTreeEntry[], paths: readonly string[]): WorkingTreeEntry[] {
	const target = pathTargets(paths);
	return entries.map((entry) => {
		if (!matches(entry, target)) return entry;
		if (entry.index === 'A') return { ...entry, index: '?', worktree: '?' };
		const nextWorktree = entry.index !== ' ' ? entry.index : entry.worktree;
		return { ...entry, index: ' ', worktree: nextWorktree };
	});
}

/**
 * 丢弃路径的改动。
 *
 * 未跟踪文件被删除、已跟踪文件还原到索引内容，因此这些条目要么消失、要么只剩已暂存部分：
 *
 * - 未跟踪（`??`）整条移除。
 * - 有已暂存部分（索引列非空）时保留该部分，工作区列清空（`MM` → `M `）。
 * - 只有工作区改动（索引列为空）时整条移除。
 *
 * @param entries - 当前条目。
 * @param paths - 被丢弃的路径。
 * @returns 新条目。
 */
export function discardEntries(entries: readonly WorkingTreeEntry[], paths: readonly string[]): WorkingTreeEntry[] {
	const target = pathTargets(paths);
	const kept: WorkingTreeEntry[] = [];
	for (const entry of entries) {
		if (!matches(entry, target)) { kept.push(entry); continue; }
		if (entry.index === '?' && entry.worktree === '?') continue;
		if (entry.index === ' ' || entry.index === '?') continue;
		kept.push({ ...entry, worktree: ' ' });
	}
	return kept;
}

/**
 * 提交暂存内容后清掉已暂存条目：索引恢复干净，只保留仍未暂存的工作区改动。
 *
 * @param entries - 当前条目。
 * @returns 新条目。
 */
export function commitEntries(entries: readonly WorkingTreeEntry[]): WorkingTreeEntry[] {
	const kept: WorkingTreeEntry[] = [];
	for (const entry of entries) {
		const staged = entry.index !== ' ' && entry.index !== '?' && entry.index !== '';
		if (!staged) { kept.push(entry); continue; }
		// 工作区仍有改动时退回未暂存（`M ` → ` M`）；否则该条目已随提交消失。
		if (entry.worktree === ' ' || entry.worktree === '?') continue;
		kept.push({ ...entry, index: ' ', worktree: entry.worktree });
	}
	return kept;
}
