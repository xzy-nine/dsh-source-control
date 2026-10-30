/**
 * 仓库发现、仓库同步状态与提交图查询。
 */
import type { Commit, RefItem, Remote, RepoNode, RepoSync, WorkingTreeEntry } from '../shared/types.ts';
import { callApi } from './http.ts';

/** 仓库发现结果。 */
export interface DiscoveryResult {
	readonly nodes: RepoNode[];
	readonly truncated: boolean;
	/** 宿主是否直接按持久化的仓库位置取树，未逐层扫描目录。 */
	readonly usedCache: boolean;
}

/** 仓库发现选项。 */
export interface DiscoveryOptions {
	readonly maxDepth?: number;
	/** 已知的顶层仓库路径；给出时宿主只核对已知路径，不扫描目录。 */
	readonly knownRepos?: readonly string[];
	/** 只产出顶层仓库节点，不枚举工作树与子模块。 */
	readonly shallow?: boolean;
	/** 忽略宿主持久化的仓库位置，强制逐层扫描目录。 */
	readonly fullScan?: boolean;
}

/**
 * 发现工作区根下的仓库及其工作树与子模块。
 *
 * @param cwd - 工作区根路径。
 * @param options - 见 {@link DiscoveryOptions}。
 * @param signal - 取消信号。
 * @returns 节点列表、是否被截断与是否来自持久化位置。
 */
export async function discoverRepositories(cwd: string, { maxDepth, knownRepos, shallow, fullScan }: DiscoveryOptions = {}, signal?: AbortSignal): Promise<DiscoveryResult> {
	const payload = await callApi(cwd, { command: 'discoverRepositories', maxDepth, knownRepos, shallow, fullScan }, signal);
	return {
		nodes: (Array.isArray(payload.nodes) ? payload.nodes : []) as RepoNode[],
		truncated: payload.truncated === true,
		usedCache: payload.usedCache === true,
	};
}

/**
 * 为顶层仓库节点补齐工作树与子模块。
 *
 * @param cwd - 会话工作区路径，作为 repo 传给宿主。
 * @param repos - 顶层仓库路径列表；空列表时不请求宿主。
 * @param signal - 取消信号。
 * @returns 补齐后的节点列表，顺序与入参一致。
 */
export async function enrichRepositories(cwd: string, repos: readonly string[], signal?: AbortSignal): Promise<RepoNode[]> {
	if (repos.length === 0) return [];
	const payload = await callApi(cwd, { command: 'enrichRepositories', repos }, signal);
	return (Array.isArray(payload.nodes) ? payload.nodes : []) as RepoNode[];
}

/**
 * 读取一个仓库相对其上游的领先/落后提交数。
 *
 * @param cwd - 仓库路径。
 * @param signal - 取消信号。
 * @returns 分支、上游与领先/落后数。
 */
export async function loadRepoSync(cwd: string, signal?: AbortSignal): Promise<RepoSync> {
	const payload = await callApi(cwd, { command: 'loadRepoSync' }, signal);
	return readSyncFields(payload);
}

/** 一个仓库的分支同步状态。 */
export interface RepoSyncEntry extends RepoSync {
	readonly path: string;
}

/**
 * 批量读取多个仓库相对其上游的领先/落后提交数。
 *
 * @param cwd - 会话工作区路径，作为 repo 传给宿主。
 * @param repos - 仓库路径列表；空列表时宿主直接返回空结果，不读仓库。
 * @param signal - 取消信号。
 * @returns 按 `path` 与入参对齐的同步状态；宿主无法读取的仓库以空值兜底。
 */
export async function loadReposSync(cwd: string, repos: readonly string[], signal?: AbortSignal): Promise<RepoSyncEntry[]> {
	const payload = await callApi(cwd, { command: 'loadReposSync', repos }, signal);
	const results = Array.isArray(payload.results) ? payload.results : [];
	const entries: RepoSyncEntry[] = [];
	for (const item of results) {
		if (item === null || typeof item !== 'object') continue;
		const record = item as Record<string, unknown>;
		// path 缺失的记录无法与入参对齐，丢弃。
		if (typeof record.path !== 'string') continue;
		entries.push({ path: record.path, ...readSyncFields(record) });
	}
	return entries;
}

/**
 * 从命令载荷读取分支同步字段。
 *
 * @param source - 命令响应或 results 中的一条记录。
 * @returns 分支、上游与领先/落后数；字段缺失或类型不符时取空值。
 */
function readSyncFields(source: Record<string, unknown>): RepoSync {
	return {
		branch: typeof source.branch === 'string' ? source.branch : null,
		upstream: typeof source.upstream === 'string' ? source.upstream : null,
		ahead: typeof source.ahead === 'number' ? source.ahead : 0,
		behind: typeof source.behind === 'number' ? source.behind : 0,
	};
}

/** 工作区快照：变更条目与仓库同步状态。 */
export interface WorkingTreeSnapshot {
	readonly entries: WorkingTreeEntry[];
	/** 本次读取时的 HEAD 提交哈希；尚无提交时为 null。 */
	readonly head: string | null;
	readonly branch: string | null;
	readonly upstream: string | null;
	readonly ahead: number;
	readonly behind: number;
	/** 是否处于未完成的合并：有冲突待解决，或无冲突但尚未提交。 */
	readonly merging: boolean;
}

/**
 * 读取工作区快照。
 *
 * @param cwd - 仓库路径。
 * @param signal - 取消信号。
 * @param noCache - 跳过宿主快照缓存，强制读当前值；兜底轮询用它，否则命中缓存会让签名
 *   永远不变，外部改动再也发现不了。
 * @returns 变更条目与分支、上游、领先/落后数与合并状态。
 */
export async function loadWorkingTreeSnapshot(cwd: string, signal?: AbortSignal, noCache = false): Promise<WorkingTreeSnapshot> {
	const payload = await callApi(cwd, { command: 'loadWorkingTreeSnapshot', noCache }, signal);
	return {
		entries: (Array.isArray(payload.entries) ? payload.entries : []) as WorkingTreeEntry[],
		head: typeof payload.head === 'string' ? payload.head : null,
		branch: typeof payload.branch === 'string' ? payload.branch : null,
		upstream: typeof payload.upstream === 'string' ? payload.upstream : null,
		ahead: typeof payload.ahead === 'number' ? payload.ahead : 0,
		behind: typeof payload.behind === 'number' ? payload.behind : 0,
		merging: payload.merging === true,
	};
}

/** 贮藏条目：字段与宿主 `git-types.ts` 的 `StashEntry` 一致。 */
export interface GraphStash {
	/** 贮藏提交哈希。 */
	readonly hash: string;
	/** 基提交哈希。 */
	readonly baseHash: string;
	/** 未跟踪文件所在的提交；无则为 null。 */
	readonly untrackedFilesHash: string | null;
	/** 选择器（如 `refs/stash@{0}`）。 */
	readonly selector: string;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}

/** 提交图读取结果。 */
export interface GraphData {
	readonly commits: Commit[];
	/** 当前分支名；取自仓库信息、响应自带的 `branch` 或调用方给出的兜底值，都缺失时为 null。 */
	readonly head: string | null;
	readonly remotes: Remote[];
	/** 本批使用的贮藏列表；未取仓库信息时为调用方给出的那份。 */
	readonly stashes: GraphStash[];
	/** 是否还有更多提交未返回。 */
	readonly moreCommitsAvailable: boolean;
	/** 下一个窗口的偏移量；按宿主 `git log` 记录数计，翻页直接用它。 */
	readonly nextSkip: number;
	/** 被别的工作树检出的本地分支：照常显示，但不可在本工作树检出、删除或重命名。 */
	readonly foreignBranches: string[];
	/**
	 * 本次响应是否确实带回了仓库信息且读取成功。
	 *
	 * 仅在为真时才把远程与贮藏记为已知值：读取失败时记下会把失败当事实固化到下一次写操作。
	 */
	readonly infoKnown: boolean;
}

/** 提交图读取选项。 */
export interface LoadGraphOptions {
	/** 从起点跳过的提交数；反向（往更新方向）翻页按绝对偏移取用。 */
	readonly skip?: number;
	readonly maxCommits?: number;
	readonly commitOrdering?: string;
	readonly showStashes?: boolean;
	readonly showTags?: boolean;
	readonly showRemoteBranches?: boolean;
	readonly onlyFollowFirstParent?: boolean;
	readonly includeCommitsMentionedByReflogs?: boolean;
	/**
	 * 是否让宿主随本批取回仓库信息（分支、远程与贮藏）。
	 *
	 * 首次进入该仓库时为 true；刷新时给 false 并传入已知的 `remotes` 与 `stashes`，
	 * 宿主因此不重取仓库信息批。
	 */
	readonly withRepoInfo?: boolean;
	/** 已知远程列表；给出时随请求传给宿主，宿主按它标注远程分支。 */
	readonly remotes?: readonly Remote[];
	/** 已知贮藏列表；给出时以它为准，宿主不再枚举贮藏。 */
	readonly stashes?: readonly GraphStash[];
	/** 已知当前分支名；未取仓库信息时用它填充 `head`。 */
	readonly branch?: string | null;
	/**
	 * 取数起点：引用名列表；null 表示全部引用（宿主按 `--branches` 等枚举）。
	 *
	 * 引用筛选在这里落地：`git log` 只遍历这些引用的历史，分页与窗口因此随筛选变化。
	 */
	readonly branches?: readonly string[] | null;
	readonly signal?: AbortSignal;
}

/**
 * 请宿主作废其内存缓存。
 *
 * 写操作已由宿主执行层自动作废该仓库的缓存；本命令覆盖外部进程改动仓库的情形——那种改动
 * 不产生写事件，宿主无从得知，只能由读到 HEAD 变化的客户端显式请求。
 *
 * @param cwd - 会话工作区路径，作为 repo 传给宿主。
 * @param signal - 取消信号。
 * @returns 无。
 */
export async function invalidateHostCache(cwd: string, signal?: AbortSignal): Promise<void> {
	await callApi(cwd, { command: 'invalidateCache' }, signal);
}

/**
 * 读取提交图。
 *
 * `withRepoInfo` 为 true 时宿主随本批取回仓库信息、引用集合与贮藏，这里不先发仓库信息请求：
 * 两次请求会各起一组 git 子进程并串行等待。为 false 时由调用方传入已知的 `remotes` 与
 * `stashes`，本函数直接用它们组装结果，不再补取仓库信息；两者都未给出时才回退一次
 * `loadRepoInfo`（该请求本身带仓库信息，代价与取数相同）。
 *
 * @param cwd - 会话工作区路径。
 * @param options - 读取选项。
 * @returns 提交、当前分支名、远程、贮藏与是否还有更多提交。
 */
export async function loadGraph(cwd: string, {
	maxCommits = 200, skip = 0, commitOrdering = 'topo',
	showStashes = true, showTags = true, showRemoteBranches = true,
	onlyFollowFirstParent = false, includeCommitsMentionedByReflogs = false,
	withRepoInfo = false, remotes: givenRemotes, stashes: givenStashes, branch, branches = null, signal,
}: LoadGraphOptions = {}): Promise<GraphData> {
	// 只取要显示的那一段：完整提交集驻留宿主，客户端不持有大数据。
	const commitsPayload = await callApi(cwd, {
		// 偏移分页：skip 是已加载条数，正反向都用它。
		command: 'loadCommits', branches, skip, limit: maxCommits, showTags, showRemoteBranches,
		includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering, showStashes,
		withRepoInfo,
		// 调用方未给出时按宿主默认（空列表）处理，由宿主自行读取。
		...(givenRemotes === undefined ? {} : { remotes: givenRemotes }),
		...(givenStashes === undefined ? {} : { stashes: givenStashes }),
		hideRemotes: [],
	}, signal);
	const batch = commitsPayload.repoInfo;
	const fetched = batch !== null && typeof batch === 'object' ? batch as Record<string, unknown> : null;
	/*
	 * 已知远程与贮藏都给出时不再补取仓库信息：本批响应已足够组装结果，补取只会多起一组子进程。
	 */
	const repoInfo = fetched ?? (givenRemotes !== undefined && givenStashes !== undefined
		? null
		: await callApi(cwd, { command: 'loadRepoInfo', showRemoteBranches, showStashes, hideRemotes: [] }, signal));
	const remotes = (repoInfo === null ? givenRemotes : repoInfo.remotes) as Remote[] | undefined;
	const stashes = (repoInfo === null ? givenStashes : repoInfo.stashes) as GraphStash[] | undefined;
	/*
	 * 当前分支名：未取仓库信息时用响应自带的 `branch`（宿主随提交图一次读出），调用方给出的
	 * `branch` 只作兜底。刷新路径（`withRepoInfo` 为 false）因此同样能标出当前分支。
	 */
	const batchBranch = typeof commitsPayload.branch === 'string' && commitsPayload.branch !== '' ? commitsPayload.branch : null;
	const head = repoInfo === null
		? (batchBranch ?? (typeof branch === 'string' && branch !== '' ? branch : null))
		: (typeof repoInfo.head === 'string' && repoInfo.head !== 'HEAD' ? repoInfo.head : null);
	return {
		commits: (Array.isArray(commitsPayload.commits) ? commitsPayload.commits : []) as Commit[],
		head,
		remotes: Array.isArray(remotes) ? remotes : [],
		stashes: Array.isArray(stashes) ? stashes : [],
		moreCommitsAvailable: commitsPayload.moreCommitsAvailable === true,
		// 宿主未给出时按「本页之后」推进，兼容旧宿主的响应。
		nextSkip: typeof commitsPayload.nextSkip === 'number' ? commitsPayload.nextSkip : skip + (Array.isArray(commitsPayload.commits) ? commitsPayload.commits.length : 0),
		foreignBranches: Array.isArray(commitsPayload.foreignBranches)
			? (commitsPayload.foreignBranches as unknown[]).filter((name): name is string => typeof name === 'string')
			: [],
		infoKnown: fetched !== null && fetched.error === null,
	};
}
/** 引用类型到展示词。 */
const REF_KIND: Record<'branch' | 'remote' | 'tag', string> = { branch: '分支', remote: '远程', tag: '标记' };

/**
 * 读取仓库的全部引用，供引用筛选弹窗与手选校验使用。
 *
 * 与提交图取数分开：只在打开弹窗或需要校验手选引用时请求，刷新路径不起这次 `for-each-ref`。
 *
 * @param cwd - 仓库路径。
 * @param showRemoteBranches - 是否包含远程分支。
 * @param signal - 取消信号。
 * @returns 分支、远程分支与标签。
 */
export async function loadRefs(cwd: string, showRemoteBranches = true, signal?: AbortSignal): Promise<RefItem[]> {
	const payload = await callApi(cwd, { command: 'loadRefs', showRemoteBranches }, signal);
	const list = Array.isArray(payload.refs) ? payload.refs : [];
	const refs: RefItem[] = [];
	for (const item of list) {
		if (item === null || typeof item !== 'object') continue;
		const record = item as Record<string, unknown>;
		if (typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.hash !== 'string') continue;
		const type = record.type === 'branch' || record.type === 'remote' || record.type === 'tag' ? record.type : null;
		if (type === null) continue;
		refs.push({ id: record.id, name: record.name, hash: record.hash, type, kind: REF_KIND[type] });
	}
	return refs;
}

/**
 * 读取当前分支的分叉来源分支。
 *
 * 与 VS Code 图形视图的 base 引用同一判据：配置、分支 reflog 的创建来源、默认远程的默认分支。
 *
 * @param cwd - 仓库路径。
 * @param signal - 取消信号。
 * @returns 当前分支与分叉来源的引用短名；分离头指针时两者皆为 null。
 */
export async function loadBranchBase(cwd: string, signal?: AbortSignal): Promise<{ branch: string | null; base: string | null }> {
	const payload = await callApi(cwd, { command: 'loadBranchBase' }, signal);
	return {
		branch: typeof payload.branch === 'string' ? payload.branch : null,
		base: typeof payload.base === 'string' ? payload.base : null,
	};
}
