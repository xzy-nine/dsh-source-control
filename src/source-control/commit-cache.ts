/**
 * 提交数据缓存：宿主持有完整提交集，客户端按窗口分页取。
 *
 * 一次 `git log` 取到全部（受单仓库上限约束）后驻留宿主内存，客户端只请求自己要看的那一段。
 * 这样客户端不持有大数据，翻页也不再触发 git 查询。仓库状态一变（写操作、外部改动）就整体失效，
 * 下次请求重新读取。
 *
 * 键含仓库路径与影响查询结果的选项：排序、是否含标签/远程/贮藏等；任一不同即为另一份缓存。
 */
import type { CommitNode } from './git-types.js';

/** 一份缓存的提交集。 */
interface CommitCacheEntry {
	/** 完整提交列表，按请求的排序。 */
	readonly commits: CommitNode[];
	/** HEAD 指向的提交哈希。 */
	readonly head: string | null;
	/** 出现过的标签名（去重）。 */
	readonly tags: string[];
	/** 仓库里是否还有更多提交未取（取满上限时为 true）。 */
	readonly moreCommitsAvailable: boolean;
	/** 写入时刻，用于淘汰。 */
	readonly at: number;
}

/** 单仓库最多驻留的提交数；超出时只保留前 N 条并置 moreCommitsAvailable。 */
const MAX_CACHED_COMMITS = 20000;

/** 最多驻留的仓库份数；超出时淘汰最旧的。 */
const MAX_CACHED_REPOS = 8;

/** 缓存：键为仓库与选项组合。 */
const cache = new Map<string, CommitCacheEntry>();

/**
 * 构造缓存键。
 *
 * @param repo - 仓库路径。
 * @param options - 影响查询结果的选项。
 * @returns 缓存键。
 */
export function commitCacheKey(repo: string, options: Record<string, unknown>): string {
	const parts = Object.keys(options).sort().map((key) => `${key}=${JSON.stringify(options[key])}`);
	return `${repo.replace(/[\\/]+$/, '').toLowerCase()}\u0000${parts.join('&')}`;
}

/**
 * 读取一份缓存的提交集。
 *
 * @param key - 缓存键。
 * @returns 缓存内容；不存在时为 null。
 */
export function readCommitCache(key: string): CommitCacheEntry | null {
	return cache.get(key) ?? null;
}

/**
 * 写入一份提交集。
 *
 * @param key - 缓存键。
 * @param entry - 提交集（不含写入时刻）。
 * @returns 无。
 */
export function writeCommitCache(key: string, entry: Omit<CommitCacheEntry, 'at'>): void {
	const commits = entry.commits.slice(0, MAX_CACHED_COMMITS);
	cache.set(key, {
		...entry,
		commits,
		moreCommitsAvailable: entry.moreCommitsAvailable || commits.length < entry.commits.length,
		at: Date.now(),
	});
	while (cache.size > MAX_CACHED_REPOS) {
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key2, value] of cache) {
			if (value.at < oldestAt) { oldestAt = value.at; oldestKey = key2; }
		}
		if (oldestKey === null) break;
		cache.delete(oldestKey);
	}
}

/**
 * 取一段提交窗口。
 *
 * @param entry - 缓存的提交集。
 * @param offset - 起始下标。
 * @param limit - 最多返回条数。
 * @returns 该窗口内的提交。
 */
export function sliceCommits(entry: CommitCacheEntry, offset: number, limit: number): CommitNode[] {
	const from = Math.max(0, Math.floor(offset));
	return entry.commits.slice(from, from + Math.max(1, Math.floor(limit)));
}

/**
 * 失效某个仓库的全部缓存。
 *
 * @param repo - 仓库路径；省略时清空全部。
 * @returns 无。
 */
export function invalidateCommitCache(repo?: string): void {
	if (repo === undefined) { cache.clear(); return; }
	const prefix = repo.replace(/[\\/]+$/, '').toLowerCase() + '\u0000';
	for (const key of cache.keys()) {
		if (key.startsWith(prefix)) cache.delete(key);
	}
}

/**
 * 当前缓存的仓库份数；供诊断与测试。
 *
 * @returns 份数。
 */
export function commitCacheSize(): number {
	return cache.size;
}
