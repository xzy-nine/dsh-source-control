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
 * @param {AbortSignal} [signal] - 取消信号；中止时 fetch 抛 AbortError。
 * @returns {Promise<object>} 宿主响应。
 */
export async function callApi(cwd, message, signal) {
	const response = await fetch(API_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ repo: cwd, ...message }),
		signal,
	});
	if (!response.ok) throw new Error(`宿主返回 ${response.status}`);
	const payload = await response.json();
	const { error } = payload;
	if (typeof error === 'string' && error !== '') throw new Error(error);
	return payload;
}

/**
 * 发现工作区根下的仓库及其工作树与子模块。
 *
 * @param {string} cwd - 工作区根路径。
 * @param {object} [options] - 发现选项。
 * @param {number} [options.maxDepth] - 仓库发现的最大递归层数。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<object>} { nodes, truncated }。
 */
export async function discoverRepositories(cwd, { maxDepth } = {}, signal) {
	const payload = await callApi(cwd, { command: 'discoverRepositories', maxDepth }, signal);
	return {
		nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
		truncated: payload.truncated === true,
	};
}

/**
 * 读取一个仓库相对其上游的领先/落后提交数。
 *
 * @param {string} cwd - 仓库路径。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<object>} { branch, upstream, ahead, behind }。
 */
export async function loadRepoSync(cwd, signal) {
	const payload = await callApi(cwd, { command: 'loadRepoSync' }, signal);
	return {
		branch: typeof payload.branch === 'string' ? payload.branch : null,
		upstream: typeof payload.upstream === 'string' ? payload.upstream : null,
		ahead: typeof payload.ahead === 'number' ? payload.ahead : 0,
		behind: typeof payload.behind === 'number' ? payload.behind : 0,
	};
}

/**
 * 读取提交图与仓库信息。
 *
 * `loadCommits` 需要仓库的远程列表与 stash 列表参与引用标注，因此先取仓库信息。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {object} options - 读取选项。
 * @param {number} [options.maxCommits] - 最多加载的提交数。
 * @param {string} [options.commitOrdering] - 排序方式：topo（拓扑，默认）/ date（提交时间）/ author-date（作者时间）。
 * @param {boolean} [options.showStashes] - 是否参与贮藏标注与图绘制。
 * @param {boolean} [options.showTags] - 是否参与标签标注。
 * @param {boolean} [options.showRemoteBranches] - 是否参与远程分支标注。
 * @param {boolean} [options.onlyFollowFirstParent] - 是否只跟随第一个父提交。
 * @param {boolean} [options.includeCommitsMentionedByReflogs] - 是否包含 reflog 提到的提交。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<object>} 提交、HEAD、当前分支、远程与是否还有更多提交。
 */
export async function loadGraph(cwd, {
	maxCommits = 200, commitOrdering = 'topo',
	showStashes = true, showTags = true, showRemoteBranches = true,
	onlyFollowFirstParent = false, includeCommitsMentionedByReflogs = false, signal,
} = {}) {
	const repoInfo = await callApi(cwd, {
		command: 'loadRepoInfo', showRemoteBranches, showStashes, hideRemotes: [],
	}, signal);
	const remotes = Array.isArray(repoInfo.remotes) ? repoInfo.remotes : [];
	const commitsPayload = await callApi(cwd, {
		command: 'loadCommits', branches: null, maxCommits, showTags, showRemoteBranches,
		includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering,
		remotes, hideRemotes: [], stashes: Array.isArray(repoInfo.stashes) ? repoInfo.stashes : [],
	}, signal);
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
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<object[]>} 变更列表。
 */
export async function loadWorkingTree(cwd, signal) {
	const payload = await callApi(cwd, { command: 'loadWorkingTree' }, signal);
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
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<object[]>} 改动文件列表。
 */
export async function loadCommitFiles(cwd, hash, signal) {
	const payload = await callApi(cwd, { command: 'commitDetails', commitHash: hash, hasParents: true, stash: null }, signal);
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
export async function fetchRepo(cwd, name, prune = false, pruneTags = false) {
	await callApi(cwd, { command: 'fetch', name, prune, pruneTags });
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

/**
 * 读取仓库配置（远程、issue 链接等）。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string[]} remotes - 远程名列表。
 * @returns {Promise<object>} 配置数据。
 */
export async function loadConfig(cwd, remotes) {
	const payload = await callApi(cwd, { command: 'loadConfig', remotes });
	return payload;
}

/**
 * 检出指定分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} branchName - 分支名。
 * @param {string|null} remoteBranch - 新建并跟踪的远程分支；本地已有时传 null。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function checkoutBranch(cwd, branchName, remoteBranch = null) {
	const payload = await callApi(cwd, { command: 'checkoutBranch', branchName, remoteBranch });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 从某提交创建分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} branchName - 新分支名。
 * @param {string} commitHash - 起点提交哈希。
 * @param {boolean} checkout - 创建后是否检出。
 * @param {boolean} force - 是否强制覆盖同名分支。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function createBranch(cwd, branchName, commitHash, checkout = true, force = false) {
	const payload = await callApi(cwd, { command: 'createBranch', branchName, commitHash, checkout, force });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 删除本地分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} branchName - 分支名。
 * @param {boolean} forceDelete - 是否强制删除未合并分支。
 * @param {string[]} deleteOnRemotes - 同时删除的远程分支名。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function deleteBranch(cwd, branchName, forceDelete = false, deleteOnRemotes = []) {
	const payload = await callApi(cwd, { command: 'deleteBranch', branchName, forceDelete, deleteOnRemotes });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 重命名分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} oldName - 原分支名。
 * @param {string} newName - 新分支名。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function renameBranch(cwd, oldName, newName) {
	const payload = await callApi(cwd, { command: 'renameBranch', oldName, newName });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 删除远程分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} branchName - 远程分支短名（含远程前缀由 remote 拼接）。
 * @param {string} remote - 远程名。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function deleteRemoteBranch(cwd, branchName, remote) {
	const payload = await callApi(cwd, { command: 'deleteRemoteBranch', branchName, remote });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把远程分支取到同名本地分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} remote - 远程名。
 * @param {string} remoteBranch - 远程分支名。
 * @param {string} localBranch - 本地分支名。
 * @param {boolean} force - 是否强制覆盖本地分支。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function fetchIntoLocalBranch(cwd, remote, remoteBranch, localBranch, force = false) {
	const payload = await callApi(cwd, { command: 'fetchIntoLocalBranch', remote, remoteBranch, localBranch, force });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把远程分支拉入当前分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} branchName - 远程分支名。
 * @param {string} remote - 远程名。
 * @param {boolean} createNewCommit - 是否生成合并提交。
 * @param {boolean} squash - 是否压缩合并。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function pullBranch(cwd, branchName, remote, createNewCommit = false, squash = false) {
	const payload = await callApi(cwd, { command: 'pullBranch', branchName, remote, createNewCommit, squash });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 检出指定提交（分离 HEAD）。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} commitHash - 提交哈希。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function checkoutCommit(cwd, commitHash) {
	const payload = await callApi(cwd, { command: 'checkoutCommit', commitHash });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把提交拣选到当前分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} commitHash - 提交哈希。
 * @param {number} parentIndex - 合并提交要拣选的父提交序号；非合并提交传 -1。
 * @param {boolean} recordOrigin - 是否在提交信息记录来源。
 * @param {boolean} noCommit - 是否只应用改动不提交。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function cherrypickCommit(cwd, commitHash, parentIndex = -1, recordOrigin = false, noCommit = false) {
	const payload = await callApi(cwd, { command: 'cherrypickCommit', commitHash, parentIndex, recordOrigin, noCommit });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 把当前分支重置到指定提交。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} commitHash - 目标提交哈希。
 * @param {('soft'|'mixed'|'hard')} resetMode - 重置模式。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function resetToCommit(cwd, commitHash, resetMode = 'mixed') {
	const payload = await callApi(cwd, { command: 'resetToCommit', commit: commitHash, resetMode });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 在指定提交上生成还原提交。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} commitHash - 要还原的提交哈希。
 * @param {number} parentIndex - 合并提交要还原的父提交序号；非合并提交传 -1。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function revertCommit(cwd, commitHash, parentIndex = -1) {
	const payload = await callApi(cwd, { command: 'revertCommit', commitHash, parentIndex });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把目标合并进当前分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} obj - 目标分支名或提交哈希。
 * @param {boolean} createNewCommit - 是否生成合并提交。
 * @param {boolean} squash - 是否压缩合并。
 * @param {boolean} noCommit - 是否只应用改动不提交。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function merge(cwd, obj, createNewCommit = false, squash = false, noCommit = false) {
	const payload = await callApi(cwd, { command: 'merge', obj, actionOn: 'Branch', createNewCommit, squash, noCommit });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 把当前分支变基到目标。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} obj - 目标分支名或提交哈希。
 * @param {boolean} ignoreDate - 是否保留原提交时间。
 * @param {boolean} interactive - 是否交互式变基。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function rebase(cwd, obj, ignoreDate = true, interactive = false) {
	const payload = await callApi(cwd, { command: 'rebase', obj, actionOn: 'Branch', ignoreDate, interactive });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 在当前分支添加标签。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} tagName - 标签名。
 * @param {string} commitHash - 目标提交哈希。
 * @param {number} type - 标签类型：0 轻量、1 附注。
 * @param {string} message - 附注标签信息。
 * @param {boolean} force - 是否强制覆盖同名标签。
 * @param {string|null} pushToRemote - 创建后推送到的远程名；不推送传 null。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function addTag(cwd, tagName, commitHash, type = 0, message = '', force = false, pushToRemote = null) {
	const payload = await callApi(cwd, { command: 'addTag', tagName, commitHash, type, message, force, pushToRemote });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 删除标签。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} tagName - 标签名。
 * @param {string|null} deleteOnRemote - 同时删除的远程名；不删远程传 null。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function deleteTag(cwd, tagName, deleteOnRemote = null) {
	const payload = await callApi(cwd, { command: 'deleteTag', tagName, deleteOnRemote });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 推送标签到远程。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} tagName - 标签名。
 * @param {string[]} remotes - 目标远程名列表。
 * @param {string} commitHash - 标签指向的提交哈希。
 * @param {boolean} skipRemoteCheck - 是否跳过远程存在性检查。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function pushTag(cwd, tagName, remotes, commitHash, skipRemoteCheck = false) {
	const payload = await callApi(cwd, { command: 'pushTag', tagName, remotes, commitHash, skipRemoteCheck });
	const errors = Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : [];
	return errors.length > 0 ? errors[0] : null;
}

/**
 * 删除远程。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} name - 远程名。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function deleteRemote(cwd, name) {
	const payload = await callApi(cwd, { command: 'deleteRemote', name });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 编辑 git 用户身份（user.name 与 user.email）。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} name - 用户名。
 * @param {string} email - 邮箱。
 * @param {'global'|'local'} location - 写入位置。
 * @param {boolean} deleteLocalName - 是否同时删除本地 user.name 覆盖。
 * @param {boolean} deleteLocalEmail - 是否同时删除本地 user.email 覆盖。
 * @returns {Promise<string[]>} 错误列表，无错误时为空数组。
 */
export async function editUserDetails(cwd, name, email, location, deleteLocalName, deleteLocalEmail) {
	const payload = await callApi(cwd, { command: 'editUserDetails', name, email, location, deleteLocalName, deleteLocalEmail });
	return Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : [];
}

/**
 * 删除 git 用户身份。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {boolean} name - 是否删除 user.name。
 * @param {boolean} email - 是否删除 user.email。
 * @param {'global'|'local'} location - 删除位置。
 * @returns {Promise<string[]>} 错误列表，无错误时为空数组。
 */
export async function deleteUserDetails(cwd, name, email, location) {
	const payload = await callApi(cwd, { command: 'deleteUserDetails', name, email, location });
	return Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string') : [];
}

/**
 * 应用贮藏。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} selector - 贮藏选择器（如 stash@{0}）。
 * @param {boolean} reinstateIndex - 是否恢复暂存区。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function applyStash(cwd, selector, reinstateIndex = false) {
	const payload = await callApi(cwd, { command: 'applyStash', selector, reinstateIndex });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 从贮藏创建分支。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} selector - 贮藏选择器。
 * @param {string} branchName - 新分支名。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function branchFromStash(cwd, selector, branchName) {
	const payload = await callApi(cwd, { command: 'branchFromStash', selector, branchName });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 丢弃贮藏。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} selector - 贮藏选择器。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function dropStash(cwd, selector) {
	const payload = await callApi(cwd, { command: 'dropStash', selector });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 弹出贮藏。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} selector - 贮藏选择器。
 * @param {boolean} reinstateIndex - 是否恢复暂存区。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function popStash(cwd, selector, reinstateIndex = false) {
	const payload = await callApi(cwd, { command: 'popStash', selector, reinstateIndex });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 新建贮藏。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} message - 贮藏说明。
 * @param {boolean} includeUntracked - 是否一并贮藏未跟踪文件。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function pushStash(cwd, message, includeUntracked = true) {
	const payload = await callApi(cwd, { command: 'pushStash', message, includeUntracked });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 清理未跟踪文件。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {boolean} directories - 是否连未跟踪目录一并删除。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function cleanUntrackedFiles(cwd, directories = false) {
	const payload = await callApi(cwd, { command: 'cleanUntrackedFiles', directories });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 读取附注标签详情（消息、打标签者、日期）。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} tagName - 标签名。
 * @param {string} commitHash - 标签指向的提交哈希。
 * @returns {Promise<object|null>} 标签详情，轻量标签返回 null。
 */
export async function tagDetails(cwd, tagName, commitHash) {
	const payload = await callApi(cwd, { command: 'tagDetails', tagName, commitHash });
	return payload.tagDetails ?? null;
}

/**
 * 添加远程仓库。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} name - 远程名。
 * @param {string} url - 抓取 URL。
 * @param {string|null} pushUrl - 推送 URL；与抓取 URL 相同时传 null。
 * @param {boolean} fetch - 添加后是否立即抓取。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function addRemote(cwd, name, url, pushUrl = null, fetch = false) {
	const payload = await callApi(cwd, { command: 'addRemote', name, url, pushUrl, fetch });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 编辑远程仓库（名称、URL、推送 URL）。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} nameOld - 原远程名。
 * @param {string} nameNew - 新远程名。
 * @param {string|null} urlOld - 原 URL。
 * @param {string|null} urlNew - 新 URL。
 * @param {string|null} pushUrlOld - 原推送 URL。
 * @param {string|null} pushUrlNew - 新推送 URL。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function editRemote(cwd, nameOld, nameNew, urlOld, urlNew, pushUrlOld, pushUrlNew) {
	const payload = await callApi(cwd, { command: 'editRemote', nameOld, nameNew, urlOld, urlNew, pushUrlOld, pushUrlNew });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 创建归档（zip/tar/tar.gz）。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} ref - 归档起点（分支名、标签名或提交哈希）。
 * @param {string} format - 归档格式：'zip'、'tar' 或 'tgz'。
 * @param {string} outputPath - 归档输出路径（绝对路径）。
 * @returns {Promise<string|null>} 错误文本，无错误时返回 null。
 */
export async function createArchive(cwd, ref, format, outputPath) {
	const payload = await callApi(cwd, { command: 'createArchive', ref, format, outputPath });
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 导出仓库配置为 JSON。
 *
 * @param {string} cwd - 会话工作区路径。
 * @returns {Promise<object>} 仓库配置对象。
 */
export async function exportRepoConfig(cwd) {
	const payload = await callApi(cwd, { command: 'exportRepoConfig' });
	return payload.config ?? null;
}

/**
 * 取某个提交中某文件的前后内容，供 DiffBlock 渲染。
 *
 * @param {string} cwd - 会话工作区路径。
 * @param {string} hash - 提交哈希；'*' 表示工作区。
 * @param {string} path - 文件路径（相对仓库根）。
 * @param {boolean} staged - 工作区时是否取暂存区内容。
 * @returns {Promise<{path: string, oldText: string|null, newText: string|null}>}
 */
export async function fileDiffContent(cwd, hash, path, staged = false) {
	return callApi(cwd, { command: 'fileDiffContent', commitHash: hash, filePath: path, staged });
}

/** AI 模型目录端点。 */
const AI_MODELS_PATH = '/dsh-dev-git-graph/gg/ai-models';
/** AI 提交生成端点。 */
const AI_COMMIT_PATH = '/dsh-dev-git-graph/gg/ai-commit';

/**
 * 取 AI 模型目录。
 * @returns {Promise<{providers: Array<{id, name}>, modelsByProvider: Record<string, string[]>, fallback: {provider, model}|null}>}
 */
export async function fetchAiModels() {
	const res = await fetch(AI_MODELS_PATH, { method: 'GET' });
	if (!res.ok) throw new Error(`宿主返回 ${res.status}`);
	return res.json();
}

/**
 * 流式生成 AI 提交信息。
 * @param {string} cwd - 仓库路径。
 * @param {string} provider - 供应商 id（空串表示用当前会话模型）。
 * @param {string} model - 模型 id。
 * @param {{onChunk: (text: string) => void, onWarning?: (text: string) => void, onError?: (text: string) => void, signal?: AbortSignal}} handlers
 */
export async function generateCommitMessage(cwd, provider, model, handlers) {
	const res = await fetch(AI_COMMIT_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ repo: cwd, provider, model }),
		signal: handlers.signal,
	});
	if (!res.ok) {
		const json = await res.json().catch(() => ({}));
		throw new Error(json.error || `宿主返回 ${res.status}`);
	}
	const reader = res.body.getReader();
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
				if (event === 'chunk') handlers.onChunk(data);
				else if (event === 'warning') handlers.onWarning?.(data);
				else if (event === 'error') handlers.onError?.(data);
				event = '';
			}
		}
	}
}
