/**
 * 仓库发现：从工作区根按层递归寻找最多三层的 git 仓库，并枚举各仓库的工作树与子模块。
 *
 * 递归只用于仓库发现。子模块按 `.gitmodules` 判定、工作树按 git 公共目录下的登记项读取，
 * 两者都不参与递归、不受层数限制，工作树可位于工作区根之外。
 *
 * 实现按职责分散在下列模块，本文件只做发现流程与再导出：
 * - `repo-node.ts`：节点类型、路径归一与目录探测
 * - `repo-enrich.ts`：仓库节点构造与工作树、子模块补齐
 * - `repo-discovery-cache.ts`：60 秒 TTL 发现缓存与作废
 * - `repo-sync.ts`：批量领先/落后取数
 */
import { dirname, resolve } from 'node:path';
import { listRepoLocationWorkspaces, readRepoLocations, writeRepoLocations } from './state-store.js';
import { logDebug } from './logger.js';
import { watchRepositories, watchWorkspace } from './repo-watcher.js';
import { foreignWorktreeBranches, readWorktrees, resolveGitCommonDir } from './worktree-branches.js';
import {
	DEFAULT_MAX_DEPTH, DEFAULT_MAX_DIRECTORIES, dedupeCandidates, gitEntryOf, hasGitEntry, nodeId, subdirectories,
} from './repo-node.js';
import type { DiscoveryOptions, DiscoveryResult, RepoNode } from './repo-node.js';
import { linkedWorktreePresence, repoNodeOf } from './repo-enrich.js';
import { discoveryCacheKey, readDiscoveryCache, writeDiscoveryCache } from './repo-discovery-cache.js';

export type { RepoNodeKind, RepoNode, DiscoveryResult, DiscoveryOptions } from './repo-node.js';
export { DEFAULT_MAX_DEPTH, DEFAULT_MAX_DIRECTORIES, nodeId, dedupeCandidates, shouldPruneDirectory, parseHead, gitEntryOf, hasGitEntry, subdirectories } from './repo-node.js';
export { linkedWorktreePresence, repoNodeOf, enrichRepositories } from './repo-enrich.js';
export { clearDiscoveryCache, invalidateDiscoveryCacheFor } from './repo-discovery-cache.js';
export { loadRepoSync, loadReposSync } from './repo-sync.js';

/**
 * 解析 `.gitmodules` 中的子模块路径。
 *
 * @param source - `.gitmodules` 文本。
 * @returns 相对仓库根的子模块路径，按出现顺序。
 */
export { parseSubmodulePaths } from './submodule-parse.js';

/**
 * 发现工作区根下的仓库，并补齐工作区根所属的仓库。
 *
 * 结果进 60 秒 TTL 的模块内缓存（容量 16）；缓存命中直接返回同一对象，调用方不得修改。
 *
 * @param root - 工作区根目录。
 * @param options - 层数、目录数上限与已知仓库位置。
 * @returns 仓库扁平列表与是否被截断。
 */
export async function discoverRepositories(root: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
	const key = discoveryCacheKey(root, options);
	const cached = readDiscoveryCache(key);
	if (cached !== null) return cached;
	const result = await scanRepositories(root, options);
	writeDiscoveryCache(key, result);
	return result;
}

/** 工作区发现的选项。 */
export interface WorkspaceDiscoveryOptions {
	/** 只产出顶层仓库节点；工作树与子模块由 {@link enrichRepositories} 补齐。 */
	readonly shallow?: boolean;
	/** 跳过持久化的仓库位置，直接完整扫描并写回缓存。 */
	readonly fullScan?: boolean;
	/** 完整扫描的最大递归层数。 */
	readonly maxDepth?: number;
	/** 显式给出的顶层仓库路径；非空时优先于持久化的仓库位置。 */
	readonly knownRepos?: readonly string[];
}

/** 一次工作区发现的结果，附带是否用了已知的仓库位置。 */
export type WorkspaceDiscoveryResult = DiscoveryResult & {
	/** 是否走了已知仓库位置的快路径。 */
	readonly usedCache: boolean;
};

/**
 * 发现一个工作区根的仓库。
 *
 * 未指定 `fullScan: true` 时先取已知的顶层仓库位置：入参 `knownRepos` 非空时用它，否则读宿主
 * 持久化的仓库位置；非空即走已知路径快路径，为空时完整扫描。`fullScan: true` 时跳过已知位置，
 * 完整扫描后把顶层仓库位置写回持久化缓存。结果进与 {@link discoverRepositories} 同一份
 * 60 秒 TTL 缓存，键区分 shallow 与 full。
 *
 * @param root - 工作区根目录。
 * @param options - 浅层、强制完整扫描与层数开关。
 * @returns 仓库扁平列表、是否被截断与是否走了已知仓库位置的快路径。
 */
export async function discoverWorkspace(
	root: string,
	options: WorkspaceDiscoveryOptions = {},
): Promise<WorkspaceDiscoveryResult> {
	const shallow = options.shallow === true;
	const explicit = options.knownRepos ?? [];
	const known = options.fullScan === true
		? []
		: (explicit.length > 0 ? explicit : readRepoLocations(root).map((repo) => repo.path));
	const result = await discoverRepositories(root, {
		shallow,
		knownRepos: known,
		maxDepth: options.maxDepth,
	});
	if (options.fullScan === true) {
		writeRepoLocations(root, result.nodes
			.filter((node) => node.kind === 'repo')
			.map((node) => ({ path: node.path, name: node.name })));
	}
	return { nodes: result.nodes, truncated: result.truncated, usedCache: known.length > 0 };
}

/**
 * 收尾一次发现：补上工作区根所属的仓库，并按路径排序。
 *
 * @param root - 工作区根目录。
 * @param nodes - 已发现的仓库节点，就地补入所属仓库。
 * @param visited - 已访问目录标识。
 * @param submoduleIds - 子模块路径标识。
 * @returns 无。
 */
async function finishDiscovery(
	root: string,
	nodes: RepoNode[],
	visited: Set<string>,
	submoduleIds: Set<string>,
): Promise<void> {
	const enclosing = await enclosingRepo(root, visited, submoduleIds);
	if (enclosing !== null) nodes.unshift(enclosing);
	nodes.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 扫描工作区根下的仓库：逐层并行探测，层内按入队顺序去重与计数。
 *
 * @param root - 工作区根目录。
 * @param options - 层数、目录数上限与已知仓库位置。
 * @returns 仓库扁平列表与是否被截断。
 */
async function scanRepositories(root: string, options: DiscoveryOptions): Promise<DiscoveryResult> {
	// 缓存命中：只核对已知路径，跳过整层目录扫描。
	if (options.knownRepos !== undefined && options.knownRepos.length > 0) {
		return discoverKnownRepositories(root, options.knownRepos, options.shallow === true);
	}
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
	const nodes: RepoNode[] = [];
	const submoduleIds = new Set<string>();
	const visited = new Set<string>();
	let visitedCount = 0;
	let truncated = false;
	let level: Array<{ dir: string; depth: number }> = [{ dir: resolve(root), depth: 0 }];
	while (level.length > 0) {
		// 层内先按入队顺序去重与计数，得到本层待处理项。
		const pending: Array<{ dir: string; depth: number }> = [];
		for (const current of level) {
			if (visitedCount >= maxDirectories) {
				truncated = true;
				break;
			}
			visitedCount++;
			const id = nodeId(current.dir);
			if (visited.has(id) || submoduleIds.has(id)) continue;
			visited.add(id);
			pending.push(current);
		}
		const entries = await Promise.all(pending.map((current) => gitEntryOf(current.dir)));
		const repoIndexes: number[] = [];
		entries.forEach((entry, index) => { if (entry === 'dir') repoIndexes.push(index); });
		// 仓库节点与子目录并发取；两者都完成后才进入下一层，子模块去重集合才完整。
		const [repoNodes, children] = await Promise.all([
			Promise.all(repoIndexes.map((index) =>
				repoNodeOf(pending[index].dir, pending[index].depth, submoduleIds, options.shallow === true))),
			Promise.all(pending.map((current, index) => entries[index] === 'file' || current.depth >= maxDepth
				? Promise.resolve([] as string[])
				: subdirectories(current.dir))),
		]);
		for (const node of repoNodes) nodes.push(node);
		const next: Array<{ dir: string; depth: number }> = [];
		children.forEach((dirs, index) => {
			for (const child of dirs) next.push({ dir: child, depth: pending[index].depth + 1 });
		});
		level = next;
	}
	await finishDiscovery(root, nodes, visited, submoduleIds);
	return { nodes, truncated };
}

/**
 * 按已知路径取仓库节点，不扫描目录。
 *
 * 每个路径核一次 `.git` 是否存在：仍是仓库就构造节点（含工作树与子模块），否则跳过。
 * 已不是仓库的路径被忽略；整个列表都失效时退回完整扫描，避免仓库树空掉。
 *
 * @param root - 工作区根目录。
 * @param known - 已知的顶层仓库路径。
 * @param shallow - 只产出顶层节点时为 true。
 * @returns 仓库扁平列表与是否被截断（快路径不截断）。
 */
async function discoverKnownRepositories(
	root: string,
	known: readonly string[],
	shallow: boolean,
): Promise<DiscoveryResult> {
	const nodes: RepoNode[] = [];
	const submoduleIds = new Set<string>();
	const visited = new Set<string>();
	// 顺序去重：保留首次出现的路径，已在 visited 或子模块集合中的路径跳过。
	const candidates = dedupeCandidates(known, visited, submoduleIds);
	// `.git` 探测并发；仍是仓库的路径按原顺序并发构造节点。
	const entries = await Promise.all(candidates.map((dir) => gitEntryOf(dir)));
	const repoDirs = candidates.filter((dir, index) => entries[index] === 'dir');
	const built = await Promise.all(repoDirs.map((dir) => repoNodeOf(dir, 0, submoduleIds, shallow)));
	for (const node of built) nodes.push(node);
	if (nodes.length === 0) {
		return discoverRepositories(root, {
			maxDepth: DEFAULT_MAX_DEPTH, maxDirectories: DEFAULT_MAX_DIRECTORIES, shallow,
		});
	}
	await finishDiscovery(root, nodes, visited, submoduleIds);
	return { nodes, truncated: false };
}

/**
 * 向上逐级查找工作区根所属的仓库目录。
 *
 * 判定只走文件系统：从 `root` 起逐级取父目录，第一个含 `.git`（目录或文件）的目录即为
 * 所属仓库；到盘符或文件系统根仍未找到时为 null。
 *
 * @param root - 工作区根目录。
 * @returns 仓库目录绝对路径；不在任何仓库内时为 null。
 */
export async function findEnclosingRepoDir(root: string): Promise<string | null> {
	let current = resolve(root);
	for (;;) {
		if (await hasGitEntry(current)) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * 工作区根位于某个仓库内部时补齐该仓库。
 *
 * @param root - 工作区根目录。
 * @param visited - 已访问目录标识。
 * @param submoduleIds - 收集子模块路径标识。
 * @returns 仓库节点；工作区根不在仓库内或已发现时为 null。
 */
async function enclosingRepo(root: string, visited: Set<string>, submoduleIds: Set<string>): Promise<RepoNode | null> {
	const top = await findEnclosingRepoDir(root);
	if (top === null || visited.has(nodeId(top))) return null;
	visited.add(nodeId(top));
	return await repoNodeOf(top, 0, submoduleIds);
}

/**
 * 取被「别的工作树」检出的分支。
 *
 * 一个分支同时只能被一个工作树检出。查看某个工作树时，别的工作树占用的分支既不是它的
 * 当前分支，也不可删除（git 报 `cannot delete branch ... used by worktree at ...`），
 * 因此要从分支标签与删除候选中排除；而**当前工作树自己的分支**保留，仍作为当前分支显示。
 *
 * 比较用规范化路径，因此查看主工作树或任一链接工作树都得到正确结果。
 *
 * @param repo - 当前查看的仓库或工作树路径。
 * @returns 被别的工作树占用的分支名集合；枚举失败时为空集。
 */
export async function branchesOfOtherWorktrees(repo: string): Promise<Set<string>> {
	try {
		// 无链接工作树记录时无需枚举：普通仓库不为此读工作树登记。
		if (await linkedWorktreePresence(repo) === 'none') return new Set();
		const commonDir = await resolveGitCommonDir(repo);
		if (commonDir === null) return new Set();
		return foreignWorktreeBranches(await readWorktrees(commonDir), repo, nodeId);
	} catch (error) {
		// 枚举失败时不排除任何分支：宁可让用户点到会被 git 拒绝的项，也不要漏掉可用分支。
		logDebug('repo', `枚举别的工作树占用分支失败，本次不排除任何分支：${error instanceof Error ? error.message : String(error)}`);
		return new Set();
	}
}

/**
 * 按已持久化的工作区根预热仓库发现缓存。
 *
 * 只走「按已知仓库位置取树」的快路径，不逐层扫描；逐项失败静默，不抛错。预扫成功的工作区
 * 同时纳入结构监视：面板首次请求之前创建的仓库与工作树也能被发现。
 *
 * @returns 无。
 */
export async function primeCachedWorkspaces(): Promise<void> {
	for (const root of listRepoLocationWorkspaces()) {
		try {
			const known = readRepoLocations(root).map((repo) => repo.path);
			if (known.length === 0) continue;
			const result = await discoverRepositories(root, { knownRepos: known, shallow: true });
			watchRepositories(result.nodes.filter((node) => node.kind === 'repo').map((node) => node.path));
			watchWorkspace(root);
		} catch (error) {
			logDebug('repo', `预扫工作区失败，不影响后续请求：${root}：${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
