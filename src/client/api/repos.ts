/**
 * 仓库发现、仓库同步状态与提交图查询。
 */
import type { Commit, Remote, RepoNode, RepoSync, WorkingTreeEntry } from '../shared/types.ts';
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
}

/**
 * 读取工作区快照。
 *
 * @param cwd - 仓库路径。
 * @param signal - 取消信号。
 * @returns 变更条目与分支、上游、领先/落后数。
 */
export async function loadWorkingTreeSnapshot(cwd: string, signal?: AbortSignal): Promise<WorkingTreeSnapshot> {
	const payload = await callApi(cwd, { command: 'loadWorkingTreeSnapshot' }, signal);
	return {
		entries: (Array.isArray(payload.entries) ? payload.entries : []) as WorkingTreeEntry[],
		head: typeof payload.head === 'string' ? payload.head : null,
		branch: typeof payload.branch === 'string' ? payload.branch : null,
		upstream: typeof payload.upstream === 'string' ? payload.upstream : null,
		ahead: typeof payload.ahead === 'number' ? payload.ahead : 0,
		behind: typeof payload.behind === 'number' ? payload.behind : 0,
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
	/** 当前分支名；未取仓库信息且调用方未给出分支名时为 null。 */
	readonly head: string | null;
	readonly remotes: Remote[];
	/** 本批使用的贮藏列表；未取仓库信息时为调用方给出的那份。 */
	readonly stashes: GraphStash[];
	/** 下一页的游标（本页最后一条的 hash）；无更多时为 null。 */
	readonly moreCommitsAvailable: boolean;
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
	readonly signal?: AbortSignal;
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
	withRepoInfo = false, remotes: givenRemotes, stashes: givenStashes, branch, signal,
}: LoadGraphOptions = {}): Promise<GraphData> {
	// 只取要显示的那一段：完整提交集驻留宿主，客户端不持有大数据。
	const commitsPayload = await callApi(cwd, {
		// 偏移分页：skip 是已加载条数，正反向都用它。
		command: 'loadCommits', branches: null, skip, limit: maxCommits, showTags, showRemoteBranches,
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
	const head = repoInfo === null
		? (typeof branch === 'string' && branch !== '' ? branch : null)
		: (typeof repoInfo.head === 'string' && repoInfo.head !== 'HEAD' ? repoInfo.head : null);
	return {
		commits: (Array.isArray(commitsPayload.commits) ? commitsPayload.commits : []) as Commit[],
		head,
		remotes: Array.isArray(remotes) ? remotes : [],
		stashes: Array.isArray(stashes) ? stashes : [],
		moreCommitsAvailable: commitsPayload.moreCommitsAvailable === true,
	};
}