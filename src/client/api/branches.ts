/**
 * 分支与提交级操作：检出、创建、删除、重命名、合并、变基、拣选与重置。
 */
import { callApi, callApiRaw, commandError, firstError } from './http.ts';

/** 合并到选中分支的结果。 */
export interface MergeIntoBranchResult {
	/** 错误文本，无错误时为 null。 */
	readonly error: string | null;
	/** 检出并合并后所在的分支名。 */
	readonly branchName: string;
	/** git 生成的初始合并提交信息；无待合并状态时为 null。 */
	readonly mergeMessage: string | null;
	/** 是否因冲突而停下。 */
	readonly conflicted: boolean;
}

/**
 * 检出指定分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 分支名。
 * @param remoteBranch - 新建并跟踪的远程分支；本地已有时传 null。
 * @returns 错误文本，无错误时返回 null。
 */
export async function checkoutBranch(cwd: string, branchName: string, remoteBranch: string | null = null): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'checkoutBranch', branchName, remoteBranch });
	return firstError(payload);
}

/**
 * 从某提交创建分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 新分支名。
 * @param commitHash - 起点提交哈希。
 * @param checkout - 创建后是否检出。
 * @param force - 是否强制覆盖同名分支。
 * @returns 错误文本，无错误时返回 null。
 */
export async function createBranch(cwd: string, branchName: string, commitHash: string, checkout = true, force = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'createBranch', branchName, commitHash, checkout, force });
	return firstError(payload);
}

/**
 * 删除本地分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 分支名。
 * @param forceDelete - 是否强制删除未合并分支。
 * @param deleteOnRemotes - 同时删除的远程分支名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function deleteBranch(cwd: string, branchName: string, forceDelete = false, deleteOnRemotes: readonly string[] = []): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'deleteBranch', branchName, forceDelete, deleteOnRemotes });
	return firstError(payload);
}

/**
 * 重命名分支。
 *
 * @param cwd - 会话工作区路径。
 * @param oldName - 原分支名。
 * @param newName - 新分支名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function renameBranch(cwd: string, oldName: string, newName: string): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'renameBranch', oldName, newName });
	return commandError(payload);
}

/**
 * 删除远程分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 远程分支短名（含远程前缀由 remote 拼接）。
 * @param remote - 远程名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function deleteRemoteBranch(cwd: string, branchName: string, remote: string): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'deleteRemoteBranch', branchName, remote });
	return commandError(payload);
}

/**
 * 把远程分支取到同名本地分支。
 *
 * @param cwd - 会话工作区路径。
 * @param remote - 远程名。
 * @param remoteBranch - 远程分支名。
 * @param localBranch - 本地分支名。
 * @param force - 是否强制覆盖本地分支。
 * @returns 错误文本，无错误时返回 null。
 */
export async function fetchIntoLocalBranch(cwd: string, remote: string, remoteBranch: string, localBranch: string, force = false): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'fetchIntoLocalBranch', remote, remoteBranch, localBranch, force });
	return commandError(payload);
}

/**
 * 把远程分支拉入当前分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 远程分支名。
 * @param remote - 远程名。
 * @param createNewCommit - 是否生成合并提交。
 * @param squash - 是否压缩合并。
 * @returns 错误文本，无错误时返回 null。
 */
export async function pullBranch(cwd: string, branchName: string, remote: string, createNewCommit = false, squash = false): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'pullBranch', branchName, remote, createNewCommit, squash });
	return commandError(payload);
}

/**
 * 检出指定提交（分离 HEAD）。
 *
 * @param cwd - 会话工作区路径。
 * @param commitHash - 提交哈希。
 * @returns 错误文本，无错误时返回 null。
 */
export async function checkoutCommit(cwd: string, commitHash: string): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'checkoutCommit', commitHash });
	return commandError(payload);
}

/**
 * 把提交拣选到当前分支。
 *
 * @param cwd - 会话工作区路径。
 * @param commitHash - 提交哈希。
 * @param parentIndex - 合并提交要拣选的父提交序号；非合并提交传 -1。
 * @param recordOrigin - 是否在提交信息记录来源。
 * @param noCommit - 是否只应用改动不提交。
 * @returns 错误文本，无错误时返回 null。
 */
export async function cherrypickCommit(cwd: string, commitHash: string, parentIndex = -1, recordOrigin = false, noCommit = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'cherrypickCommit', commitHash, parentIndex, recordOrigin, noCommit });
	return firstError(payload);
}

/**
 * 把当前分支重置到指定提交。
 *
 * @param cwd - 会话工作区路径。
 * @param commitHash - 目标提交哈希。
 * @param resetMode - 重置模式。
 * @returns 错误文本，无错误时返回 null。
 */
export async function resetToCommit(cwd: string, commitHash: string, resetMode = 'mixed'): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'resetToCommit', commit: commitHash, resetMode });
	return commandError(payload);
}

/**
 * 在指定提交上生成还原提交。
 *
 * @param cwd - 会话工作区路径。
 * @param commitHash - 要还原的提交哈希。
 * @param parentIndex - 合并提交要还原的父提交序号；非合并提交传 -1。
 * @returns 错误文本，无错误时返回 null。
 */
export async function revertCommit(cwd: string, commitHash: string, parentIndex = -1): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'revertCommit', commitHash, parentIndex });
	return commandError(payload);
}

/**
 * 把目标合并进当前分支。
 *
 * @param cwd - 会话工作区路径。
 * @param obj - 目标分支名或提交哈希。
 * @param createNewCommit - 是否生成合并提交。
 * @param squash - 是否压缩合并。
 * @param noCommit - 是否只应用改动不提交。
 * @returns 错误文本，无错误时返回 null。
 */
export async function merge(cwd: string, obj: string, createNewCommit = false, squash = false, noCommit = false): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'merge', obj, actionOn: 'Branch', createNewCommit, squash, noCommit });
	return commandError(payload);
}

/**
 * 检出选中分支，并把检出前的当前分支合并过去，停在未提交状态。
 *
 * 宿主固定使用 `--no-ff --no-commit`，因此目标分支即使是当前分支的祖先也会建立待合并
 * 状态并生成提交信息。冲突时同样保持待合并状态，`mergeMessage` 仍会给出。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 要检出并合并到的分支名。
 * @param commitHash - 该分支的尖端提交哈希；宿主据此校验合并目标。
 * @param message - 合并提交信息；空串表示使用 git 生成的初始信息。
 * @returns 分支名、初始合并信息、冲突标记与错误文本。
 */
export async function mergeIntoBranch(cwd: string, branchName: string, commitHash: string, message = ''): Promise<MergeIntoBranchResult> {
	const payload = await callApiRaw(cwd, { command: 'mergeIntoBranch', branchName, commitHash, message });
	return {
		error: commandError(payload),
		branchName: typeof payload.branchName === 'string' ? payload.branchName : branchName,
		mergeMessage: typeof payload.mergeMessage === 'string' ? payload.mergeMessage : null,
		conflicted: payload.conflicted === true,
	};
}

/**
 * 把当前分支变基到目标。
 *
 * @param cwd - 会话工作区路径。
 * @param obj - 目标分支名或提交哈希。
 * @param ignoreDate - 是否保留原提交时间。
 * @param interactive - 是否交互式变基。
 * @returns 错误文本，无错误时返回 null。
 */
export async function rebase(cwd: string, obj: string, ignoreDate = true, interactive = false): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'rebase', obj, actionOn: 'Branch', ignoreDate, interactive });
	return commandError(payload);
}
