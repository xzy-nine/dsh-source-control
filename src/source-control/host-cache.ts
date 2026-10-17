/**
 * 宿主侧数据缓存：提交图窗口、仓库信息与工作区快照。
 *
 * 缓存留在宿主进程内存里，不落盘：数据随仓库写入变化，跨进程重启后按需重取即可。
 * 任何**成功**的仓库写操作都会作废该仓库的全部缓存（`onRepositoryWrite`），因此读到的
 * 内容不会比最近一次写操作更旧。
 *
 * 分三类，各自的有效期与容量按读取成本与变化频率定：
 * - 提交图窗口：一次完整 `git log`，按「仓库 + 取数参数」区分；翻页与切回同一仓库都命中。
 * - 仓库信息：分支、远程、贮藏，变化频率低。
 * - 工作区快照：一次 `git status`，是三者中最慢的一条，有效期最短。
 */
import { onRepositoryWrite, type WorkingTreeSnapshot } from './working-tree.js';
import type { CommitNode, RepoInfo } from './git-types.js';

/** 缓存值：提交图窗口。 */
export interface CachedGraph {
	/** 提交列表（已按请求排序）。 */
	readonly commits: readonly CommitNode[];
	/** HEAD 指向的提交哈希。 */
	readonly head: string | null;
	/** 出现过的标签名。 */
	readonly tags: readonly string[];
	/** 是否还有更多提交。 */
	readonly moreCommitsAvailable: boolean;
	/** 本窗口的别的工作树占用分支。 */
	readonly foreignBranches: readonly string[];
}

/** 缓存值：工作区快照（含错误字段）。 */
export interface CachedSnapshot extends WorkingTreeSnapshot {
	readonly error: string | null;
}

/** 一条带过期时刻的缓存项。 */
interface Entry<T> {
	readonly value: T;
	readonly expiresAt: number;
}

/** 提交图窗口的存活毫秒数。 */
const GRAPH_TTL_MS = 30_000;

/** 仓库信息的存活毫秒数。 */
const REPO_INFO_TTL_MS = 10_000;

/** 工作区快照的存活毫秒数；写操作会主动作废，因此这里只防连读。 */
const SNAPSHOT_TTL_MS = 2_000;

/** 各类缓存的容量上限；超出按插入序淘汰最旧。 */
const GRAPH_LIMIT = 64;
const REPO_INFO_LIMIT = 32;
const SNAPSHOT_LIMIT = 32;

/** 提交图窗口缓存：键含仓库与全部取数参数。 */
const graphs = new Map<string, Entry<CachedGraph>>();
/** 仓库信息缓存：键为仓库。 */
const repoInfos = new Map<string, Entry<RepoInfo>>();
/** 工作区快照缓存：键为仓库。 */
const snapshots = new Map<string, Entry<CachedSnapshot>>();

/**
 * 归一化仓库路径，作为缓存键。
 *
 * @param repo - 仓库路径。
 * @returns 去掉尾分隔符并小写后的路径。
 */
function keyOf(repo: string): string {
	return repo.replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 写入一条缓存项并按容量淘汰最旧。
 *
 * @param store - 目标缓存。
 * @param limit - 容量上限。
 * @param key - 缓存键。
 * @param value - 值。
 * @param ttlMs - 存活毫秒数。
 * @returns 无。
 */
function put<T>(store: Map<string, Entry<T>>, limit: number, key: string, value: T, ttlMs: number): void {
	store.delete(key);
	store.set(key, { value, expiresAt: Date.now() + ttlMs });
	while (store.size > limit) {
		const oldest = store.keys().next();
		if (oldest.done === true) break;
		store.delete(oldest.value);
	}
}

/**
 * 读一条未过期的缓存项。
 *
 * @param store - 目标缓存。
 * @param key - 缓存键。
 * @returns 值；未命中或已过期时为 undefined。
 */
function get<T>(store: Map<string, Entry<T>>, key: string): T | undefined {
	const entry = store.get(key);
	if (entry === undefined) return undefined;
	if (Date.now() >= entry.expiresAt) {
		store.delete(key);
		return undefined;
	}
	return entry.value;
}

/**
 * 生成提交图窗口的缓存键。
 *
 * @param repo - 仓库路径。
 * @param params - 影响提交集的全部取数参数。
 * @returns 缓存键。
 */
export function graphKey(repo: string, params: {
	readonly maxCommits: number;
	readonly skip: number;
	readonly ordering: string;
	readonly showTags: boolean;
	readonly showRemoteBranches: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly hideRemotes: readonly string[];
	readonly branches: readonly string[] | null;
}): string {
	return [
		keyOf(repo), params.maxCommits, params.skip, params.ordering,
		params.showTags ? 1 : 0, params.showRemoteBranches ? 1 : 0,
		params.onlyFollowFirstParent ? 1 : 0, params.includeCommitsMentionedByReflogs ? 1 : 0,
		params.hideRemotes.join(','), params.branches === null ? '*' : params.branches.join(','),
	].join('\0');
}

/**
 * 读一个提交图窗口。
 *
 * @param repo - 仓库路径。
 * @param params - 与 {@link graphKey} 相同的参数。
 * @returns 缓存的窗口；未命中时为 undefined。
 */
export function readGraph(repo: string, params: Parameters<typeof graphKey>[1]): CachedGraph | undefined {
	return get(graphs, graphKey(repo, params));
}

/**
 * 写入一个提交图窗口。
 *
 * @param repo - 仓库路径。
 * @param params - 与 {@link graphKey} 相同的参数。
 * @param value - 窗口内容。
 * @returns 无。
 */
export function writeGraph(repo: string, params: Parameters<typeof graphKey>[1], value: CachedGraph): void {
	put(graphs, GRAPH_LIMIT, graphKey(repo, params), value, GRAPH_TTL_MS);
}

/**
 * 读仓库信息。
 *
 * @param repo - 仓库路径。
 * @returns 仓库信息；未命中时为 undefined。
 */
export function readRepoInfo(repo: string): RepoInfo | undefined {
	return get(repoInfos, keyOf(repo));
}

/**
 * 写入仓库信息。
 *
 * @param repo - 仓库路径。
 * @param value - 仓库信息。
 * @returns 无。
 */
export function writeRepoInfo(repo: string, value: RepoInfo): void {
	put(repoInfos, REPO_INFO_LIMIT, keyOf(repo), value, REPO_INFO_TTL_MS);
}

/**
 * 读工作区快照。
 *
 * @param repo - 仓库路径。
 * @returns 快照；未命中时为 undefined。
 */
export function readSnapshot(repo: string): CachedSnapshot | undefined {
	return get(snapshots, keyOf(repo));
}

/**
 * 写入工作区快照。
 *
 * @param repo - 仓库路径。
 * @param value - 快照。
 * @returns 无。
 */
export function writeSnapshot(repo: string, value: CachedSnapshot): void {
	put(snapshots, SNAPSHOT_LIMIT, keyOf(repo), value, SNAPSHOT_TTL_MS);
}

/**
 * 作废一个仓库的全部缓存。
 *
 * 按前缀匹配键，因此该仓库的所有提交图窗口（不同参数）一并失效。
 *
 * @param repo - 仓库路径。
 * @returns 无。
 */
export function invalidateRepo(repo: string): void {
	const key = keyOf(repo);
	repoInfos.delete(key);
	snapshots.delete(key);
	const prefix = key + '\0';
	for (const graphKeyName of graphs.keys()) {
		if (graphKeyName.startsWith(prefix)) graphs.delete(graphKeyName);
	}
}

/**
 * 清空全部缓存。
 *
 * @returns 无。
 */
export function clearHostCache(): void {
	graphs.clear();
	repoInfos.clear();
	snapshots.clear();
}

/* 成功的仓库写操作会改变引用、提交历史、工作区与仓库配置，缓存一律作废。 */
onRepositoryWrite((repo) => { invalidateRepo(repo); });
