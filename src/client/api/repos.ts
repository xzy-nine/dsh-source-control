/**
 * 仓库发现、仓库同步状态与提交图查询。
 */
import type { Commit, Remote, RepoNode, RepoSync } from '../shared/types.ts';
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

/** 提交图读取结果。 */
export interface GraphData {
	readonly commits: Commit[];
	readonly head: string | null;
	readonly remotes: Remote[];
	readonly moreCommitsAvailable: boolean;
}

/** 提交图读取选项。 */
export interface LoadGraphOptions {
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
 * `loadCommits` 需要仓库的远程列表与 stash 列表参与引用标注，因此先取仓库信息。
 *
 * @param cwd - 会话工作区路径。
 * @param options - 读取选项。
 * @returns 提交、HEAD、远程与是否还有更多提交。
 */
export async function loadGraph(cwd: string, {
	maxCommits = 200, commitOrdering = 'topo',
	showStashes = true, showTags = true, showRemoteBranches = true,
	onlyFollowFirstParent = false, includeCommitsMentionedByReflogs = false, signal,
}: LoadGraphOptions = {}): Promise<GraphData> {
	const repoInfo = await callApi(cwd, {
		command: 'loadRepoInfo', showRemoteBranches, showStashes, hideRemotes: [],
	}, signal);
	const remotes = (Array.isArray(repoInfo.remotes) ? repoInfo.remotes : []) as Remote[];
	const commitsPayload = await callApi(cwd, {
		command: 'loadCommits', branches: null, maxCommits, showTags, showRemoteBranches,
		includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering,
		remotes, hideRemotes: [], stashes: Array.isArray(repoInfo.stashes) ? repoInfo.stashes : [],
	}, signal);
	const head = typeof repoInfo.head === 'string' && repoInfo.head !== 'HEAD' ? repoInfo.head : null;
	return {
		commits: (Array.isArray(commitsPayload.commits) ? commitsPayload.commits : []) as Commit[],
		head,
		remotes,
		moreCommitsAvailable: commitsPayload.moreCommitsAvailable === true,
	};
}
