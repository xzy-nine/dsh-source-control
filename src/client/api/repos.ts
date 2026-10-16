/**
 * 仓库发现、仓库同步状态与提交图查询。
 */
import type { Commit, Remote, RepoNode, RepoSync, WorkingTreeEntry } from '../shared/types.ts';
import { callApi } from './http.ts';

/** 仓库发现结果。 */
export interface DiscoveryResult {
	readonly nodes: RepoNode[];
	readonly truncated: boolean;
}

/**
 * 发现工作区根下的仓库及其工作树与子模块。
 *
 * @param cwd - 工作区根路径。
 * @param options - 发现选项；`knownRepos` 命中时宿主只核对已知路径，不扫描目录。
 * @param signal - 取消信号。
 * @returns 节点列表与是否被截断。
 */
export async function discoverRepositories(cwd: string, { maxDepth, knownRepos }: { maxDepth?: number; knownRepos?: readonly string[] } = {}, signal?: AbortSignal): Promise<DiscoveryResult> {
	const payload = await callApi(cwd, { command: 'discoverRepositories', maxDepth, knownRepos }, signal);
	return {
		nodes: (Array.isArray(payload.nodes) ? payload.nodes : []) as RepoNode[],
		truncated: payload.truncated === true,
	};
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
	return {
		branch: typeof payload.branch === 'string' ? payload.branch : null,
		upstream: typeof payload.upstream === 'string' ? payload.upstream : null,
		ahead: typeof payload.ahead === 'number' ? payload.ahead : 0,
		behind: typeof payload.behind === 'number' ? payload.behind : 0,
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

/** 提交图读取结果。 */
export interface GraphData {
	readonly commits: Commit[];
	readonly head: string | null;
	readonly remotes: Remote[];
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
	readonly signal?: AbortSignal;
}

/**
 * 读取提交图与仓库信息。
 *
 * 首屏（skip 为 0）由 `loadCommits` 一并取回仓库信息、引用集合与贮藏，因此这里不先发仓库信息请求：
 * 两次请求会各起一组 git 子进程并串行等待。翻页批没有该附带信息，此时单独补取一次。
 *
 * @param cwd - 会话工作区路径。
 * @param options - 读取选项。
 * @returns 提交、HEAD、远程与是否还有更多提交。
 */
export async function loadGraph(cwd: string, {
	maxCommits = 200, skip = 0, commitOrdering = 'topo',
	showStashes = true, showTags = true, showRemoteBranches = true,
	onlyFollowFirstParent = false, includeCommitsMentionedByReflogs = false, signal,
}: LoadGraphOptions = {}): Promise<GraphData> {
	// 只取要显示的那一段：完整提交集驻留宿主，客户端不持有大数据。
	const commitsPayload = await callApi(cwd, {
		// 偏移分页：skip 是已加载条数，正反向都用它。
		command: 'loadCommits', branches: null, skip, limit: maxCommits, showTags, showRemoteBranches,
		includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering, showStashes,
		// 不带 `stashes`：首屏由宿主按 `showStashes` 自行枚举；翻页批由宿主自行读取远程名。
		remotes: [], hideRemotes: [],
	}, signal);
	const batch = commitsPayload.repoInfo;
	const repoInfo = batch !== null && typeof batch === 'object'
		? batch as Record<string, unknown>
		: await callApi(cwd, { command: 'loadRepoInfo', showRemoteBranches, showStashes, hideRemotes: [] }, signal);
	const remotes = (Array.isArray(repoInfo.remotes) ? repoInfo.remotes : []) as Remote[];
	const head = typeof repoInfo.head === 'string' && repoInfo.head !== 'HEAD' ? repoInfo.head : null;
	return {
		commits: (Array.isArray(commitsPayload.commits) ? commitsPayload.commits : []) as Commit[],
		head,
		remotes,
		moreCommitsAvailable: commitsPayload.moreCommitsAvailable === true,
	};
}