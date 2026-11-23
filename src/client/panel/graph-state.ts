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
	const { upstream, upstreamRef, ahead, behind } = syncFieldsOf(snapshot);
	return { branch: snapshot.branch, upstream, upstreamRef, ahead, behind };
}

/**
 * 快照里的上游与领先/落后。
 *
 * 仓库树的同步条目与面板状态的两处合并都读这一组，读数因此只有一处。
 *
 * @param snapshot - 工作区快照。
 * @returns 上游、完整引用与领先/落后。
 */
function syncFieldsOf(snapshot: WorkingTreeSnapshot): Pick<RepoSync, 'upstream' | 'upstreamRef' | 'ahead' | 'behind'> {
	const { upstream, upstreamRef, ahead, behind } = snapshot;
	return { upstream, upstreamRef, ahead, behind };
}

/**
 * 快照里属于「分支同步」的那组字段。
 *
 * 一轮快照落进面板状态时，两处合并都要写回同一组：HEAD 哈希、上游与领先/落后。
 *
 * @param snapshot - 工作区快照。
 * @returns 可并入 PanelState 的分支字段。
 */
export function branchFieldsOf(snapshot: WorkingTreeSnapshot): Pick<
	PanelState,
	'headHash' | 'upstream' | 'upstreamRef' | 'ahead' | 'behind'
> {
	return { headHash: snapshot.head, ...syncFieldsOf(snapshot) };
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
		...branchFieldsOf(snapshot),
		entries: entriesSame ? previous.entries : mergeEntries(previous.entries, snapshot.entries),
		commits,
	};
}
