/**
 * 宿主 API 客户端：把命令发到 POST /dsh-dev-git-graph/gg/api。
 *
 * 该路由沿用移植版的命令集（loadCommits / loadRepoInfo 等），并新增工作区变更命令。
 * 所有调用都以 JSON 往返，失败以抛出携带 error 文本的 Error 表示。
 */
import type { Commit, Remote, RepoNode, RepoSync, WorkingTreeEntry } from './types.ts';

/** API 路由，与宿主注册的路径一致。 */
const API_PATH = '/dsh-dev-git-graph/gg/api';

/**
 * 调用一条宿主命令。
 *
 * @param cwd - 会话工作区路径，作为 repo 传给宿主。
 * @param message - 命令载荷，`command` 由调用方给出。
 * @param signal - 取消信号；中止时 fetch 抛 AbortError。
 * @returns 宿主响应。
 */
export async function callApi(cwd: string, message: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const response = await fetch(API_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ repo: cwd, ...message }),
		signal,
	});
	if (!response.ok) throw new Error(`宿主返回 ${response.status}`);
	const payload = await response.json() as Record<string, unknown>;
	const { error } = payload;
	if (typeof error === 'string' && error !== '') throw new Error(error);
	return payload;
}

/** 仓库发现结果。 */
export interface DiscoveryResult {
	readonly nodes: RepoNode[];
	readonly truncated: boolean;
}

/**
 * 发现工作区根下的仓库及其工作树与子模块。
 *
 * @param cwd - 工作区根路径。
 * @param options - 发现选项。
 * @param signal - 取消信号。
 * @returns 节点列表与是否被截断。
 */
export async function discoverRepositories(cwd: string, { maxDepth }: { maxDepth?: number } = {}, signal?: AbortSignal): Promise<DiscoveryResult> {
	const payload = await callApi(cwd, { command: 'discoverRepositories', maxDepth }, signal);
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

/**
 * 读取工作区变更。
 *
 * @param cwd - 会话工作区路径。
 * @param signal - 取消信号。
 * @returns 变更列表。
 */
export async function loadWorkingTree(cwd: string, signal?: AbortSignal): Promise<WorkingTreeEntry[]> {
	const payload = await callApi(cwd, { command: 'loadWorkingTree' }, signal);
	return (Array.isArray(payload.entries) ? payload.entries : []) as WorkingTreeEntry[];
}

/**
 * 暂存路径。
 *
 * @param cwd - 会话工作区路径。
 * @param paths - 要暂存的路径；空数组表示全部。
 * @returns 无。
 */
export async function stagePaths(cwd: string, paths: readonly string[]): Promise<void> {
	await callApi(cwd, { command: 'stagePaths', paths });
}

/**
 * 取消暂存路径。
 *
 * @param cwd - 会话工作区路径。
 * @param paths - 要取消暂存的路径；空数组表示全部。
 * @returns 无。
 */
export async function unstagePaths(cwd: string, paths: readonly string[]): Promise<void> {
	await callApi(cwd, { command: 'unstagePaths', paths });
}

/**
 * 丢弃路径上的改动。
 *
 * @param cwd - 会话工作区路径。
 * @param paths - 要丢弃的路径。
 * @param untracked - 这些路径是否都是未跟踪文件。
 * @returns 无。
 */
export async function discardPaths(cwd: string, paths: readonly string[], untracked: boolean): Promise<void> {
	await callApi(cwd, { command: 'discardPaths', paths, untracked });
}

/**
 * 提交暂存区内容。
 *
 * @param cwd - 会话工作区路径。
 * @param message - 提交信息。
 * @param amend - 是否修补上一次提交。
 * @returns 新提交哈希。
 */
export async function commitStaged(cwd: string, message: string, amend = false): Promise<string> {
	const payload = await callApi(cwd, { command: 'commitStaged', message, amend });
	return typeof payload.hash === 'string' ? payload.hash : '';
}

/** 提交改动文件。 */
export interface CommitFileEntry {
	readonly path: string;
	readonly type: string;
	readonly additions: number | null;
	readonly deletions: number | null;
}

/**
 * 读取某个提交的改动文件。
 *
 * @param cwd - 会话工作区路径。
 * @param hash - 提交哈希，`*` 表示工作区未提交变更。
 * @param signal - 取消信号。
 * @returns 改动文件列表。
 */
export async function loadCommitFiles(cwd: string, hash: string, signal?: AbortSignal): Promise<CommitFileEntry[]> {
	const payload = await callApi(cwd, { command: 'commitDetails', commitHash: hash, hasParents: true, stash: null }, signal);
	const details = payload.commitDetails as { fileChanges?: Array<Record<string, unknown>> } | null | undefined;
	const changes = details !== null && typeof details === 'object' && Array.isArray(details.fileChanges) ? details.fileChanges : [];
	return changes.map((change) => ({
		path: String(change.newFilePath),
		type: String(change.type),
		additions: typeof change.additions === 'number' ? change.additions : null,
		deletions: typeof change.deletions === 'number' ? change.deletions : null,
	}));
}

/**
 * 读取某个提交的完整提交信息。
 *
 * 提交列表里的 message 来自 `git log --format=%s`，只有标题一行；悬停卡片要显示完整
 * 正文，因此按需从 `commitDetails` 取（该命令的 `%B` 含完整消息）。
 *
 * @param cwd - 会话工作区路径。
 * @param hash - 提交哈希，`*` 表示工作区未提交变更。
 * @param signal - 取消信号。
 * @returns 完整提交信息；取不到时返回 null。
 */
export async function loadCommitMessage(cwd: string, hash: string, signal?: AbortSignal): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'commitDetails', commitHash: hash, hasParents: true, stash: null }, signal);
	const details = payload.commitDetails as { body?: unknown } | null | undefined;
	return details !== null && details !== undefined && typeof details.body === 'string' ? details.body : null;
}

/**
 * 取包含某个提交的分支（本地与远程）。
 *
 * 分支只由尖端提交标识，提交列表里中间提交的 `heads` 为空，因此不能凭它判断所属分支，
 * 需按包含关系向 git 查询。
 *
 * @param cwd - 会话工作区路径。
 * @param hash - 提交哈希。
 * @returns 本地与远程分支短名。
 */
export async function branchesContaining(cwd: string, hash: string): Promise<{ local: string[]; remote: string[] }> {
	const payload = await callApi(cwd, { command: 'branchesContaining', commitHash: hash });
	const read = (value: unknown): string[] => Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
	return { local: read(payload.local), remote: read(payload.remote) };
}

/**
 * 抓取远端引用。
 *
 * @param cwd - 会话工作区路径。
 * @param name - 远程名；null 表示全部远程。
 * @param prune - 是否修剪已删除的远程分支。
 * @param pruneTags - 是否修剪远程标签。
 * @returns 无。
 */
export async function fetchRepo(cwd: string, name: string | null, prune = false, pruneTags = false): Promise<void> {
	await callApi(cwd, { command: 'fetch', name, prune, pruneTags });
}

/**
 * 推送分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 要推送的分支名。
 * @param remotes - 目标远程仓库；空数组表示不推送。
 * @returns 每条远程的结果错误，无错误时为空数组。
 */
export async function pushBranch(cwd: string, branchName: string, remotes: readonly string[]): Promise<string[]> {
	const payload = await callApi(cwd, { command: 'pushBranch', branchName, remotes, setUpstream: true, mode: '' });
	return Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 读取仓库配置（远程、issue 链接等）。
 *
 * @param cwd - 会话工作区路径。
 * @param remotes - 远程名列表。
 * @returns 配置数据。
 */
export async function loadConfig(cwd: string, remotes: readonly string[]): Promise<Record<string, unknown>> {
	return callApi(cwd, { command: 'loadConfig', remotes });
}
/**
 * 检出指定分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 分支名。
 * @param remoteBranch - 新建并跟踪的远程分支；本地已有时传 null。
 * @returns 错误文本，无错误时返回 null。
 */
export async function checkoutBranch(cwd: string, branchName: string, remoteBranch: string | null = null): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'checkoutBranch', branchName, remoteBranch });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 从某提交创建分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 新分支名。
 * @param commitHash - 起点提交哈希。
 * @param checkout - 创建后是否检出。
 * @param force - 是否强制覆盖同名分支。
 * @returns 错误文本，无错误时返回 null。
 */
export async function createBranch(cwd: string, branchName: string, commitHash: string, checkout = true, force = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'createBranch', branchName, commitHash, checkout, force });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 删除本地分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 分支名。
 * @param forceDelete - 是否强制删除未合并分支。
 * @param deleteOnRemotes - 同时删除的远程分支名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function deleteBranch(cwd: string, branchName: string, forceDelete = false, deleteOnRemotes: readonly string[] = []): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'deleteBranch', branchName, forceDelete, deleteOnRemotes });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 重命名分支。
 *
 * @param cwd - 会话工作区路径。
 * @param oldName - 原分支名。
 * @param newName - 新分支名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function renameBranch(cwd: string, oldName: string, newName: string): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'renameBranch', oldName, newName });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 删除远程分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 远程分支短名（含远程前缀由 remote 拼接）。
 * @param remote - 远程名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function deleteRemoteBranch(cwd: string, branchName: string, remote: string): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'deleteRemoteBranch', branchName, remote });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把远程分支取到同名本地分支。
 *
 * @param cwd - 会话工作区路径。
 * @param remote - 远程名。
 * @param remoteBranch - 远程分支名。
 * @param localBranch - 本地分支名。
 * @param force - 是否强制覆盖本地分支。
 * @returns 错误文本，无错误时返回 null。
 */
export async function fetchIntoLocalBranch(cwd: string, remote: string, remoteBranch: string, localBranch: string, force = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'fetchIntoLocalBranch', remote, remoteBranch, localBranch, force });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把远程分支拉入当前分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 远程分支名。
 * @param remote - 远程名。
 * @param createNewCommit - 是否生成合并提交。
 * @param squash - 是否压缩合并。
 * @returns 错误文本，无错误时返回 null。
 */
export async function pullBranch(cwd: string, branchName: string, remote: string, createNewCommit = false, squash = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'pullBranch', branchName, remote, createNewCommit, squash });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 检出指定提交（分离 HEAD）。
 *
 * @param cwd - 会话工作区路径。
 * @param commitHash - 提交哈希。
 * @returns 错误文本，无错误时返回 null。
 */
export async function checkoutCommit(cwd: string, commitHash: string): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'checkoutCommit', commitHash });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把提交拣选到当前分支。
 *
 * @param cwd - 会话工作区路径。
 * @param commitHash - 提交哈希。
 * @param parentIndex - 合并提交要拣选的父提交序号；非合并提交传 -1。
 * @param recordOrigin - 是否在提交信息记录来源。
 * @param noCommit - 是否只应用改动不提交。
 * @returns 错误文本，无错误时返回 null。
 */
export async function cherrypickCommit(cwd: string, commitHash: string, parentIndex = -1, recordOrigin = false, noCommit = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'cherrypickCommit', commitHash, parentIndex, recordOrigin, noCommit });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 把当前分支重置到指定提交。
 *
 * @param cwd - 会话工作区路径。
 * @param commitHash - 目标提交哈希。
 * @param resetMode - 重置模式。
 * @returns 错误文本，无错误时返回 null。
 */
export async function resetToCommit(cwd: string, commitHash: string, resetMode = 'mixed'): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'resetToCommit', commit: commitHash, resetMode });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 在指定提交上生成还原提交。
 *
 * @param cwd - 会话工作区路径。
 * @param commitHash - 要还原的提交哈希。
 * @param parentIndex - 合并提交要还原的父提交序号；非合并提交传 -1。
 * @returns 错误文本，无错误时返回 null。
 */
export async function revertCommit(cwd: string, commitHash: string, parentIndex = -1): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'revertCommit', commitHash, parentIndex });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把目标合并进当前分支。
 *
 * @param cwd - 会话工作区路径。
 * @param obj - 目标分支名或提交哈希。
 * @param createNewCommit - 是否生成合并提交。
 * @param squash - 是否压缩合并。
 * @param noCommit - 是否只应用改动不提交。
 * @returns 错误文本，无错误时返回 null。
 */
export async function merge(cwd: string, obj: string, createNewCommit = false, squash = false, noCommit = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'merge', obj, actionOn: 'Branch', createNewCommit, squash, noCommit });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把当前分支变基到目标。
 *
 * @param cwd - 会话工作区路径。
 * @param obj - 目标分支名或提交哈希。
 * @param ignoreDate - 是否保留原提交时间。
 * @param interactive - 是否交互式变基。
 * @returns 错误文本，无错误时返回 null。
 */
export async function rebase(cwd: string, obj: string, ignoreDate = true, interactive = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'rebase', obj, actionOn: 'Branch', ignoreDate, interactive });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 在当前分支添加标签。
 *
 * @param cwd - 会话工作区路径。
 * @param tagName - 标签名。
 * @param commitHash - 目标提交哈希。
 * @param type - 标签类型：0 轻量、1 附注。
 * @param message - 附注标签信息。
 * @param force - 是否强制覆盖同名标签。
 * @param pushToRemote - 创建后推送到的远程名；不推送传 null。
 * @returns 错误文本，无错误时返回 null。
 */
export async function addTag(cwd: string, tagName: string, commitHash: string, type = 0, message = '', force = false, pushToRemote: string | null = null): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'addTag', tagName, commitHash, type, message, force, pushToRemote });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 删除标签。
 *
 * @param cwd - 会话工作区路径。
 * @param tagName - 标签名。
 * @param deleteOnRemote - 同时删除的远程名；不删远程传 null。
 * @returns 错误文本，无错误时返回 null。
 */
export async function deleteTag(cwd: string, tagName: string, deleteOnRemote: string | null = null): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'deleteTag', tagName, deleteOnRemote });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 推送标签到远程。
 *
 * @param cwd - 会话工作区路径。
 * @param tagName - 标签名。
 * @param remotes - 目标远程名列表。
 * @param commitHash - 标签指向的提交哈希。
 * @param skipRemoteCheck - 是否跳过远程存在性检查。
 * @returns 错误文本，无错误时返回 null。
 */
export async function pushTag(cwd: string, tagName: string, remotes: readonly string[], commitHash: string, skipRemoteCheck = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'pushTag', tagName, remotes, commitHash, skipRemoteCheck });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 删除远程。
 *
 * @param cwd - 会话工作区路径。
 * @param name - 远程名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function deleteRemote(cwd: string, name: string): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'deleteRemote', name });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 编辑 git 用户身份（user.name 与 user.email）。
 *
 * @param cwd - 会话工作区路径。
 * @param name - 用户名。
 * @param email - 邮箱。
 * @param location - 写入位置。
 * @param deleteLocalName - 是否同时删除本地 user.name 覆盖。
 * @param deleteLocalEmail - 是否同时删除本地 user.email 覆盖。
 * @returns 错误列表，无错误时为空数组。
 */
export async function editUserDetails(cwd: string, name: string, email: string, location: string, deleteLocalName: boolean, deleteLocalEmail: boolean): Promise<string[]> {
	const payload = await callApi(cwd, { command: 'editUserDetails', name, email, location, deleteLocalName, deleteLocalEmail });
	return Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 删除 git 用户身份。
 *
 * @param cwd - 会话工作区路径。
 * @param name - 是否删除 user.name。
 * @param email - 是否删除 user.email。
 * @param location - 删除位置。
 * @returns 错误列表，无错误时为空数组。
 */
export async function deleteUserDetails(cwd: string, name: boolean, email: boolean, location: string): Promise<string[]> {
	const payload = await callApi(cwd, { command: 'deleteUserDetails', name, email, location });
	return Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 应用贮藏。
 *
 * @param cwd - 会话工作区路径。
 * @param selector - 贮藏选择器（如 stash@{0}）。
 * @param reinstateIndex - 是否恢复暂存区。
 * @returns 错误文本，无错误时返回 null。
 */
export async function applyStash(cwd: string, selector: string, reinstateIndex = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'applyStash', selector, reinstateIndex });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 从贮藏创建分支。
 *
 * @param cwd - 会话工作区路径。
 * @param selector - 贮藏选择器。
 * @param branchName - 新分支名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function branchFromStash(cwd: string, selector: string, branchName: string): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'branchFromStash', selector, branchName });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 丢弃贮藏。
 *
 * @param cwd - 会话工作区路径。
 * @param selector - 贮藏选择器。
 * @returns 错误文本，无错误时返回 null。
 */
export async function dropStash(cwd: string, selector: string): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'dropStash', selector });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 弹出贮藏。
 *
 * @param cwd - 会话工作区路径。
 * @param selector - 贮藏选择器。
 * @param reinstateIndex - 是否恢复暂存区。
 * @returns 错误文本，无错误时返回 null。
 */
export async function popStash(cwd: string, selector: string, reinstateIndex = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'popStash', selector, reinstateIndex });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 新建贮藏。
 *
 * @param cwd - 会话工作区路径。
 * @param message - 贮藏说明。
 * @param includeUntracked - 是否一并贮藏未跟踪文件。
 * @returns 错误文本，无错误时返回 null。
 */
export async function pushStash(cwd: string, message: string, includeUntracked = true): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'pushStash', message, includeUntracked });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 清理未跟踪文件。
 *
 * @param cwd - 会话工作区路径。
 * @param directories - 是否连未跟踪目录一并删除。
 * @returns 错误文本，无错误时返回 null。
 */
export async function cleanUntrackedFiles(cwd: string, directories = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'cleanUntrackedFiles', directories });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/** 附注标签详情。 */
export interface TagDetails {
	readonly message?: string;
	readonly tagger?: string;
	readonly date?: string;
}

/**
 * 读取附注标签详情（消息、打标签者、日期）。
 *
 * @param cwd - 会话工作区路径。
 * @param tagName - 标签名。
 * @param commitHash - 标签指向的提交哈希。
 * @returns 标签详情，轻量标签返回 null。
 */
export async function tagDetails(cwd: string, tagName: string, commitHash: string): Promise<TagDetails | null> {
	const payload = await callApi(cwd, { command: 'tagDetails', tagName, commitHash });
	return (payload.tagDetails ?? null) as TagDetails | null;
}

/**
 * 添加远程仓库。
 *
 * @param cwd - 会话工作区路径。
 * @param name - 远程名。
 * @param url - 抓取 URL。
 * @param pushUrl - 推送 URL；与抓取 URL 相同时传 null。
 * @param fetch - 添加后是否立即抓取。
 * @returns 错误文本，无错误时返回 null。
 */
export async function addRemote(cwd: string, name: string, url: string, pushUrl: string | null = null, fetch = false): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'addRemote', name, url, pushUrl, fetch });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 编辑远程仓库（名称、URL、推送 URL）。
 *
 * @param cwd - 会话工作区路径。
 * @param nameOld - 原远程名。
 * @param nameNew - 新远程名。
 * @param urlOld - 原 URL。
 * @param urlNew - 新 URL。
 * @param pushUrlOld - 原推送 URL。
 * @param pushUrlNew - 新推送 URL。
 * @returns 错误文本，无错误时返回 null。
 */
export async function editRemote(cwd: string, nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'editRemote', nameOld, nameNew, urlOld, urlNew, pushUrlOld, pushUrlNew });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 创建归档（zip/tar/tar.gz）。
 *
 * @param cwd - 会话工作区路径。
 * @param ref - 归档起点（分支名、标签名或提交哈希）。
 * @param format - 归档格式：'zip'、'tar' 或 'tgz'。
 * @param outputPath - 归档输出路径（绝对路径）。
 * @returns 错误文本，无错误时返回 null。
 */
export async function createArchive(cwd: string, ref: string, format: string, outputPath: string): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'createArchive', ref, format, outputPath });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 导出仓库配置为 JSON。
 *
 * @param cwd - 会话工作区路径。
 * @returns 仓库配置对象。
 */
export async function exportRepoConfig(cwd: string): Promise<Record<string, unknown> | null> {
	const payload = await callApi(cwd, { command: 'exportRepoConfig' });
	return (payload.config ?? null) as Record<string, unknown> | null;
}

/** 差异内容。 */
export interface FileDiffContent {
	readonly path?: string;
	readonly oldText: string | null;
	readonly newText: string | null;
	/** 由 git 算出的逐块差异（形状同 DSH 的 WorkspaceDiffHunk）。 */
	readonly hunks: Array<{
		readonly oldStart: number;
		readonly oldLines: number;
		readonly newStart: number;
		readonly newLines: number;
		readonly lines: string[];
	}>;
}

/**
 * 取某个提交中某文件的前后内容与逐块差异。
 *
 * hunks 由宿主用 git 直接算出：前端本地 diff 在改动量超过其搜索上限时会退化成整文件
 * 「全删全加」，因此逐块差异优先。
 *
 * @param cwd - 会话工作区路径。
 * @param hash - 提交哈希；'*' 表示工作区。
 * @param path - 文件路径（相对仓库根）。
 * @param staged - 工作区时是否取暂存区内容。
 * @returns 前后内容与逐块差异。
 */
export async function fileDiffContent(cwd: string, hash: string, path: string, staged = false): Promise<FileDiffContent> {
	const payload = await callApi(cwd, { command: 'fileDiffContent', commitHash: hash, filePath: path, staged });
	const raw = Array.isArray(payload.hunks) ? payload.hunks : [];
	const hunks: FileDiffContent['hunks'] = raw.flatMap((item) => {
		const hunk = item as { oldStart?: unknown; oldLines?: unknown; newStart?: unknown; newLines?: unknown; lines?: unknown };
		if (typeof hunk.oldStart !== 'number' || typeof hunk.newStart !== 'number' || !Array.isArray(hunk.lines)) return [];
		const lines = hunk.lines.filter((line): line is string => typeof line === 'string');
		return [{
			oldStart: hunk.oldStart,
			oldLines: typeof hunk.oldLines === 'number' ? hunk.oldLines : lines.filter((line) => !line.startsWith('+')).length,
			newStart: hunk.newStart,
			newLines: typeof hunk.newLines === 'number' ? hunk.newLines : lines.filter((line) => !line.startsWith('-')).length,
			lines,
		}];
	});
	return {
		path: typeof payload.path === 'string' ? payload.path : path,
		oldText: typeof payload.oldText === 'string' ? payload.oldText : null,
		newText: typeof payload.newText === 'string' ? payload.newText : null,
		hunks,
	};
}

/** AI 模型目录端点。 */
const AI_MODELS_PATH = '/dsh-dev-git-graph/gg/ai-models';
/** AI 提交生成端点。 */
const AI_COMMIT_PATH = '/dsh-dev-git-graph/gg/ai-commit';

/** AI 模型目录。 */
export interface AiModelCatalog {
	readonly providers: Array<{ id: string; name: string }>;
	readonly modelsByProvider: Record<string, string[]>;
	readonly fallback: { provider: string; model: string } | null;
}

/**
 * 取 AI 模型目录。
 *
 * @returns 供应商列表、每供应商的模型 id 与兜底模型。
 */
export async function fetchAiModels(): Promise<AiModelCatalog> {
	const res = await fetch(AI_MODELS_PATH, { method: 'GET' });
	if (!res.ok) throw new Error(`宿主返回 ${res.status}`);
	return await res.json() as AiModelCatalog;
}

/** 流式生成提交信息的回调。 */
export interface CommitMessageHandlers {
	readonly onChunk: (text: string) => void;
	readonly onWarning?: (text: string) => void;
	readonly onError?: (text: string) => void;
	readonly onStats?: (stats: unknown) => void;
	readonly signal?: AbortSignal;
}

/**
 * 流式生成 AI 提交信息。
 *
 * @param cwd - 仓库路径。
 * @param provider - 供应商 id（空串表示用当前会话模型）。
 * @param model - 模型 id。
 * @param rules - 自定义规则提示词。
 * @param handlers - 流式回调与取消信号。
 * @param amend - 是否修补上一次提交；为真时宿主把上一提交的改动一并纳入 diff。
 * @returns 无。
 */
export async function generateCommitMessage(
	cwd: string, provider: string, model: string, rules: string,
	handlers: CommitMessageHandlers, amend = false,
): Promise<void> {
	const res = await fetch(AI_COMMIT_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ repo: cwd, provider, model, rules, amend }),
		signal: handlers.signal,
	});
	if (!res.ok) {
		const json = await res.json().catch(() => ({})) as { error?: string };
		throw new Error(json.error || `宿主返回 ${res.status}`);
	}
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		let event = '';
		for (const line of lines) {
			if (line.startsWith('event: ')) { event = line.slice(7).trim(); }
			else if (line.startsWith('data: ') && event !== '') {
				const data = JSON.parse(line.slice(6));
				if (event === 'chunk') handlers.onChunk(data as string);
				else if (event === 'warning') handlers.onWarning?.(data as string);
				else if (event === 'error') handlers.onError?.(data as string);
				else if (event === 'stats') handlers.onStats?.(data);
				event = '';
			}
		}
	}
}
