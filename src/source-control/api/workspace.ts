/**
 * 工作区相关命令：变更列表、快照、暂存、提交、丢弃、忽略规则、工作树与子模块、钩子探测、包含分支查询。
 */
import { commitStaged, loadWorkingTree, stagePaths, unstagePaths } from '../worktree-ops.js';
import { discardPaths } from '../discard.js';
import { removeWorktree } from '../worktree-remove.js';
import { initSubmodule } from '../submodule-ops.js';
import { detectHooks } from '../hooks.js';
import { addToGitignore, addToLocalExclude, localExcludeState } from '../ignore.js';
import { readHooksPath, readSnapshot, writeHooksPath, writeSnapshot } from '../host-cache.js';
import { getWorkingTreeSnapshot } from '../git-query.js';
import { branchesOfOtherWorktrees } from '../repo-discovery.js';
import { gitOrThrow, runGit, whenWorktreeIdle } from '../git-exec.js';
import { repoHeadHash } from '../repo-facts.js';
import { logDebug, logInfo } from '../logger.js';
import type { ApiContext } from './context.js';

/** 非仓库路径上返回的空工作区快照。 */
const EMPTY_SNAPSHOT = {
	entries: [] as unknown[],
	head: null,
	branch: null,
	upstream: null,
	ahead: 0,
	behind: 0,
	merging: false,
	error: null,
};

/**
 * 处理工作区域的一条命令。
 *
 * @param ctx - 命令上下文。
 * @returns 是否已处理；未识别的命令返回 false。
 */
export async function handleWorkspaceCommand(ctx: ApiContext): Promise<boolean> {
	const { msg, repo, str, bool, arr, isRepoPath, respond, respondResult, sendBadRequest } = ctx;
	void msg; void sendBadRequest;
	switch (ctx.command) {
		case 'loadWorkingTree':
			await respondResult('loadWorkingTree', async () => {
				// 写操作（暂存/提交/检出等）未结束时先等它结束：否则会读到写了一半的工作区。
				// 抓取不算：它不改工作区，等它会让面板在抓取期间白等几秒。
				await whenWorktreeIdle(repo);
				return { repo, entries: await loadWorkingTree(repo) };
			});
			break;
		case 'loadWorkingTreeSnapshot': {
			// 结果自带 error 字段，因此不经 respondResult —— 它会在展开后再写一次 error: null。
			// 只读工作区：抓取期间照常读，不必等它结束。
			await whenWorktreeIdle(repo);
			/*
			 * 非仓库路径直接回空快照，不起子进程：工作区根常常只是一层目录，对它取数会让
			 * 每条 git 命令都以 `not a git repository` 失败。
			 */
			if (!(await isRepoPath(repo))) {
				logDebug('repo', `目标路径不是 git 仓库，按空工作区返回：${repo}`);
				respond({ command: 'loadWorkingTreeSnapshot', repo, ...EMPTY_SNAPSHOT });
				break;
			}
			/*
			 * 快照键含 HEAD：外部进程的提交不产生写事件，缓存无从主动作废；带上 HEAD 后
			 * 那次提交不会命中提交前的条目。HEAD 由文件与分支引用解析，不起子进程。
			 *
			 * `noCache` 用于兜底轮询：它靠「读到当前值」发现插件之外的改动，命中缓存会让条目
			 * 签名永远不变，外部保存再也检测不到。写操作已失效缓存，写后重读不受本开关影响。
			 */
			const cachedSnapshot = bool('noCache') ? undefined : readSnapshot(repo, await repoHeadHash(repo));
			if (cachedSnapshot !== undefined) {
				logDebug('cache', `工作区快照命中缓存：${repo}`);
				respond({ command: 'loadWorkingTreeSnapshot', repo, ...cachedSnapshot });
				break;
			}
			const snapshot = await getWorkingTreeSnapshot(repo);
			// 失败结果同样缓存：紧接着的重试会命中，避免连续失败反复起 git。
			writeSnapshot(repo, snapshot);
			respond({ command: 'loadWorkingTreeSnapshot', repo, ...snapshot });
			break;
		}
		case 'stagePaths':
			await respondResult('stagePaths', async () => {
				const paths = arr<string>('paths');
				await stagePaths(repo, paths);
				logInfo('repo', `已暂存 ${String(paths.length)} 个路径：${paths.slice(0, 5).join('、')}${paths.length > 5 ? ' 等' : ''}`);
				return { repo };
			});
			break;
		case 'unstagePaths':
			await respondResult('unstagePaths', async () => {
				const paths = arr<string>('paths');
				await unstagePaths(repo, paths);
				logInfo('repo', `已取消暂存 ${String(paths.length)} 个路径：${paths.slice(0, 5).join('、')}${paths.length > 5 ? ' 等' : ''}`);
				return { repo };
			});
			break;
		case 'discardPaths':
			await respondResult('discardPaths', async () => {
				const paths = arr<string>('paths');
				const untracked = bool('untracked');
				const outcome = await discardPaths(repo, paths, untracked);
				logInfo('repo', `已丢弃 ${String(paths.length)} 个${untracked ? '未跟踪' : '已跟踪'}路径的改动`);
				return { repo, ...outcome };
			});
			break;
		case 'commitStaged':
			await respondResult('commitStaged', async () => {
				const amend = bool('amend');
				const skipHooks = bool('skipHooks');
				const hash = await commitStaged(repo, str('message'), amend, skipHooks);
				logInfo('repo', `提交成功${amend ? '（修补上一次提交）' : ''}${skipHooks ? '（已跳过钩子）' : ''}：${hash}`);
				return { repo, hash };
			});
			break;
		case 'addToGitignore':
			await respondResult('addToGitignore', async () => ({ result: await addToGitignore(repo, str('path')) }));
			break;
		case 'addToLocalExclude':
			await respondResult('addToLocalExclude', async () => ({ state: await addToLocalExclude(repo, str('path')) }));
			break;
		case 'localExcludeState':
			await respondResult('localExcludeState', async () => {
				// 非仓库路径没有本地排除文件：直接回空，不起 git rev-parse。
				if (!(await isRepoPath(repo))) return { state: null };
				return { state: await localExcludeState(repo) };
			});
			break;
		case 'removeWorktree':
			await respondResult('removeWorktree', async () => {
				const worktreePath = str('worktreePath');
				const force = bool('force');
				await removeWorktree(repo, worktreePath, force);
				logInfo('repo', `已移除工作树${force ? '（强制）' : ''}：${worktreePath}`);
				return { repo, worktreePath };
			});
			break;
		case 'initSubmodule':
			await respondResult('initSubmodule', async () => {
				const submodulePath = str('submodulePath');
				await initSubmodule(repo, submodulePath);
				logInfo('repo', `已初始化子模块：${submodulePath}`);
				return { repo, submodulePath };
			});
			break;
		case 'hooksState':
			await respondResult('hooksState', async () => {
				// 非仓库路径没有钩子目录：直接回空，不起 git config 与文件系统探测。
				if (!(await isRepoPath(repo))) return { repo, commit: false, push: false, directory: null };
				/*
				 * `core.hooksPath` 由 git 解析（含 includeIf 等条件），因此读它的取值而不是只看
				 * `.git/hooks`；读取失败时按未配置处理，退回默认钩子目录。
				 *
				 * 取值缓存 60s：同一仓库反复切换不必每次起一个 `git config`。钩子文件是否存在仍现读，
				 * 因此增删钩子文件立刻可见；配置本身的变化不走写事件，由 `invalidateCache` 作废。
				 */
				let hooksPath = readHooksPath(repo);
				if (hooksPath === undefined) {
					const configured = await runGit(['config', '--get', 'core.hooksPath'], repo);
					hooksPath = configured.code === 0 ? configured.stdout.trim() : '';
					writeHooksPath(repo, hooksPath);
				}
				const state = await detectHooks(repo, hooksPath);
				// 钩子决定提交与推送是否要带 --no-verify，判定结果值得留一条记录。
				logInfo('hooks', `钩子探测：${repo} 提交钩子=${state.commit ? '有' : '无'}、推送钩子=${state.push ? '有' : '无'}，目录 ${state.directory ?? '（无法定位）'}`);
				return { repo, commit: state.commit, push: state.push, directory: state.directory };
			});
			break;
		case 'branchesContaining':
			// 分支只由尖端提交标识，中间提交的 heads 为空；按包含关系查询才能列出所属分支。
			await respondResult('branchesContaining', async () => {
				const hash = str('commitHash');
				const localOut = await gitOrThrow(['branch', '--contains', hash, '--format=%(refname:short)'], repo);
				// 别的工作树占用的分支不可删除，不作为删除候选；`foreign` 另行回投，供调用方禁用相关操作。
				const foreign = await branchesOfOtherWorktrees(repo);
				const local = localOut.split('\n').map((line) => line.trim())
					.filter((line) => line !== '' && !foreign.has(line));
				const remoteOut = await gitOrThrow(['branch', '-r', '--contains', hash, '--format=%(refname:short)'], repo);
				// 远程 HEAD 是符号引用，短名只显示远程名本身（如 `origin`），须排除。
				const remoteNames = new Set((await gitOrThrow(['remote'], repo)).split('\n').map((line) => line.trim()));
				const remote = remoteOut.split('\n').map((line) => line.trim())
					.filter((line) => line !== '' && !line.endsWith('/HEAD') && !remoteNames.has(line));
				return { repo, local, remote, foreign: [...foreign] };
			});
			break;
		default:
			return false;
	}
	return true;
}