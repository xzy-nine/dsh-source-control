/**
 * 宿主侧数据缓存：提交图窗口、仓库信息与工作区快照。
 *
 * 缓存留在宿主进程内存里，不落盘：数据随仓库写入变化，跨进程重启后按需重取即可。
 * 任何写命令结束后都会清空全部缓存（`onRepositoryWrite`）：同一仓库的主工作树与
 * 链接工作树是不同的路径，按执行目录作废只会漏掉另一半。因此读到的内容不会比最近一次
 * 写操作更旧，代价是写操作后各仓库都要重取一次。非零退出的写命令同样清空 —— 冲突合并、
 * 拣选冲突与变基停下都以非零退出，但仓库已被改动。
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
	/** 当前分支名；分离头指针时为 null。 */
	readonly branch: string | null;
	/** 出现过的标签名。 */
	readonly tags: readonly string[];
	/** 是否还有更多提交。 */
	readonly moreCommitsAvailable: boolean;
	/** 下一窗口的偏移量；按 `git log` 记录数计。 */
	readonly nextSkip: number;
	/** 本窗口的别的工作树占用分支。 */
	readonly foreignBranches: readonly string[];
}

/** 缓存值：工作区快照（含错误字段）。 */
export interface CachedSnapshot extends WorkingTreeSnapshot {
	readonly error: string | null;
}

/** 一条带过期时刻的缓存项。 */
export interface CacheEntry<T> {
	readonly value: T;
	readonly expiresAt: number;
}

/** 提交图窗口的存活毫秒数。 */
const GRAPH_TTL_MS = 30_000;

/**
 * 仓库信息的存活毫秒数。
 *
 * 分支、远程与贮藏的变化频率远低于十秒，而写操作会主动作废；有效期因此按分钟计，
 * 命中时不必重起一次 `for-each-ref` 与一次 `config --list`。
 */
const REPO_INFO_TTL_MS = 60_000;

/**
 * 工作区快照的存活毫秒数。
 *
 * 只用于合并同一轮刷新的并发读：`status` 的输出随工作区与索引变化，插件之外的写
 * （编辑器、外部命令）不产生写事件，有效期越长越容易读到旧值。
 */
const SNAPSHOT_TTL_MS = 500;

/** 各类缓存的容量上限；超出按最久未用淘汰。 */
const GRAPH_LIMIT = 64;
const REPO_INFO_LIMIT = 32;
const SNAPSHOT_LIMIT = 32;
const HOOKS_PATH_LIMIT = 32;

/**
 * 超出容量后回落到的比例。
 *
 * 一次淘汰一批而不是每写一条就删一条：批量摊平了淘汰成本，也避免容量边界上反复触发
 * 单条淘汰。
 */
const TRIM_RATIO = 0.75;

/**
 * `core.hooksPath` 的存活毫秒数。
 *
 * 该取值只在仓库配置变化时改变，而配置变化不产生写事件；有效期因此按分钟计。
 */
const HOOKS_PATH_TTL_MS = 60_000;

/** 提交图窗口缓存：键含仓库与全部取数参数。 */
const graphs = new Map<string, CacheEntry<CachedGraph>>();
/** 仓库信息缓存：键为仓库与取数参数。 */
const repoInfos = new Map<string, CacheEntry<RepoInfo>>();
/** 工作区快照缓存：键为仓库。 */
const snapshots = new Map<string, CacheEntry<CachedSnapshot>>();
/** 钩子路径缓存：键为仓库。 */
const hooksPaths = new Map<string, CacheEntry<string>>();

/**
 * 影响仓库信息的取数参数。
 *
 * 这三个参数都会改变 `getRepoInfo` 的结果：远程分支是否枚举、贮藏是否枚举、要隐藏的远程。
 * 它们必须进缓存键，否则先按一种参数取回的结果会被另一种参数命中原样回投。
 */
export interface RepoInfoParams {
	/** 是否枚举远程分支。 */
	readonly showRemoteBranches: boolean;
	/** 是否枚举贮藏。 */
	readonly showStashes: boolean;
	/** 要隐藏的远程名。 */
	readonly hideRemotes: readonly string[];
}


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
 * 把字符串列表编码进缓存键。
 *
 * 用 JSON 保留列表边界：远程名、分支名与标签名都允许含逗号，用逗号拼接会让「一个含逗号的
 * 名字」与「多个名字」得到同一个键。null 表示调用方未指定该项，与空列表区分。
 *
 * @param values - 列表；null 表示未指定。
 * @returns 编码文本。
 */
function listKey(values: readonly string[] | null): string {
	return values === null ? '*' : JSON.stringify(values);
}

/**
 * 生成仓库信息的缓存键。
 *
 * @param repo - 仓库路径。
 * @param params - 影响仓库信息的取数参数。
 * @returns 缓存键。
 */
function repoInfoKey(repo: string, params: RepoInfoParams): string {
	return [
		keyOf(repo),
		params.showRemoteBranches ? 1 : 0,
		params.showStashes ? 1 : 0,
		listKey(params.hideRemotes),
	].join('\0');
}

/**
 * 写入一条缓存项并按容量淘汰最旧。
 *
 * 仓库事实层（`repo-facts.ts`）复用本函数与其配对的 {@link getCached}，不另写淘汰逻辑。
 *
 * @param store - 目标缓存。
 * @param limit - 容量上限。
 * @param key - 缓存键。
 * @param value - 值。
 * @param ttlMs - 存活毫秒数；取 `Number.POSITIVE_INFINITY` 表示由其它守卫失效。
 * @returns 无。
 */
export function putCached<T>(store: Map<string, CacheEntry<T>>, limit: number, key: string, value: T, ttlMs: number): void {
	store.delete(key);
	store.set(key, { value, expiresAt: Date.now() + ttlMs });
	if (store.size <= limit) return;
	// 回落到 limit * ratio：一次淘汰一批，不在容量边界上逐条删。
	const target = Math.max(1, Math.floor(limit * TRIM_RATIO));
	while (store.size > target) {
		const oldest = store.keys().next();
		if (oldest.done === true) break;
		store.delete(oldest.value);
	}
}

/**
 * 读一条未过期的缓存项，命中即视为最近使用。
 *
 * `Map` 保持插入序，命中后删了重插即把该项移到队尾，淘汰因此落在最久未用的一项上。
 * 翻页回看时仍活跃的窗口不会因为「写入得早」被挤掉。
 *
 * @param store - 目标缓存。
 * @param key - 缓存键。
 * @returns 值；未命中或已过期时为 undefined。
 */
export function getCached<T>(store: Map<string, CacheEntry<T>>, key: string): T | undefined {
	const entry = store.get(key);
	if (entry === undefined) return undefined;
	if (Date.now() >= entry.expiresAt) {
		store.delete(key);
		return undefined;
	}
	store.delete(key);
	store.set(key, entry);
	return entry.value;
}

/**
 * 生成提交图窗口的缓存键。
 *
 * `head` 必须参与：提交集的起点含 `HEAD`，HEAD 移动后同一组参数会得到不同的一页。
 * 键里不含 HEAD 时，外部进程的提交（不经过本插件执行层、没有写事件）会让窗口继续命中旧数据，
 * 只能靠客户端察觉 HEAD 变化后主动请求作废来补救。
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
	readonly showStashes: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly hideRemotes: readonly string[];
	readonly branches: readonly string[] | null;
	readonly remotes: readonly string[];
	readonly stashes: readonly string[];
	/** 本次取数时的 HEAD；未知时为 null。 */
	readonly head: string | null;
}): string {
	return [
		keyOf(repo), params.head ?? '*', params.maxCommits, params.skip, params.ordering,
		params.showTags ? 1 : 0, params.showRemoteBranches ? 1 : 0, params.showStashes ? 1 : 0,
		params.onlyFollowFirstParent ? 1 : 0, params.includeCommitsMentionedByReflogs ? 1 : 0,
		listKey(params.hideRemotes), listKey(params.branches),
		listKey(params.remotes), listKey(params.stashes),
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
	return getCached(graphs, graphKey(repo, params));
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
	putCached(graphs, GRAPH_LIMIT, graphKey(repo, params), value, GRAPH_TTL_MS);
}

/**
 * 读仓库信息。
 *
 * @param repo - 仓库路径。
 * @param params - 影响仓库信息的取数参数。
 * @returns 仓库信息；未命中时为 undefined。
 */
export function readRepoInfo(repo: string, params: RepoInfoParams): RepoInfo | undefined {
	return getCached(repoInfos, repoInfoKey(repo, params));
}

/**
 * 写入仓库信息。
 *
 * @param repo - 仓库路径。
 * @param params - 影响仓库信息的取数参数。
 * @param value - 仓库信息。
 * @returns 无。
 */
export function writeRepoInfo(repo: string, params: RepoInfoParams, value: RepoInfo): void {
	putCached(repoInfos, REPO_INFO_LIMIT, repoInfoKey(repo, params), value, REPO_INFO_TTL_MS);
}

/**
 * 生成工作区快照的缓存键。
 *
 * @param repo - 仓库路径。
 * @param head - 读取该快照时的 HEAD。
 * @returns 缓存键。
 */
function snapshotKey(repo: string, head: string | null): string {
	return `${keyOf(repo)}\0${head ?? '*'}`;
}

/**
 * 读工作区快照。
 *
 * 键含快照读到的 HEAD：外部进程的提交不产生写事件，缓存无从主动作废，若只按仓库作键，
 * 那次提交之后的有效期内仍会回投提交前的条目。HEAD 由 `HEAD` 文件与分支引用解析，
 * 不起子进程。
 *
 * @param repo - 仓库路径。
 * @param head - 当前 HEAD；未知时传 null，此时按「与写入时一致」处理。
 * @returns 快照；未命中或 HEAD 已变时为 undefined。
 */
export function readSnapshot(repo: string, head: string | null = null): CachedSnapshot | undefined {
	return getCached(snapshots, snapshotKey(repo, head));
}

/**
 * 写入工作区快照。
 *
 * @param repo - 仓库路径。
 * @param value - 快照。
 * @returns 无。
 */
export function writeSnapshot(repo: string, value: CachedSnapshot): void {
	putCached(snapshots, SNAPSHOT_LIMIT, snapshotKey(repo, value.head), value, SNAPSHOT_TTL_MS);
}

/**
 * 读仓库的 `core.hooksPath`。
 *
 * @param repo - 仓库路径。
 * @returns 缓存的取值；未命中时为 undefined。
 */
export function readHooksPath(repo: string): string | undefined {
	return getCached(hooksPaths, keyOf(repo));
}

/**
 * 写入仓库的 `core.hooksPath`。
 *
 * @param repo - 仓库路径。
 * @param value - 取值；未配置时为空串。
 * @returns 无。
 */
export function writeHooksPath(repo: string, value: string): void {
	putCached(hooksPaths, HOOKS_PATH_LIMIT, keyOf(repo), value, HOOKS_PATH_TTL_MS);
}

/**
 * 判定一条缓存键所属的仓库是否受目标仓库影响。
 *
 * 三类关系都要覆盖：同一路径；目标仓库的祖先（子模块的写会改变父仓库 `status` 的结果，
 * 父仓库把子模块的内部改动记成自身的一条条目）；目标仓库的后代（查看父仓库时父仓库的改动
 * 同样改变其工作树内的子仓库视图）。
 *
 * @param cachedRepo - 缓存键里的仓库路径。
 * @param key - 目标仓库的规范化路径。
 * @returns 受影响时为 true。
 */
function affectedBy(cachedRepo: string, key: string): boolean {
	return cachedRepo === key
		|| key.startsWith(`${cachedRepo}/`)
		|| cachedRepo.startsWith(`${key}/`);
}

/**
 * 作废一个仓库及其相关路径的全部缓存。
 *
 * 按前缀匹配键，因此该仓库的所有提交图窗口与仓库信息（不同参数）一并失效。
 *
 * @param repo - 仓库路径。
 * @returns 无。
 */
export function invalidateRepo(repo: string): void {
	const key = keyOf(repo);
	for (const snapshotKeyName of snapshots.keys()) {
		const separator = snapshotKeyName.indexOf('\0');
		const cached = separator === -1 ? snapshotKeyName : snapshotKeyName.slice(0, separator);
		if (affectedBy(cached, key)) snapshots.delete(snapshotKeyName);
	}
	for (const infoKey of repoInfos.keys()) {
		const separator = infoKey.indexOf('\0');
		const cached = separator === -1 ? infoKey : infoKey.slice(0, separator);
		if (affectedBy(cached, key)) repoInfos.delete(infoKey);
	}
	for (const graphKeyName of graphs.keys()) {
		const separator = graphKeyName.indexOf('\0');
		const cached = separator === -1 ? graphKeyName : graphKeyName.slice(0, separator);
		if (affectedBy(cached, key)) graphs.delete(graphKeyName);
	}
	for (const hooksKey of hooksPaths.keys()) {
		if (affectedBy(hooksKey, key)) hooksPaths.delete(hooksKey);
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
	hooksPaths.clear();
}

/*
 * 每次仓库写命令结束后清空缓存：写命令会改变引用、提交历史、工作区或仓库配置。
 *
 * 不能只按执行目录作废：同一仓库的主工作树与链接工作树是两个不同路径，按路径作废会漏掉
 * 另一半，那些路径上的提交图与仓库信息会继续命中旧数据。
 */
onRepositoryWrite(() => { clearHostCache(); });
