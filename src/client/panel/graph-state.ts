/**
 * 提交图状态的就地合并：把一轮快照写回现有面板状态，不换未变数据的引用。
 */
import {
	entriesEqual, mergeCommits, mergeEntries, uncommittedParentOf, withUncommittedCount,
} from './commit-diff.ts';
import type { WorkingTreeSnapshot } from '../api/index.ts';
import type { PanelState, RepoSync } from '../shared/types.ts';

/**
 * 把一轮工作区快照的分支状态转成仓库树的同步条目。
 *
 * 选中行由它取值：这一份来自当前快照，比仓库树的批量取数（loadReposSync，只在预加载与作废后
 * 重取）新，因此选中行与图形区显示同一个数。
 *
 * @param snapshot - 本轮工作区快照。
 * @returns 同步条目。
 */
export function syncOfSnapshot(snapshot: WorkingTreeSnapshot): RepoSync {
	return {
		branch: snapshot.branch, upstream: snapshot.upstream,
		ahead: snapshot.ahead, behind: snapshot.behind,
	};
}

/**
 * 按一轮快照就地修正条目与未提交伪提交行。
 *
 * 条目未变时保持原引用：更改区的树计算按 `entries` 记忆化。父提交必须已在列表中，宿主不再负责
 * 这一判定，两处补出该行的调用点共用同一判据。
 *
 * @param previous - 当前状态。
 * @param snapshot - 本轮工作区快照。
 * @returns 新状态；条目未变时除 error 外保持原引用。
 */
export function mergeSnapshot(previous: PanelState, snapshot: WorkingTreeSnapshot): PanelState {
	const entriesSame = entriesEqual(previous.entries, snapshot.entries);
	const parent = uncommittedParentOf(previous.commits, snapshot.head ?? previous.head);
	const commits = entriesSame
		? previous.commits
		: mergeCommits(previous.commits, withUncommittedCount(previous.commits, snapshot.entries.length, parent));
	return {
		// 手里已有本轮快照：变更列表那一路就是就绪的，与提交图是否还在取数无关。
		...previous, error: null, entriesPhase: 'ready', merging: snapshot.merging, entriesTruncated: snapshot.truncated,
		headHash: snapshot.head,
		upstream: snapshot.upstream, ahead: snapshot.ahead, behind: snapshot.behind,
		entries: entriesSame ? previous.entries : mergeEntries(previous.entries, snapshot.entries),
		commits,
	};
}
