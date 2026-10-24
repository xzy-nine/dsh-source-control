/**
 * 提交改动、完整提交信息、包含分支与文件差异内容查询。
 */
import { callApi } from './http.ts';

/** 提交改动文件。 */
export interface CommitFileEntry {
	readonly path: string;
	readonly type: string;
	readonly additions: number | null;
	readonly deletions: number | null;
}

/**
 * 从提交详情载荷里取改动文件并换算成本插件的形状。
 *
 * @param details - 宿主回投的 `commitDetails`。
 * @returns 改动文件列表。
 */
function fileEntriesOf(details: unknown): CommitFileEntry[] {
	const source = details !== null && typeof details === 'object' ? details as Record<string, unknown> : {};
	const changes = Array.isArray(source.fileChanges) ? source.fileChanges as Array<Record<string, unknown>> : [];
	return changes.map((change) => ({
		path: String(change.newFilePath),
		type: String(change.type),
		additions: typeof change.additions === 'number' ? change.additions : null,
		deletions: typeof change.deletions === 'number' ? change.deletions : null,
	}));
}

/**
 * 读取某个提交的改动文件。
 *
 * @param cwd - 会话工作区路径。
 * @param hash - 提交哈希，`*` 表示工作区未提交变更。
 * @param signal - 取消信号。
 * @returns 改动文件列表。
 */
export async function loadCommitFiles(cwd: string, hash: string, signal?: AbortSignal): Promise<CommitFileEntry[]> {
	const payload = await callApi(cwd, { command: 'commitDetails', commitHash: hash, hasParents: true, stash: null }, signal);
	return fileEntriesOf(payload.commitDetails);
}

/**
 * 一次提交详情里本插件用到的两部分：改动文件与完整提交信息。
 */
export interface CommitStatsAndMessage {
	/** 改动文件。 */
	readonly files: CommitFileEntry[];
	/** 完整提交信息；取不到时为 null。 */
	readonly message: string | null;
}

/**
 * 读取某个提交的改动文件与完整提交信息。
 *
 * 两者都由宿主的 `commitDetails` 一并给出，因此一次悬停只发一趟往返。分开取会把同一份
 * 提交详情读两次。
 *
 * @param cwd - 会话工作区路径。
 * @param hash - 提交哈希，`*` 表示工作区未提交变更。
 * @param signal - 取消信号。
 * @returns 改动文件与完整提交信息。
 */
export async function loadCommitStatsAndMessage(cwd: string, hash: string, signal?: AbortSignal): Promise<CommitStatsAndMessage> {
	const payload = await callApi(cwd, { command: 'commitDetails', commitHash: hash, hasParents: true, stash: null }, signal);
	const body = (payload.commitDetails as { body?: unknown } | null | undefined)?.body;
	return {
		files: fileEntriesOf(payload.commitDetails),
		message: typeof body === 'string' ? body : null,
	};
}

/**
 * 比较两个提交之间的改动文件。
 *
 * 方向为 `fromHash → toHash`；`toHash` 传 `*` 表示对比到工作区。后端按名称状态与
 * 行数统计给出改动列表，形状与提交详情一致。
 *
 * @param cwd - 会话工作区路径。
 * @param fromHash - 旧侧提交哈希。
 * @param toHash - 新侧提交哈希；`*` 表示工作区。
 * @param signal - 取消信号。
 * @returns 改动文件列表。
 */
export async function compareCommits(cwd: string, fromHash: string, toHash: string, signal?: AbortSignal): Promise<CommitFileEntry[]> {
	const payload = await callApi(cwd, { command: 'compareCommits', commitHash: toHash, compareWithHash: fromHash, fromHash, toHash, refresh: false }, signal);
	const changes = Array.isArray(payload.fileChanges) ? payload.fileChanges : [];
	return changes.map((change) => {
		const item = change as Record<string, unknown>;
		return {
			path: String(item.newFilePath),
			type: String(item.type),
			additions: typeof item.additions === 'number' ? item.additions : null,
			deletions: typeof item.deletions === 'number' ? item.deletions : null,
		};
	});
}

/**
 * 读取某个提交的完整提交信息。
 *
 * 提交列表里的 message 来自 `git log --format=%s`，只有标题一行；悬停卡片要显示完整
 * 正文，因此按需从 `commitDetails` 取（该命令的 `%B` 含完整消息）。
 *
 * @param cwd - 会话工作区路径。
 * @param hash - 提交哈希，`*` 表示工作区未提交变更。
 * @param signal - 取消信号。
 * @returns 完整提交信息；取不到时返回 null。
 */
export async function loadCommitMessage(cwd: string, hash: string, signal?: AbortSignal): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'commitDetails', commitHash: hash, hasParents: true, stash: null }, signal);
	const details = payload.commitDetails as { body?: unknown } | null | undefined;
	return details !== null && details !== undefined && typeof details.body === 'string' ? details.body : null;
}

/**
 * 取包含某个提交的分支（本地与远程）。
 *
 * 分支只由尖端提交标识，提交列表里中间提交的 `heads` 为空，因此不能凭它判断所属分支，
 * 需按包含关系向 git 查询。
 *
 * @param cwd - 会话工作区路径。
 * @param hash - 提交哈希。
 * @returns 本地与远程分支短名，以及被别的工作树检出的本地分支名。
 */
export async function branchesContaining(cwd: string, hash: string): Promise<{ local: string[]; remote: string[]; foreign: string[] }> {
	const payload = await callApi(cwd, { command: 'branchesContaining', commitHash: hash });
	const read = (value: unknown): string[] => Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
	return { local: read(payload.local), remote: read(payload.remote), foreign: read(payload.foreign) };
}

/** 差异内容。 */
export interface FileDiffContent {
	readonly path?: string;
	readonly oldText: string | null;
	readonly newText: string | null;
	/** 由 git 算出的逐块差异（形状同 DSH 的 WorkspaceDiffHunk）。 */
	readonly hunks: Array<{
		readonly oldStart: number;
		readonly oldLines: number;
		readonly newStart: number;
		readonly newLines: number;
		readonly lines: string[];
	}>;
}

/**
 * 取某个提交中某文件的前后内容与逐块差异。
 *
 * hunks 由宿主用 git 直接算出：前端本地 diff 在改动量超过其搜索上限时会退化成整文件
 * 「全删全加」，因此逐块差异优先。
 *
 * @param cwd - 会话工作区路径。
 * @param hash - 提交哈希；'*' 表示工作区。
 * @param path - 文件路径（相对仓库根）。
 * @param staged - 工作区时是否取暂存区内容。
 * @param baseHash - 旧侧提交哈希；非空时按 `baseHash → hash` 对比。
 * @returns 前后内容与逐块差异。
 */
export async function fileDiffContent(cwd: string, hash: string, path: string, staged = false, baseHash = ''): Promise<FileDiffContent> {
	const payload = await callApi(cwd, { command: 'fileDiffContent', commitHash: hash, filePath: path, staged, baseHash });
	const raw = Array.isArray(payload.hunks) ? payload.hunks : [];
	const hunks: FileDiffContent['hunks'] = raw.flatMap((item) => {
		const hunk = item as { oldStart?: unknown; oldLines?: unknown; newStart?: unknown; newLines?: unknown; lines?: unknown };
		if (typeof hunk.oldStart !== 'number' || typeof hunk.newStart !== 'number' || !Array.isArray(hunk.lines)) return [];
		const lines = hunk.lines.filter((line): line is string => typeof line === 'string');
		return [{
			oldStart: hunk.oldStart,
			oldLines: typeof hunk.oldLines === 'number' ? hunk.oldLines : lines.filter((line) => !line.startsWith('+')).length,
			newStart: hunk.newStart,
			newLines: typeof hunk.newLines === 'number' ? hunk.newLines : lines.filter((line) => !line.startsWith('-')).length,
			lines,
		}];
	});
	return {
		path: typeof payload.path === 'string' ? payload.path : path,
		oldText: typeof payload.oldText === 'string' ? payload.oldText : null,
		newText: typeof payload.newText === 'string' ? payload.newText : null,
		hunks,
	};
}
