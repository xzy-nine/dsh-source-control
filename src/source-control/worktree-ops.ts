/**
 * 工作区读写：读取变更列表、暂存、取消暂存、提交。
 */
import { gitInPathBatches, gitOrThrow } from './git-exec.js';
import { parseStatus, type WorkingTreeEntry } from './status-parse.js';

/** 仓库尚无提交时 `git restore --staged` 的报错；git 会给出带引号的 HEAD。 */
const NO_HEAD_PATTERN = /could not resolve ['"]?HEAD['"]?|unknown revision|ambiguous argument ['"]?HEAD['"]?/i;

/**
 * 读取仓库的工作区变更。
 *
 * @param repo - 仓库路径。
 * @returns 变更列表，按路径排序。
 */
export async function loadWorkingTree(repo: string): Promise<WorkingTreeEntry[]> {
	const stdout = await gitOrThrow(['status', '--porcelain', '-z', '--untracked-files=all'], repo);
	return parseStatus(stdout).sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 暂存指定路径；不传路径时暂存全部变更。
 *
 * @param repo - 仓库路径。
 * @param paths - 要暂存的路径。
 * @returns 无。
 */
export function stagePaths(repo: string, paths: readonly string[]): Promise<string> {
	return paths.length === 0
		? gitOrThrow(['add', '--all'], repo)
		: gitInPathBatches(repo, (batch) => ['add', '--', ...batch], paths);
}

/**
 * 取消暂存指定路径；不传路径时取消全部。
 *
 * `git restore` 没有 `--all` 选项，取消全部用 pathspec `.`。
 * 仓库尚无提交（没有 HEAD）时 `restore --staged` 需要 HEAD 才能工作，退回从索引移除。
 *
 * @param repo - 仓库路径。
 * @param paths - 要取消暂存的路径。
 * @returns 无。
 */
export async function unstagePaths(repo: string, paths: readonly string[]): Promise<string> {
	// 空数组表示全部：restore 与 rm 都用 `.` 这个 pathspec。
	const target = paths.length === 0 ? ['.'] : [...paths];
	try {
		return await gitInPathBatches(repo, (batch) => ['restore', '--staged', '--', ...batch], target);
	} catch (error) {
		// 走查错误信息：仅当仓库没有 HEAD 时才退回 rm --cached，其余失败原样抛出。
		// git 的实际措辞带引号（could not resolve 'HEAD'），正则因此不能写死无引号形式。
		const message = error instanceof Error ? error.message : String(error);
		if (!NO_HEAD_PATTERN.test(message)) throw error;
		return gitInPathBatches(repo, (batch) => ['rm', '--cached', '-r', '--quiet', '--', ...batch], target);
	}
}

/**
 * 提交暂存区内容。
 *
 * 提交信息为空串时用 `--no-edit`，沿用 git 已有的待合并提交信息（`MERGE_MSG`）。
 * 非合并状态下该信息不存在，git 会以「提交信息为空」拒绝提交。
 * 修补上一次提交（`--amend`）且提交信息为空时拒绝执行：`--no-edit` 在修补语境下会沿用
 * 被修补提交的信息，与「空信息表示沿用合并信息」的约定不符。
 *
 * @param repo - 仓库路径。
 * @param message - 提交信息；空串表示沿用 git 生成的合并信息。
 * @param amend - 是否修补上一次提交。
 * @param skipHooks - 是否跳过提交钩子（`--no-verify`）。
 * @returns 新提交的完整哈希。
 */
export async function commitStaged(repo: string, message: string, amend: boolean, skipHooks = false): Promise<string> {
	if (amend && message.trim() === '') throw new Error('修补上一次提交需要提交信息。');
	const args = message.trim() === '' ? ['commit', '--no-edit'] : ['commit', '-m', message];
	if (skipHooks) args.push('--no-verify');
	if (amend) args.push('--amend');
	await gitOrThrow(args, repo);
	return (await gitOrThrow(['rev-parse', 'HEAD'], repo)).trim();
}
