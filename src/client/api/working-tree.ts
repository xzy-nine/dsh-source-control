/**
 * 工作区变更、暂存提交、工作树移除、贮藏与清理操作。
 */
import type { DiscardReport, SubmoduleDiscardReport, SubmoduleDiscardStatus, WorkingTreeEntry } from '../shared/types.ts';
import { callApi, callApiRaw, commandError } from './http.ts';

/**
 * 读取工作区变更。
 *
 * @param cwd - 会话工作区路径。
 * @param signal - 取消信号。
 * @returns 变更列表。
 */
export async function loadWorkingTree(cwd: string, signal?: AbortSignal): Promise<WorkingTreeEntry[]> {
	const payload = await callApi(cwd, { command: 'loadWorkingTree' }, signal);
	return (Array.isArray(payload.entries) ? payload.entries : []) as WorkingTreeEntry[];
}

/**
 * 暂存路径。
 *
 * @param cwd - 会话工作区路径。
 * @param paths - 要暂存的路径；空数组表示全部。
 * @returns 无。
 */
export async function stagePaths(cwd: string, paths: readonly string[]): Promise<void> {
	await callApi(cwd, { command: 'stagePaths', paths });
}

/**
 * 取消暂存路径。
 *
 * @param cwd - 会话工作区路径。
 * @param paths - 要取消暂存的路径；空数组表示全部。
 * @returns 无。
 */
export async function unstagePaths(cwd: string, paths: readonly string[]): Promise<void> {
	await callApi(cwd, { command: 'unstagePaths', paths });
}

/** 子模块结局的取值集合。 */
const SUBMODULE_STATUSES: ReadonlySet<string> = new Set(['moved', 'unchanged', 'blocked', 'uninitialized']);

/**
 * 从命令载荷读取丢弃结局。
 *
 * @param payload - 命令响应。
 * @param paths - 本次请求的路径，作为缺失字段的兜底。
 * @returns 丢弃结局。
 */
function readDiscardReport(payload: Record<string, unknown>, paths: readonly string[]): DiscardReport {
	const discarded = Array.isArray(payload.discarded)
		? (payload.discarded as unknown[]).filter((path): path is string => typeof path === 'string')
		: [...paths];
	const submodules: SubmoduleDiscardReport[] = [];
	if (Array.isArray(payload.submodules)) {
		for (const item of payload.submodules as unknown[]) {
			if (item === null || typeof item !== 'object') continue;
			const record = item as Record<string, unknown>;
			if (typeof record.path !== 'string') continue;
			const status = typeof record.status === 'string' && SUBMODULE_STATUSES.has(record.status)
				? record.status as SubmoduleDiscardStatus
				: 'unchanged';
			submodules.push({
				path: record.path,
				status,
				reason: typeof record.reason === 'string' ? record.reason : null,
				dirty: record.dirty === true,
			});
		}
	}
	const skippedRepositories = Array.isArray(payload.skippedRepositories)
		? (payload.skippedRepositories as unknown[]).filter((path): path is string => typeof path === 'string')
		: [];
	return { discarded, submodules, skippedRepositories };
}

/**
 * 丢弃路径上的改动。
 *
 * 子模块条目只移动其 HEAD，不清理子模块内部的未提交改动，结局由返回值回报。
 *
 * @param cwd - 会话工作区路径。
 * @param paths - 要丢弃的路径。
 * @param untracked - 这些路径是否都是未跟踪文件。
 * @returns 丢弃结局。
 */
export async function discardPaths(cwd: string, paths: readonly string[], untracked: boolean): Promise<DiscardReport> {
	const payload = await callApi(cwd, { command: 'discardPaths', paths, untracked });
	return readDiscardReport(payload, paths);
}

/**
 * 提交暂存区内容。
 *
 * @param cwd - 会话工作区路径。
 * @param message - 提交信息。
 * @param amend - 是否修补上一次提交。
 * @param skipHooks - 是否跳过提交钩子（`--no-verify`）。
 * @returns 新提交哈希。
 */
export async function commitStaged(cwd: string, message: string, amend = false, skipHooks = false): Promise<string> {
	const payload = await callApi(cwd, { command: 'commitStaged', message, amend, skipHooks });
	return typeof payload.hash === 'string' ? payload.hash : '';
}

/** 钩子探测结果。 */
export interface HooksState {
	/** 存在可执行的提交钩子。 */
	readonly commit: boolean;
	/** 存在可执行的推送钩子。 */
	readonly push: boolean;
	/** 钩子目录路径；无法定位时为 null。 */
	readonly directory: string | null;
}

/**
 * 探测仓库的 git 钩子状态。
 *
 * @param repo - 仓库路径。
 * @param signal - 取消信号。
 * @returns 提交钩子与推送钩子是否处于激活状态。
 */
export async function loadHooksState(repo: string, signal?: AbortSignal): Promise<HooksState> {
	const payload = await callApi(repo, { command: 'hooksState' }, signal);
	return {
		commit: payload.commit === true,
		push: payload.push === true,
		directory: typeof payload.directory === 'string' ? payload.directory : null,
	};
}

/**
 * 移除一个链接工作树。
 *
 * 主工作树不能被移除；工作树内有未提交改动时需 force。
 *
 * @param repo - 仓库路径。
 * @param worktreePath - 要移除的工作树路径。
 * @param force - 是否强制移除有改动的工作树。
 * @returns 无。
 */
export async function removeWorktree(repo: string, worktreePath: string, force: boolean): Promise<void> {
	await callApi(repo, { command: 'removeWorktree', worktreePath, force });
}

/**
 * 初始化一个子模块。
 *
 * 按 `.gitmodules` 与索引里的 gitlink 检出子模块工作区，其内部声明的子模块一并初始化。
 * 该命令可能访问远端。
 *
 * @param repo - 父仓库路径。
 * @param submodulePath - 子模块路径，相对仓库根或绝对路径。
 * @returns 无。
 */
export async function initSubmodule(repo: string, submodulePath: string): Promise<void> {
	await callApi(repo, { command: 'initSubmodule', submodulePath });
}

/**
 * 应用贮藏。
 *
 * @param cwd - 会话工作区路径。
 * @param selector - 贮藏选择器（如 stash@{0}）。
 * @param reinstateIndex - 是否恢复暂存区。
 * @returns 错误文本，无错误时返回 null。
 */
export async function applyStash(cwd: string, selector: string, reinstateIndex = false): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'applyStash', selector, reinstateIndex });
	return commandError(payload);
}

/**
 * 从贮藏创建分支。
 *
 * @param cwd - 会话工作区路径。
 * @param selector - 贮藏选择器。
 * @param branchName - 新分支名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function branchFromStash(cwd: string, selector: string, branchName: string): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'branchFromStash', selector, branchName });
	return commandError(payload);
}

/**
 * 丢弃贮藏。
 *
 * @param cwd - 会话工作区路径。
 * @param selector - 贮藏选择器。
 * @returns 错误文本，无错误时返回 null。
 */
export async function dropStash(cwd: string, selector: string): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'dropStash', selector });
	return commandError(payload);
}

/**
 * 弹出贮藏。
 *
 * @param cwd - 会话工作区路径。
 * @param selector - 贮藏选择器。
 * @param reinstateIndex - 是否恢复暂存区。
 * @returns 错误文本，无错误时返回 null。
 */
export async function popStash(cwd: string, selector: string, reinstateIndex = false): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'popStash', selector, reinstateIndex });
	return commandError(payload);
}

/**
 * 新建贮藏。
 *
 * @param cwd - 会话工作区路径。
 * @param message - 贮藏说明。
 * @param includeUntracked - 是否一并贮藏未跟踪文件。
 * @returns 错误文本，无错误时返回 null。
 */
export async function pushStash(cwd: string, message: string, includeUntracked = true): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'pushStash', message, includeUntracked });
	return commandError(payload);
}

/**
 * 清理未跟踪文件。
 *
 * @param cwd - 会话工作区路径。
 * @param directories - 是否连未跟踪目录一并删除。
 * @returns 错误文本，无错误时返回 null。
 */
export async function cleanUntrackedFiles(cwd: string, directories = false): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'cleanUntrackedFiles', directories });
	return commandError(payload);
}
