/**
 * 仓库树批量领先/落后取数：每个仓库一次 `for-each-ref`，入队限流。
 */
import { BRANCH_SYNC_FORMAT, parseBranchSync } from './git-parse.js';
import { createLimiter } from './child-process.js';
import { logDebug } from './logger.js';
import { runGit } from './working-tree.js';

/** 仓库树批量领先/落后取数的并发上限。 */
const SYNC_CONCURRENCY = 5;

/**
 * 仓库树批量取数的限流器。
 *
 * 作用域仅限 {@link loadReposSync}：面板的单仓库命令不入队，宿主不串行化命令。
 */
const syncLimiter = createLimiter(SYNC_CONCURRENCY);

/**
 * 读取一个仓库相对其上游的领先/落后提交数。
 *
 * 常见路径一次 `for-each-ref` 取回全部分支与当前分支的上游跟踪信息；无提交的仓库
 * （`refs/heads` 为空）回退一次 `symbolic-ref`，此时只给出分支名。
 *
 * @param repo - 仓库路径。
 * @returns 分支、上游名与领先/落后数；无上游时两者为 0。
 */
export async function loadRepoSync(repo: string): Promise<{
	branch: string | null; upstream: string | null; ahead: number; behind: number;
}> {
	const refs = await runGit(['for-each-ref', '--format=' + BRANCH_SYNC_FORMAT, 'refs/heads'], repo);
	const sync = parseBranchSync(refs.stdout);
	if (sync.branch !== null) return sync;
	const head = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], repo);
	const branch = head.code === 0 ? head.stdout.trim() : '';
	if (branch === '') return { branch: null, upstream: null, ahead: 0, behind: 0 };
	return { branch, upstream: null, ahead: 0, behind: 0 };
}

/**
 * 批量读取多个仓库的分支同步状态。
 *
 * 入参按首次出现顺序去重，`path` 原样回显；单个仓库失败时以空状态兜底，不抛错。
 *
 * @param repos - 仓库路径。
 * @returns 每个入参仓库的同步状态，顺序与去重后的入参一致。
 */
export async function loadReposSync(repos: readonly string[]): Promise<Array<{
	path: string; branch: string | null; upstream: string | null; ahead: number; behind: number;
}>> {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const repo of repos) {
		if (seen.has(repo)) continue;
		seen.add(repo);
		unique.push(repo);
	}
	return Promise.all(unique.map((path) => syncLimiter(async () => {
		try {
			const sync = await loadRepoSync(path);
			return { path, branch: sync.branch, upstream: sync.upstream, ahead: sync.ahead, behind: sync.behind };
		} catch (error) {
			logDebug('repo', `读取仓库同步状态失败，按无上游处理：${path}：${error instanceof Error ? error.message : String(error)}`);
			return { path, branch: null, upstream: null, ahead: 0, behind: 0 };
		}
	})));
}
