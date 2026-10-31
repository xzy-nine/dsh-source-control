/**
 * 提交图状态的就地合并：把一轮快照写回现有面板状态，不换未变数据的引用。
 */
import {
	entriesEqual, mergeCommits, mergeEntries, uncommittedParentOf, withUncommittedCount,
} from './commit-diff.ts';
import type { WorkingTreeSnapshot } from '../api/index.ts';
import type { PanelState, RepoSync } from '../shared/types.ts';

/**
 * 把一个快照的分支、上游与领先/落后写回选中节点。
 *
 * 领先/落后与条目来自同一次读取，因此调用点都在拿到快照之后，不再单独请求。
 *
 * @param setSyncById - 节点同步状态的写入器。
 * @param selectedId - 选中节点 id；null 时不写。
 * @param snapshot - 本轮工作区快照。
 * @returns 无。
 */
export function writeSync(
	setSyncById: React.Dispatch<React.SetStateAction<Map<string, RepoSync>>>,
	selectedId: string | null,
	snapshot: WorkingTreeSnapshot,
): void {
	if (selectedId === null) return;
	setSyncById((previous) => {
		const current = previous.get(selectedId);
		/* 四项都未变时返回原 Map：仓库行按该引用记忆化，每轮换新 Map 会让它跟着重渲染。 */
		if (current !== undefined
			&& current.branch === snapshot.branch && current.upstream === snapshot.upstream
			&& current.ahead === snapshot.ahead && current.behind === snapshot.behind) {
			return previous;
		}
		return new Map(previous).set(selectedId, {
			branch: snapshot.branch, upstream: snapshot.upstream,
			ahead: snapshot.ahead, behind: snapshot.behind,
		});
	});
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
		...previous, error: null, merging: snapshot.merging,
		headHash: snapshot.head, upstream: snapshot.upstream,
		entries: entriesSame ? previous.entries : mergeEntries(previous.entries, snapshot.entries),
		commits,
	};
}
