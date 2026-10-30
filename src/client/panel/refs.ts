/**
 * 引用与提交图的纯计算：引用筛选状态、取数起点、引用排序、领先/落后集合。
 *
 * 筛选与 VS Code 图形视图的模型一致：三种状态是「全部」「自动」与手选引用；自动模式取
 * 当前分支、它的上游与分叉来源分支；手选引用按完整引用名（`refs/heads/x`）持久化。
 * 筛选在宿主侧取数时生效（引用名交给 `git log` 作为起点），这里只做纯计算。
 */
import type { Commit, RefItem } from '../shared/types.ts';
import { normalizePath } from '../shared/path-key.ts';

/** 引用筛选的三种模式：全部、自动、手选。 */
export type RefFilterMode = 'all' | 'auto' | 'manual';

/** 一个仓库的引用筛选状态。 */
export interface RefFilter {
	readonly mode: RefFilterMode;
	/** 手选模式下的引用 id（`refs/heads/x` 等）；其余模式为空数组。 */
	readonly ids: readonly string[];
}

/** 持久化的引用筛选表：仓库键到「全部」或手选 id 列表的映射；自动模式不落盘。 */
export type StoredRefFilters = Record<string, 'all' | string[]>;

/** 宿主状态里引用筛选的键。 */
export const REF_FILTER_KEY = 'dsh-source-control-ref-filter';

/** 默认筛选：自动。 */
export const DEFAULT_REF_FILTER: RefFilter = { mode: 'auto', ids: [] };

/** 自动模式取数起点需要的上下文。 */
export interface AutoFilterContext {
	/** 当前分支短名；分离头指针时为 null。 */
	readonly head: string | null;
	/** 当前 HEAD 的提交哈希；分离头指针时用作取数起点。 */
	readonly headHash?: string | null;
	/** 上游远程跟踪分支短名。 */
	readonly upstream: string | null;
	/** 分叉来源引用短名（VS Code 图形视图的 base 引用）。 */
	readonly base: string | null;
}

/**
 * 取仓库在持久化表里的键。
 *
 * @param repoPath - 仓库路径。
 * @returns 归一化后的键。
 */
export function filterKeyOf(repoPath: string): string {
	return normalizePath(repoPath);
}

/**
 * 把任意值收敛成引用 id 列表。
 *
 * @param value - 待收敛的值。
 * @returns 非空字符串组成的数组。
 */
function idsOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((id): id is string => typeof id === 'string' && id !== '');
}

/**
 * 从一个仓库的持久化项读出筛选状态。
 *
 * @param registry - 宿主状态里的筛选表（任意值）。
 * @param repoPath - 仓库路径。
 * @returns 筛选状态；缺省、手选列表为空或值不合法时为自动。
 */
export function readStoredFilter(registry: unknown, repoPath: string): RefFilter {
	if (registry === null || typeof registry !== 'object') return DEFAULT_REF_FILTER;
	const value = (registry as Record<string, unknown>)[filterKeyOf(repoPath)];
	if (value === 'all') return { mode: 'all', ids: [] };
	const ids = idsOf(value);
	return ids.length === 0 ? DEFAULT_REF_FILTER : { mode: 'manual', ids };
}

/**
 * 把一个仓库的筛选状态写回持久化表。
 *
 * 自动模式删除该仓库的项；「全部」记一个字面量；手选记引用 id 列表。表内其余仓库原样保留。
 *
 * @param registry - 宿主状态里的筛选表（任意值）。
 * @param repoPath - 仓库路径。
 * @param filter - 新的筛选状态。
 * @returns 新的筛选表；调用方负责落盘。
 */
export function writeStoredFilter(registry: unknown, repoPath: string, filter: RefFilter): StoredRefFilters {
	const next: StoredRefFilters = {};
	if (registry !== null && typeof registry === 'object') {
		for (const [key, value] of Object.entries(registry)) {
			if (value === 'all') { next[key] = 'all'; continue; }
			const ids = idsOf(value);
			if (ids.length > 0) next[key] = ids;
		}
	}
	const key = filterKeyOf(repoPath);
	if (filter.mode === 'all') next[key] = 'all';
	else if (filter.mode === 'manual' && filter.ids.length > 0) next[key] = [...filter.ids];
	else Reflect.deleteProperty(next, key);
	return next;
}

/**
 * 旧版筛选状态：模式与按名字保存的勾选集合。
 *
 * 旧版本按仓库分别存成独立键，勾选记的是引用短名；升级后统一为按仓库键的持久化表，
 * 这里把它折算成新形状。名字的种类无法区分，按「含 `/` 即远程分支，否则本地分支」推断，
 * 推断不到的引用随后由手选校验丢弃或回退。
 *
 * @param value - 旧版持久化值（任意值）。
 * @returns 折合后的筛选状态；值不可识别时为 null。
 */
export function legacyFilterOf(value: unknown): RefFilter | null {
	if (value === null || typeof value !== 'object') return null;
	const mode = (value as { mode?: unknown }).mode;
	if (mode === 'all') return { mode: 'all', ids: [] };
	if (mode === 'auto') return DEFAULT_REF_FILTER;
	if (mode !== 'manual') return null;
	const names = idsOf((value as { selected?: unknown }).selected);
	if (names.length === 0) return DEFAULT_REF_FILTER;
	return { mode: 'manual', ids: names.map((name) => refIdOf(name, name.includes('/') ? 'remote' : 'branch')) };
}
/**
 * 取一个引用在持久化与请求里使用的完整名。
 *
 * @param name - 引用短名。
 * @param type - 引用种类。
 * @returns 完整引用名，如 `refs/heads/main`、`refs/remotes/origin/main`。
 */
export function refIdOf(name: string, type: RefItem['type']): string {
	if (name.startsWith('refs/')) return name;
	if (type === 'tag') return `refs/tags/${name}`;
	if (type === 'remote') return `refs/remotes/${name}`;
	return `refs/heads/${name}`;
}

/**
 * 由引用 id 取可交给 `git log` 的引用名。
 *
 * @param id - 完整引用名。
 * @returns 引用短名；非完整引用名时原样返回。
 */
export function refNameOf(id: string): string {
	for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
		if (id.startsWith(prefix)) return id.slice(prefix.length);
	}
	return id;
}

/**
 * 取自动模式对应的引用名。
 *
 * 与 VS Code 的 auto 一致：当前分支（分离头指针时用提交哈希）、上游与分叉来源分支，按此
 * 顺序去重；空项丢弃。
 *
 * @param context - 见 {@link AutoFilterContext}。
 * @returns 引用名列表。
 */
export function autoRefNames(context: AutoFilterContext): string[] {
	const names: string[] = [];
	for (const name of [context.head ?? context.headHash ?? null, context.upstream, context.base]) {
		if (name !== null && name !== '' && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * 取一次取数的引用起点。
 *
 * @param filter - 当前筛选状态。
 * @param context - 自动模式需要的上下文。
 * @returns 引用名列表；null 表示全部引用（宿主按 `--branches` 等枚举）。
 */
export function filterBranchesOf(filter: RefFilter, context: AutoFilterContext): string[] | null {
	if (filter.mode === 'all') return null;
	if (filter.mode === 'auto') {
		const names = autoRefNames(context);
		return names.length === 0 ? null : names;
	}
	const names = filter.ids.map(refNameOf).filter((name) => name !== '');
	return names.length === 0 ? null : names;
}

/**
 * 取筛选按钮上的摘要文案。
 *
 * @param filter - 当前筛选状态。
 * @returns 「全部」「自动」、单个引用名或数量摘要。
 */
export function filterSummaryOf(filter: RefFilter): string {
	if (filter.mode === 'all') return '全部';
	if (filter.mode === 'auto' || filter.ids.length === 0) return '自动';
	if (filter.ids.length === 1) return refNameOf(filter.ids[0]);
	return `${filter.ids.length} 个`;
}

/**
 * 按当前引用重新校验手选列表。
 *
 * 与 VS Code 的手选恢复一致：丢掉已不存在的引用；全部失效时回退自动（并可由调用方清除持久化项）。
 *
 * @param filter - 当前筛选状态。
 * @param refs - 仓库当前的全部引用。
 * @returns 校验后的状态；无需改动时返回原对象。
 */
export function revalidatedFilter(filter: RefFilter, refs: readonly RefItem[]): RefFilter {
	if (filter.mode !== 'manual') return filter;
	const known = new Set(refs.map((ref) => ref.id));
	const ids = filter.ids.filter((id) => known.has(id));
	if (ids.length === 0) return DEFAULT_REF_FILTER;
	if (ids.length === filter.ids.length) return filter;
	return { mode: 'manual', ids };
}

/**
 * 取筛选弹窗里应勾选的引用 id。
 *
 * @param filter - 当前筛选状态。
 * @param refs - 仓库当前的全部引用。
 * @param context - 自动模式需要的上下文。
 * @returns 勾选集合。
 */
export function checkedRefIds(filter: RefFilter, refs: readonly RefItem[], context: AutoFilterContext): Set<string> {
	if (filter.mode === 'manual') return new Set(filter.ids);
	if (filter.mode === 'all') return new Set(refs.map((ref) => ref.id));
	const names = new Set(autoRefNames(context));
	return new Set(refs.filter((ref) => names.has(ref.name)).map((ref) => ref.id));
}

/**
 * 按哈希索引提交，跳过工作区伪提交。
 *
 * @param commits - 提交列表。
 * @returns 哈希到提交的映射。
 */
function indexByHash(commits: readonly Commit[]): Map<string, Commit> {
	const commitByHash = new Map<string, Commit>();
	for (const commit of commits) {
		if (commit.hash !== '*') commitByHash.set(commit.hash, commit);
	}
	return commitByHash;
}

/**
 * 从一批起点沿父提交求可达集。
 *
 * @param starts - 起点哈希。
 * @param commitByHash - 哈希到提交的映射。
 * @returns 可达提交哈希集合（含起点自身）。
 */
function reachableFrom(starts: Iterable<string>, commitByHash: ReadonlyMap<string, Commit>): Set<string> {
	const reachable = new Set<string>();
	const queue = [...starts];
	while (queue.length > 0) {
		const hash = queue.shift() as string;
		if (reachable.has(hash)) continue;
		reachable.add(hash);
		const commit = commitByHash.get(hash);
		if (commit !== undefined) for (const p of commit.parents ?? []) queue.push(p);
	}
	return reachable;
}

/**
 * 取当前分支可达的提交哈希集合（含分支尖端自身）。
 *
 * 提交图可能被加载上限截断，此时窗口外的提交不在集合内。
 *
 * @param commits - 提交列表。
 * @param head - 当前分支名。
 * @returns 可达提交哈希集合；无法确定当前分支时为空集。
 */
export function currentBranchHashes(commits: readonly Commit[], head: string | null): Set<string> {
	if (head === null) return new Set();
	const commitByHash = indexByHash(commits);
	let headHash: string | null = null;
	for (const commit of commits) {
		if ((commit.heads ?? []).includes(head)) { headHash = commit.hash; break; }
	}
	if (headHash === null) return new Set();
	return reachableFrom([headHash], commitByHash);
}

/**
 * 按引用优先级排序：HEAD(1) < 上游(2) < 分叉来源(3) < 有色(4) < 其他(99)。
 *
 * 多引用提交据此取排序最前的引用色。
 *
 * @param refs - 引用列表。
 * @param head - 当前分支名。
 * @param upstream - 上游远程跟踪分支名。
 * @param base - 分叉来源引用名；无来源时为 null。
 * @returns 排序后的新数组。
 */
export function sortRefs(
	refs: readonly RefItem[], head: string | null, upstream: string | null, base: string | null = null,
): RefItem[] {
	const rank = (ref: RefItem): number => {
		if (head !== null && ref.name === head) return 1;
		if (upstream !== null && ref.name === upstream) return 2;
		if (base !== null && ref.name === base) return 3;
		return ref.type === 'branch' || ref.type === 'remote' ? 4 : 99;
	};
	return [...refs].sort((a, b) => rank(a) - rank(b));
}

/**
 * 计算本地与上游的分叉信息。
 *
 * 领先：本地 HEAD 可达而上游不可达；落后：上游可达而本地 HEAD 不可达。
 * 两侧尖端各自对应一个指示节点：本地落后时上游尖端标云端领先，本地领先时 HEAD 标本地领先。
 *
 * @param commits - 提交列表。
 * @param head - 本地分支名。
 * @param upstream - 远程跟踪分支名（如 origin/main）。
 * @returns 领先与落后集合，以及两侧尖端哈希；无上游时为 null。
 */
export function computeSyncMarkers(
	commits: readonly Commit[], head: string | null, upstream: string | null,
): { ahead: Set<string>; behind: Set<string>; baseHash: string | null; localTip: string | null; remoteTip: string | null } {
	const none = { ahead: new Set<string>(), behind: new Set<string>(), baseHash: null, localTip: null, remoteTip: null };
	if (head === null || upstream === null) return none;
	const commitByHash = new Map<string, Commit>();
	for (const commit of commits) {
		if (commit.hash !== '*') commitByHash.set(commit.hash, commit);
	}
	// 找本地 HEAD 和远程跟踪分支的提交哈希
	let localHash: string | null = null;
	let remoteHash: string | null = null;
	for (const commit of commits) {
		if (commit.hash === '*') continue;
		if (localHash === null && (commit.heads ?? []).includes(head)) localHash = commit.hash;
		for (const remote of commit.remotes ?? []) {
			if (remote.name === upstream) remoteHash = commit.hash;
		}
	}
	if (localHash === null || remoteHash === null) return none;
	// 收集各自祖先
	const ancestorsOf = (rootHash: string): Set<string> => {
		const seen = new Set<string>();
		const queue = [rootHash];
		while (queue.length > 0) {
			const hash = queue.shift() as string;
			if (seen.has(hash)) continue;
			seen.add(hash);
			const commit = commitByHash.get(hash);
			if (commit !== undefined) for (const p of commit.parents ?? []) queue.push(p);
		}
		return seen;
	};
	const localAncestors = ancestorsOf(localHash);
	const remoteAncestors = ancestorsOf(remoteHash);
	const ahead = new Set<string>();
	const behind = new Set<string>();
	for (const hash of localAncestors) if (!remoteAncestors.has(hash)) ahead.add(hash);
	for (const hash of remoteAncestors) if (!localAncestors.has(hash)) behind.add(hash);
	// 合并基是两侧共同祖先里最新的那个：列表按新到旧排列，首个落在交集内的即为它。
	let baseHash: string | null = null;
	for (const commit of commits) {
		if (commit.hash === '*') continue;
		if (localAncestors.has(commit.hash) && remoteAncestors.has(commit.hash)) { baseHash = commit.hash; break; }
	}
	// 指示节点只在实际领先/落后时出现：本地领先标 HEAD，云端领先标上游尖端。
	return {
		ahead,
		behind,
		baseHash,
		localTip: ahead.size > 0 ? localHash : null,
		remoteTip: behind.size > 0 ? remoteHash : null,
	};
}