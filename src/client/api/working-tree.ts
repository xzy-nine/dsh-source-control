/**
 * 工作区变更、暂存提交、工作树移除、贮藏与清理操作。
 */
import type { WorkingTreeEntry } from '../types.ts';
import { callApi, callApiRaw } from './http.ts';

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

/**
 * 丢弃路径上的改动。
 *
 * @param cwd - 会话工作区路径。
 * @param paths - 要丢弃的路径。
 * @param untracked - 这些路径是否都是未跟踪文件。
 * @returns 无。
 */
export async function discardPaths(cwd: string, paths: readonly string[], untracked: boolean): Promise<void> {
	await callApi(cwd, { command: 'discardPaths', paths, untracked });
}

/**
 * 提交暂存区内容。
 *
 * @param cwd - 会话工作区路径。
 * @param message - 提交信息。
 * @param amend - 是否修补上一次提交。
 * @returns 新提交哈希。
 */
export async function commitStaged(cwd: string, message: string, amend = false): Promise<string> {
	const payload = await callApi(cwd, { command: 'commitStaged', message, amend });
	return typeof payload.hash === 'string' ? payload.hash : '';
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
 * 应用贮藏。
 *
 * @param cwd - 会话工作区路径。
 * @param selector - 贮藏选择器（如 stash@{0}）。
 * @param reinstateIndex - 是否恢复暂存区。
 * @returns 错误文本，无错误时返回 null。
 */
export async function applyStash(cwd: string, selector: string, reinstateIndex = false): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'applyStash', selector, reinstateIndex });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
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
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
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
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
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
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
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
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
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
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}
