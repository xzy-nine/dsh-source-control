/**
 * 冲突分段解决、分段暂存与文件补丁块的客户端命令。
 *
 * 冲突的粒度是「这一段取哪边」，分段暂存的粒度是「这一块进不进索引」：两者都按
 * 下标指向宿主上一次解析出的段落或补丁块。
 */
import { callApi, callApiRaw, commandError } from './http.ts';

/** 分段可取的侧。 */
export type SectionSide = 'ours' | 'theirs' | 'both' | 'base' | 'none';

/**
 * 按段解决一处冲突。
 *
 * @param repo - 仓库路径。
 * @param filePath - 文件路径，相对仓库根。
 * @param index - 冲突段序号，从 0 开始。
 * @param side - 取哪一侧。
 * @returns 处理后文件里是否还有冲突标记。
 */
export async function resolveConflictSection(repo: string, filePath: string, index: number, side: SectionSide): Promise<boolean> {
	const payload = await callApi(repo, { command: 'resolveConflictSection', filePath, index, side });
	return payload.hasMarkers === true;
}

/**
 * 把整个文件里剩余的所有冲突按同一侧处理。
 *
 * @param repo - 仓库路径。
 * @param filePath - 文件路径，相对仓库根。
 * @param side - 取哪一侧。
 * @returns 处理后文件里是否还有冲突标记。
 */
export async function resolveAllConflictSections(repo: string, filePath: string, side: SectionSide): Promise<boolean> {
	const payload = await callApi(repo, { command: 'resolveAllConflictSections', filePath, side });
	return payload.hasMarkers === true;
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
