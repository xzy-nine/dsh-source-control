/**
 * 工作树操作：移除链接工作树。
 */
import { gitOrThrow } from './git-exec.js';
import { resolveGitCommonDir } from './worktree-branches.js';

/**
 * 移除一个链接工作树。
 *
 * 主工作树不能被移除（git 报 `is a main working tree`）。工作树内有未提交改动时 git 会
 * 拒绝并要求 `--force`；目录已不存在时 git 会直接清理登记项，因此两种情况都不需要重试。
 *
 * git 子进程的工作目录不能落在被移除的工作树里：Windows 上该目录正被占用，删除会
 * `Permission denied`；工作目录本身也可能在移除后不存在，导致后续命令 `spawn git ENOENT`。
 * 因此从 `repo` 所在的工作树之外执行，拿不到仓库根时退回仓库自身的 git 公共目录。
 *
 * @param repo - 仓库路径（任意工作树均可）。
 * @param worktreePath - 要移除的工作树路径。
 * @param force - 是否强制移除有改动的工作树。
 * @returns 无。
 */
export async function removeWorktree(repo: string, worktreePath: string, force: boolean): Promise<void> {
	const args = force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath];
	await gitOrThrow(args, await removalCwd(repo));
}

/**
 * 取移除工作树时 git 的工作目录。
 *
 * 用仓库的 git 公共目录：它不在任何工作树内，因此既不会因待移除的工作树正被占用而
 * 删除失败，也不会在移除后消失。定位不到时退回调用方给出的路径。
 *
 * @param repo - 调用方给出的仓库路径。
 * @returns 可用的工作目录。
 */
async function removalCwd(repo: string): Promise<string> {
	return await resolveGitCommonDir(repo) ?? repo;
}
