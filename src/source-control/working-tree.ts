/**
 * 工作区变更、暂存提交、工作树与子模块操作的对外出口。
 *
 * 实现按职责分散在下列模块，本文件只做再导出，调用方与测试的导入路径因此保持不变：
 * - `git-exec.ts`：执行层（子进程、缓存、在途复用、空闲跟踪、写事件）
 * - `status-parse.ts`：`git status` 输出的纯解析
 * - `worktree-ops.ts`：读取变更、暂存、取消暂存、提交
 * - `discard.ts`：丢弃改动（含子模块条目）
 * - `worktree-remove.ts`：移除链接工作树
 * - `submodule-ops.ts`：初始化子模块与声明路径解析
 */
export type { GitResult, GitOptions, GitOperationKind } from './git-exec.js';
export {
	gitEnvironment, killRunningGit, isGitIdle, isWorktreeIdle, whenGitIdle, whenWorktreeIdle,
	onRepositoryWrite, notifyRepositoryWrite, runGit, describeGitArgs, isProbeCommand, gitSpawnCount, gitOrThrow,
} from './git-exec.js';
export type { WorkingTreeEntry, StatusRecord, WorkingTreeSnapshot } from './status-parse.js';
export { forEachStatusRecord, parseStatus, parseStatusSnapshot } from './status-parse.js';
export { loadWorkingTree, stagePaths, unstagePaths, commitStaged } from './worktree-ops.js';
export type { SubmoduleDiscardStatus, SubmoduleDiscardOutcome, DiscardOutcome } from './discard.js';
export { discardPaths } from './discard.js';
export { removeWorktree } from './worktree-remove.js';
export { initSubmodule } from './submodule-ops.js';
