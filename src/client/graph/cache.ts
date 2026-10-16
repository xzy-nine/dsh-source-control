/**
 * 提交图窗口缓存：按「仓库 + 取数参数」索引最近使用的一段提交。
 *
 * 纯数据结构，无 React、无外部依赖，可直接单测。用于翻页回看与自动刷新时
 * 避免重复向宿主取同一段提交。
 */

/** 影响取数结果的一组参数；字段与宿主提交图命令的入参一一对应。 */
export interface CommitGraphCacheKey {
	readonly maxCommits: number;
	readonly skip: number;
	readonly ordering: string;
	readonly showStashes: boolean;
	readonly showTags: boolean;
	readonly showRemoteBranches: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
}

/** 窗口缓存：键为仓库路径与取数参数的拼接结果，值为调用方缓存的任意数据。 */
export interface CommitGraphCache<T> {
	/** 由仓库路径与取数参数算出缓存键。 */
	keyOf(repoPath: string, options: CommitGraphCacheKey): string;
	/** 读取键对应的值；命中算一次使用。 */
	get(key: string): T | undefined;
	/** 写入值；同键覆盖，超容量时淘汰最久未用的一项。 */
	set(key: string, value: T): void;
	/** 删除指定仓库的全部键。 */
	dropRepo(repoPath: string): void;
	/** 清空全部键。 */
	clear(): void;
	/** 当前缓存项数。 */
	readonly size: number;
}

/** 默认容量。 */
const DEFAULT_CAPACITY = 32;

/** 键内分隔符：不可能出现在仓库路径与参数里的控制字符。 */
const SEP = '\u0000';

/**
 * 仓库路径归一化：去尾部斜杠与反斜杠、统一转小写。
 *
 * 与宿主 src/source-control/working-tree.ts 的 normalizeRepo 同语义，
 * 因此同一仓库的不同写法（尾斜杠、盘符大小写）得到同一键。
 */
function normalizeRepo(repoPath: string): string {
	return repoPath.replace(/[\\/]+$/, '').toLowerCase();
}

/** 布尔参数编码为 1 / 0，避免与数字参数拼串后产生歧义。 */
function flag(value: boolean): string {
	return value ? '1' : '0';
}

/**
 * 建立窗口缓存。
 *
 * @param capacity - 容量上限，默认 32，最小 1。
 * @returns 缓存实例。
 */
export function createCommitGraphCache<T>(capacity?: number): CommitGraphCache<T> {
	const limit = Math.max(1, Math.floor(Number.isFinite(capacity) ? (capacity as number) : DEFAULT_CAPACITY));
	const store = new Map<string, T>();

	return {
		keyOf(repoPath, options) {
			return [
				normalizeRepo(repoPath),
				String(options.maxCommits),
				String(options.skip),
				options.ordering,
				flag(options.showStashes),
				flag(options.showTags),
				flag(options.showRemoteBranches),
				flag(options.onlyFollowFirstParent),
				flag(options.includeCommitsMentionedByReflogs),
			].join(SEP);
		},

		get(key) {
			if (!store.has(key)) return undefined;
			const value = store.get(key) as T;
			// 命中即最近使用：移到队尾。
			store.delete(key);
			store.set(key, value);
			return value;
		},

		set(key, value) {
			store.delete(key);
			store.set(key, value);
			while (store.size > limit) {
				const oldest = store.keys().next();
				if (oldest.done) break;
				store.delete(oldest.value);
			}
		},

		dropRepo(repoPath) {
			const prefix = normalizeRepo(repoPath) + SEP;
			for (const key of [...store.keys()]) {
				if (key.startsWith(prefix)) store.delete(key);
			}
		},

		clear() {
			store.clear();
		},

		get size() {
			return store.size;
		},
	};
}
