/**
 * 宿主 API 客户端：把命令发到 POST /dsh-dev-git-graph/gg/api。
 *
 * 该路由沿用移植版的命令集（loadCommits / loadRepoInfo 等），并新增工作区变更命令。
 * 所有调用都以 JSON 往返，失败以抛出携带 error 文本的 Error 表示。
 */

/** API 路由，与宿主注册的路径一致。 */
const API_PATH = '/dsh-dev-git-graph/gg/api';

/**
 * 调用一条宿主命令。
 *
 * @param {string} cwd - 会话工作区路径，作为 repo 传给宿主。
 * @param {object} message - 命令载荷，`command` 由调用方给出。
 * @returns {Promise<object>} 宿主响应。
 */
export async function callApi(cwd, message) {
	const response = await fetch(API_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ repo: cwd, ...message }),
	});
	if (!response.ok) throw new Error(`宿主返回 ${response.status}`);
	const payload = await response.json();
	const { error } = payload;
	if (typeof error === 'string' && error !== '') throw new Error(error);
	return payload;
}

/**
 * 读取提交图与仓库信息。
 *
 * `loadCommits` 需要仓库的远程列表与 stash 列表参与引用标注，因此先取仓库信息。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {number} maxCommits - 最多加载的提交数。
 * @returns {Promise<object>} 提交、HEAD、当前分支、远程与是否还有更多提交。
 */
export async function loadGraph(cwd, maxCommits = 200) {
	const repoInfo = await callApi(cwd, {
		command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [],
	});
	const remotes = Array.isArray(repoInfo.remotes) ? repoInfo.remotes : [];
	const commitsPayload = await callApi(cwd, {
		command: 'loadCommits', branches: null, maxCommits, showTags: true, showRemoteBranches: true,
		includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'date',
		remotes, hideRemotes: [], stashes: Array.isArray(repoInfo.stashes) ? repoInfo.stashes : [],
	});
	const head = typeof repoInfo.head === 'string' && repoInfo.head !== 'HEAD' ? repoInfo.head : null;
	return {
		commits: Array.isArray(commitsPayload.commits) ? commitsPayload.commits : [],
		head,
		remotes,
		moreCommitsAvailable: commitsPayload.moreCommitsAvailable === true,
	};
}

/**
 * 读取工作区变更。
 *
 * @param {string} cwd - 会话工作区路径。
 * @returns {Promise<object[]>} 变更列表。
 */
export async function loadWorkingTree(cwd) {
	const payload = await callApi(cwd, { command: 'loadWorkingTree' });
	return Array.isArray(payload.entries) ? payload.entries : [];
}

/**
 * 暂存路径。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string[]} paths - 要暂存的路径；空数组表示全部。
 * @returns {Promise<void>} 无。
 */
export async function stagePaths(cwd, paths) {
	await callApi(cwd, { command: 'stagePaths', paths });
}

/**
 * 取消暂存路径。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string[]} paths - 要取消暂存的路径；空数组表示全部。
 * @returns {Promise<void>} 无。
 */
export async function unstagePaths(cwd, paths) {
	await callApi(cwd, { command: 'unstagePaths', paths });
}

/**
 * 丢弃路径上的改动。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string[]} paths - 要丢弃的路径。
 * @param {boolean} untracked - 这些路径是否都是未跟踪文件。
 * @returns {Promise<void>} 无。
 */
export async function discardPaths(cwd, paths, untracked) {
	await callApi(cwd, { command: 'discardPaths', paths, untracked });
}

/**
 * 提交暂存区内容。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} message - 提交信息。
 * @param {boolean} amend - 是否修补上一次提交。
 * @returns {Promise<string>} 新提交哈希。
 */
export async function commitStaged(cwd, message, amend = false) {
	const payload = await callApi(cwd, { command: 'commitStaged', message, amend });
	return typeof payload.hash === 'string' ? payload.hash : '';
}

/**
 * 读取某个提交的改动文件。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} hash - 提交哈希，`*` 表示工作区未提交变更。
 * @returns {Promise<object[]>} 改动文件列表。
 */
export async function loadCommitFiles(cwd, hash) {
	const payload = await callApi(cwd, { command: 'commitDetails', commitHash: hash, hasParents: true, stash: null });
	const details = payload.commitDetails;
	const changes = details !== null && typeof details === 'object' && Array.isArray(details.fileChanges) ? details.fileChanges : [];
	return changes.map((change) => ({
		path: change.newFilePath,
		type: change.type,
		additions: change.additions,
		deletions: change.deletions,
	}));
}

/**
 * 抓取远端引用。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string|null} name - 远程名；null 表示全部远程。
 * @returns {Promise<void>} 无。
 */
export async function fetchRepo(cwd, name) {
	await callApi(cwd, { command: 'fetch', name, prune: false, pruneTags: false });
}

/**
 * 推送分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} branchName - 要推送的分支名。
 * @param {string[]} remotes - 目标远程仓库；空数组表示不推送。
 * @returns {Promise<string[]>} 每条远程的结果错误，无错误时为空数组。
 */
export async function pushBranch(cwd, branchName, remotes) {
	const payload = await callApi(cwd, { command: 'pushBranch', branchName, remotes, setUpstream: true, mode: '' });
	return Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : [];
}
