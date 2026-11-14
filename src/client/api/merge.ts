/**
 * 分段暂存与冲突三方取数的客户端命令。
 *
 * 分段暂存的粒度是「这一块补丁进不进索引」；冲突则取三方文本后由页面算区间。
 * 两者都按宿主给出的下标或整份内容工作，页面不重复解析 git 输出。
 */
import { callApi, callApiRaw, commandError } from './http.ts';
import type { MergeChoice } from '../../shared/merge-ranges.ts';

/** 一个补丁块的范围。 */
export interface FileHunk {
	readonly index: number;
	readonly header: string;
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
}

/**
 * 暂存或取消暂存文件里的若干补丁块。
 *
 * @param repo - 仓库路径。
 * @param filePath - 文件路径，相对仓库根。
 * @param indexes - 补丁块下标；空数组表示整份补丁。
 * @param direction - `stage` 写进索引，`unstage` 退回工作区。
 * @returns 错误文本；成功为 null。
 */
export async function applyHunk(repo: string, filePath: string, indexes: readonly number[], direction: 'stage' | 'unstage'): Promise<string | null> {
	const payload = await callApiRaw(repo, { command: 'applyHunk', filePath, indexes, direction });
	return commandError(payload);
}

/**
 * 取一个文件当前的补丁块范围。
 *
 * @param repo - 仓库路径。
 * @param filePath - 文件路径，相对仓库根。
 * @param staged - true 取索引相对 HEAD 的补丁块，false 取工作区相对索引的。
 * @returns 各块的范围。
 */
export async function loadFileHunks(repo: string, filePath: string, staged: boolean): Promise<FileHunk[]> {
	const payload = await callApi(repo, { command: 'fileHunks', filePath, staged });
	const raw = Array.isArray(payload.hunks) ? payload.hunks : [];
	return (raw as unknown[]).flatMap((item) => {
		if (item === null || typeof item !== 'object') return [];
		const record = item as Record<string, unknown>;
		if (typeof record.index !== 'number') return [];
		return [{
			index: record.index,
			header: typeof record.header === 'string' ? record.header : '',
			oldStart: typeof record.oldStart === 'number' ? record.oldStart : 0,
			oldLines: typeof record.oldLines === 'number' ? record.oldLines : 0,
			newStart: typeof record.newStart === 'number' ? record.newStart : 0,
			newLines: typeof record.newLines === 'number' ? record.newLines : 0,
		}];
	});
}

/** 一份三方内容。 */
export interface MergeContentsPayload {
	/** 基线；双方新增时没有基线段，为 null。 */
	readonly base: string | null;
	/** 我方。 */
	readonly ours: string | null;
	/** 对方。 */
	readonly theirs: string | null;
	/** 工作区当前内容，用于提示「已手工改过」。 */
	readonly worktree: string | null;
}

/**
 * 取一个冲突路径的三方内容。
 *
 * @param repo - 仓库路径。
 * @param filePath - 文件路径，相对仓库根。
 * @returns 三方内容。
 */
export async function loadMergeContents(repo: string, filePath: string): Promise<MergeContentsPayload> {
	const payload = await callApi(repo, { command: 'mergeContents', filePath });
	return {
		base: typeof payload.base === 'string' ? payload.base : null,
		ours: typeof payload.ours === 'string' ? payload.ours : null,
		theirs: typeof payload.theirs === 'string' ? payload.theirs : null,
		worktree: typeof payload.worktree === 'string' ? payload.worktree : null,
	};
}

/**
 * 把区间取舍交回宿主，由它算出结果并写回工作区。
 *
 * @param repo - 仓库路径。
 * @param filePath - 文件路径，相对仓库根。
 * @param choices - 区间序号到取舍。
 * @returns 写回后仍有多少处冲突未处理。
 */
export async function applyMergeChoices(repo: string, filePath: string, choices: ReadonlyMap<number, MergeChoice>): Promise<number> {
	const payload = await callApi(repo, {
		command: 'applyMerge',
		filePath,
		choices: [...choices.entries()].map(([index, choice]) => ({ index, choice })),
	});
	return typeof payload.unresolved === 'number' ? payload.unresolved : 0;
}
