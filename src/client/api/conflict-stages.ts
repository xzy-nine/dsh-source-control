/**
 * 冲突条目的阶段查询客户端。
 *
 * 阶段决定某一侧是否还有内容（`采用我方/采用对方` 是否成立），宿主一次取回整批，
 * 变更区把结果按路径存进一个 Map。
 */
import { callApi } from './http.ts';
import type { ConflictStages } from '../shared/types.ts';

/**
 * 一批路径的阶段。
 *
 * @param repo - 仓库路径。
 * @param paths - 文件路径，相对仓库根。
 * @returns 路径到阶段的映射；未合并条目之外的路径不含在内。
 */
export async function loadConflictStagesOf(repo: string, paths: readonly string[]): Promise<ReadonlyMap<string, ConflictStages>> {
	const payload = await callApi(repo, { command: 'conflictStages', paths });
	const raw = Array.isArray(payload.stages) ? payload.stages : [];
	const out = new Map<string, ConflictStages>();
	for (const item of raw as unknown[]) {
		if (item === null || typeof item !== 'object') continue;
		const record = item as Record<string, unknown>;
		if (typeof record.path !== 'string') continue;
		out.set(record.path, {
			base: record.base === true,
			ours: record.ours === true,
			theirs: record.theirs === true,
		});
	}
	return out;
}

/** 解决动作的展示文案。 */
export const CONFLICT_ACTION_TEXT = {
	ours: '采用我方版本',
	theirs: '采用对方版本',
	delete: '删除文件',
	markResolved: '标记为已解决',
	restoreMarkers: '重新生成冲突标记',
} as const;
