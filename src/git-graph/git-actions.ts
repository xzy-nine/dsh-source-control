/**
 * DSH 版 Git Graph 的 git 操作层：分支、标签、远程、贮藏、合并、变基与配置等写操作。
 *
 * 每个导出函数以数组参数跑一次或多次 git，返回 `ErrorInfo`：成功为 null，失败为 git 的
 * stderr 文本。多步操作按顺序执行，任一步失败即返回该步错误，后续步骤不再执行。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import type { ConfigLocation, ErrorInfo, PushMode, ResetMode } from './git-types.js';
import type { GitResult } from './working-tree.js';
import { runGit } from './working-tree.js';

/**
 * 去掉文本末尾的换行符。
 *
 * @param text - 待处理文本。
 * @returns 去掉末尾换行后的文本。
 */
function stripTrailingNewlines(text: string): string {
	return text.replace(/[\r\n]+$/, '');
}

/**
 * 跑一次 git，并把非零退出码转成错误文本。
 *
 * @param args - 参数数组，按原样传给 git。
 * @param cwd - 工作目录，必须是仓库或其子目录。
 * @returns 成功为 null；失败为 stderr 文本（去掉末尾换行），stderr 为空时退回 stdout，两者皆空时返回通用失败文本。
 */
async function gitErrorInfo(args: readonly string[], cwd: string): Promise<ErrorInfo> {
	let result: GitResult;
	try {
		result = await runGit(args, cwd);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (result.code === 0) return null;
	const stderr = stripTrailingNewlines(result.stderr);
	if (stderr !== '') return stderr;
	const stdout = stripTrailingNewlines(result.stdout);
	return stdout !== '' ? stdout : `git ${args[0] ?? ''} 执行失败`;
}

/**
 * 列出包含指定提交的远程仓库。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 提交哈希。
 * @param knownRemotes - 待判定的远程名。
 * @returns 至少有一个远程分支包含该提交的远程名；命令失败时返回 `knownRemotes`。
 */
async function remotesContainingCommit(repo: string, commitHash: string, knownRemotes: readonly string[]): Promise<readonly string[]> {
	const result = await runGit(['branch', '-r', '--contains=' + commitHash], repo).catch(() => null);
	if (result === null || result.code !== 0) return knownRemotes;
	const branchNames = result.stdout.split(/\r?\n/)
		.filter((line) => line.length > 2)
		.map((line) => line.substring(2).split(' -> ')[0]);
	return knownRemotes.filter((remote) => branchNames.some((branchName) => branchName.startsWith(remote + '/')));
}

/**
 * 暂存区有改动时提交压缩合并的结果。
 *
 * `git diff --cached --quiet` 以退出码 0 表示无暂存改动、1 表示有改动。
 *
 * @param repo - 仓库路径。
 * @param obj - 被合并进当前分支的对象。
 * @param actionOn - 合并对象类型，小写后写入提交信息。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
async function commitSquashIfStagedChangesExist(repo: string, obj: string, actionOn: string): Promise<ErrorInfo> {
	let code: number;
	try {
		code = (await runGit(['diff', '--cached', '--quiet'], repo)).code;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (code !== 1) return null;
	return gitErrorInfo(['commit', '-m', `Merge ${actionOn.toLowerCase()} '${obj}'`], repo);
}

/**
 * 添加一个远程仓库。
 *
 * @param repo - 仓库路径。
 * @param name - 远程名。
 * @param url - 抓取 URL。
 * @param pushUrl - 推送 URL；null 表示与抓取 URL 相同。
 * @param fetch - 添加后是否立即抓取该远程。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export async function addRemote(repo: string, name: string, url: string, pushUrl: string | null, fetch: boolean): Promise<ErrorInfo> {
	const addError = await gitErrorInfo(['remote', 'add', name, url], repo);
	if (addError !== null) return addError;

	if (pushUrl !== null) {
		const pushUrlError = await gitErrorInfo(['remote', 'set-url', name, '--push', pushUrl], repo);
		if (pushUrlError !== null) return pushUrlError;
	}

	return fetch ? fetchRemote(repo, name, false, false) : null;
}

/**
 * 删除一个远程仓库。
 *
 * @param repo - 仓库路径。
 * @param name - 远程名。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function deleteRemote(repo: string, name: string): Promise<ErrorInfo> {
	return gitErrorInfo(['remote', 'remove', name], repo);
}

/**
 * 编辑一个远程仓库的名称、抓取 URL 与推送 URL。
 *
 * 名称变化时先改名，其后各步以新名称寻址；URL 只在旧值不等于新值时下发。
 *
 * @param repo - 仓库路径。
 * @param nameOld - 原远程名。
 * @param nameNew - 新远程名。
 * @param urlOld - 原抓取 URL；null 表示原先未单独配置。
 * @param urlNew - 新抓取 URL；null 表示删除该配置。
 * @param pushUrlOld - 原推送 URL；null 表示原先未单独配置。
 * @param pushUrlNew - 新推送 URL；null 表示删除该配置。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export async function editRemote(repo: string, nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null): Promise<ErrorInfo> {
	if (nameOld !== nameNew) {
		const renameError = await gitErrorInfo(['remote', 'rename', nameOld, nameNew], repo);
		if (renameError !== null) return renameError;
	}

	if (urlOld !== urlNew) {
		const args = ['remote', 'set-url', nameNew];
		if (urlNew === null) args.push('--delete', urlOld as string);
		else if (urlOld === null) args.push('--add', urlNew);
		else args.push(urlNew, urlOld);

		const urlError = await gitErrorInfo(args, repo);
		if (urlError !== null) return urlError;
	}

	if (pushUrlOld !== pushUrlNew) {
		const args = ['remote', 'set-url', '--push', nameNew];
		if (pushUrlNew === null) args.push('--delete', pushUrlOld as string);
		else if (pushUrlOld === null) args.push('--add', pushUrlNew);
		else args.push(pushUrlNew, pushUrlOld);

		const pushUrlError = await gitErrorInfo(args, repo);
		if (pushUrlError !== null) return pushUrlError;
	}

	return null;
}

/**
 * 清理一个远程仓库中已删除的远程分支引用。
 *
 * @param repo - 仓库路径。
 * @param name - 远程名。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function pruneRemote(repo: string, name: string): Promise<ErrorInfo> {
	return gitErrorInfo(['remote', 'prune', name], repo);
}

/**
 * 在指定提交上添加标签。
 *
 * @param repo - 仓库路径。
 * @param tagName - 标签名。
 * @param commitHash - 标签指向的提交哈希。
 * @param type - 标签类型；0 为轻量标签，其余为附注标签。
 * @param message - 附注标签的信息。
 * @param force - 是否覆盖同名标签。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function addTag(repo: string, tagName: string, commitHash: string, type: number, message: string, force: boolean): Promise<ErrorInfo> {
	const args = ['tag'];
	if (force) args.push('-f');
	if (type === 0) args.push(tagName);
	else args.push('-a', tagName, '-m', message);
	args.push(commitHash);
	return gitErrorInfo(args, repo);
}

/**
 * 删除标签，可同时删除远程上的同名标签。
 *
 * @param repo - 仓库路径。
 * @param tagName - 标签名。
 * @param deleteOnRemote - 同时删除标签的远程名；null 表示只删本地。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export async function deleteTag(repo: string, tagName: string, deleteOnRemote: string | null): Promise<ErrorInfo> {
	if (deleteOnRemote !== null) {
		const remoteError = await gitErrorInfo(['push', deleteOnRemote, '--delete', tagName], repo);
		if (remoteError !== null) return remoteError;
	}
	return gitErrorInfo(['tag', '-d', tagName], repo);
}

/**
 * 抓取实现；`addRemote` 的同名布尔参数会遮蔽导出的 `fetch`，故单独实现。
 *
 * @param repo - 仓库路径。
 * @param remote - 要抓取的远程名；null 表示全部远程。
 * @param prune - 是否清理已删除的远程分支。
 * @param pruneTags - 是否清理已删除的远程标签；为真时要求 `prune` 也为真。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
async function fetchRemote(repo: string, remote: string | null, prune: boolean, pruneTags: boolean): Promise<ErrorInfo> {
	if (pruneTags && !prune) {
		return '要清理标签，从' + (remote !== null ? '某个远程仓库' : '远程仓库') + '抓取时也必须同时启用清理。';
	}

	const args = ['fetch', remote === null ? '--all' : remote];
	if (prune) args.push('--prune');
	if (pruneTags) args.push('--prune-tags');
	return gitErrorInfo(args, repo);
}

/**
 * 抓取远程仓库。
 *
 * @param repo - 仓库路径。
 * @param remote - 要抓取的远程名；null 表示全部远程。
 * @param prune - 是否清理已删除的远程分支。
 * @param pruneTags - 是否清理已删除的远程标签；为真时要求 `prune` 也为真。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function fetch(repo: string, remote: string | null, prune: boolean, pruneTags: boolean): Promise<ErrorInfo> {
	return fetchRemote(repo, remote, prune, pruneTags);
}

/**
 * 把分支推送到一个远程仓库。
 *
 * @param repo - 仓库路径。
 * @param branchName - 分支名。
 * @param remote - 目标远程名。
 * @param setUpstream - 是否设置上游分支。
 * @param mode - 推送模式；空串表示普通推送。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function pushBranch(repo: string, branchName: string, remote: string, setUpstream: boolean, mode: PushMode): Promise<ErrorInfo> {
	const args = ['push', remote, branchName];
	if (setUpstream) args.push('--set-upstream');
	if (mode !== '') args.push('--' + mode);
	return gitErrorInfo(args, repo);
}

/**
 * 把当前分支推送到其上游。
 *
 * 不带参数执行 `git push`：由 git 按 `push.default` 与分支的上游配置决定目标，
 * 因此无需调用方指定远程。当前分支没有上游时 git 会给出提示性错误。
 *
 * @param repo - 仓库路径。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function pushUpstream(repo: string): Promise<ErrorInfo> {
	return gitErrorInfo(['push'], repo);
}

/**
 * 把分支依次推送到多个远程仓库。
 *
 * @param repo - 仓库路径。
 * @param branchName - 分支名。
 * @param remotes - 目标远程名列表。
 * @param setUpstream - 是否设置上游分支。
 * @param mode - 推送模式；空串表示普通推送。
 * @returns 各远程的结果错误；无错误时为空数组，遇到首个错误后不再继续推送。
 */
export async function pushBranchToMultipleRemotes(repo: string, branchName: string, remotes: readonly string[], setUpstream: boolean, mode: PushMode): Promise<ErrorInfo[]> {
	if (remotes.length === 0) {
		return ['未指定要把分支 ' + branchName + ' 推送到哪个远程仓库。'];
	}

	const results: ErrorInfo[] = [];
	for (const remote of remotes) {
		const result = await pushBranch(repo, branchName, remote, setUpstream, mode);
		results.push(result);
		if (result !== null) break;
	}
	return results;
}

/**
 * 把标签推送到多个远程仓库。
 *
 * 未跳过远程检查时，先用 `git branch -r --contains` 判定各远程是否已包含标签所在提交；
 * 有远程未包含时返回 `VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:` 前缀加缺失远程名数组。
 *
 * @param repo - 仓库路径。
 * @param tagName - 标签名。
 * @param remotes - 目标远程名列表。
 * @param commitHash - 标签指向的提交哈希。
 * @param skipRemoteCheck - 是否跳过远程存在性检查。
 * @returns 各远程的结果错误；无错误时为空数组，遇到首个错误后不再继续推送。
 */
export async function pushTag(repo: string, tagName: string, remotes: readonly string[], commitHash: string, skipRemoteCheck: boolean): Promise<ErrorInfo[]> {
	if (remotes.length === 0) {
		return ['未指定要把标签 ' + tagName + ' 推送到哪个远程仓库。'];
	}

	if (!skipRemoteCheck) {
		const containing = await remotesContainingCommit(repo, commitHash, remotes);
		const missing = remotes.filter((remote) => !containing.includes(remote));
		if (missing.length > 0) {
			return ['VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:' + JSON.stringify(missing)];
		}
	}

	const results: ErrorInfo[] = [];
	for (const remote of remotes) {
		const result = await gitErrorInfo(['push', remote, tagName], repo);
		results.push(result);
		if (result !== null) break;
	}
	return results;
}

/**
 * 检出分支；本地尚无该分支时可基于远程分支新建。
 *
 * @param repo - 仓库路径。
 * @param branchName - 要检出的分支名。
 * @param remoteBranch - 新建分支所基于的远程分支；null 表示直接检出已有本地分支。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function checkoutBranch(repo: string, branchName: string, remoteBranch: string | null): Promise<ErrorInfo> {
	const args = ['checkout'];
	if (remoteBranch === null) args.push(branchName);
	else args.push('-b', branchName, remoteBranch);
	return gitErrorInfo(args, repo);
}

/**
 * 在指定提交上创建分支，可同时检出。
 *
 * `checkout` 与 `force` 同时为真时先强制重建分支再检出，检出失败会追加到结果列表。
 *
 * @param repo - 仓库路径。
 * @param branchName - 新分支名。
 * @param commitHash - 分支指向的提交哈希。
 * @param checkout - 创建后是否检出。
 * @param force - 是否覆盖同名分支。
 * @returns 各步的结果错误；无错误时为空数组。
 */
export async function createBranch(repo: string, branchName: string, commitHash: string, checkout: boolean, force: boolean): Promise<ErrorInfo[]> {
	const args = checkout && !force ? ['checkout', '-b'] : force ? ['branch', '-f'] : ['branch'];
	args.push(branchName, commitHash);

	const results: ErrorInfo[] = [await gitErrorInfo(args, repo)];
	if (results[0] === null && checkout && force) {
		results.push(await checkoutBranch(repo, branchName, null));
	}
	return results;
}

/**
 * 删除本地分支。
 *
 * @param repo - 仓库路径。
 * @param branchName - 分支名。
 * @param force - 是否强制删除未合并的分支。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function deleteBranch(repo: string, branchName: string, force: boolean): Promise<ErrorInfo> {
	return gitErrorInfo(['branch', force ? '-D' : '-d', branchName], repo);
}

/**
 * 删除远程分支。
 *
 * 远程上已不存在该分支时，改删本地远程跟踪分支，并在错误文本中说明该情形。
 *
 * @param repo - 仓库路径。
 * @param branchName - 分支名。
 * @param remote - 远程名。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export async function deleteRemoteBranch(repo: string, branchName: string, remote: string): Promise<ErrorInfo> {
	const remoteError = await gitErrorInfo(['push', remote, '--delete', branchName], repo);
	if (remoteError !== null && /remote ref does not exist/i.test(remoteError)) {
		const trackingBranch = remote + '/' + branchName;
		const trackingError = await gitErrorInfo(['branch', '-d', '-r', trackingBranch], repo);
		return trackingError === null ? null : '远程仓库上不存在该分支，正在删除远程跟踪分支 ' + trackingBranch + '。\n' + trackingError;
	}
	return remoteError;
}

/**
 * 把远程分支取到本地分支。
 *
 * @param repo - 仓库路径。
 * @param remote - 远程名。
 * @param remoteBranch - 远程分支名。
 * @param localBranch - 本地分支名。
 * @param force - 是否强制覆盖本地分支。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function fetchIntoLocalBranch(repo: string, remote: string, remoteBranch: string, localBranch: string, force: boolean): Promise<ErrorInfo> {
	const args = ['fetch'];
	if (force) args.push('-f');
	args.push(remote, remoteBranch + ':' + localBranch);
	return gitErrorInfo(args, repo);
}

/**
 * 把远程分支拉取进当前分支。
 *
 * `squash` 与 `createNewCommit` 只在需要合并时生效；压缩合并后若暂存区有改动则自动提交。
 *
 * @param repo - 仓库路径。
 * @param branchName - 远程分支名。
 * @param remote - 远程名。
 * @param createNewCommit - 合并时是否使用 `--no-ff`。
 * @param squash - 合并时是否使用 `--squash`。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export async function pullBranch(repo: string, branchName: string, remote: string, createNewCommit: boolean, squash: boolean): Promise<ErrorInfo> {
	const args = ['pull', remote, branchName];
	if (squash) args.push('--squash');
	else if (createNewCommit) args.push('--no-ff');

	const pullError = await gitErrorInfo(args, repo);
	if (pullError !== null) return pullError;
	return squash ? commitSquashIfStagedChangesExist(repo, remote + '/' + branchName, 'Branch') : null;
}

/**
 * 重命名本地分支。
 *
 * @param repo - 仓库路径。
 * @param oldName - 原分支名。
 * @param newName - 新分支名。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function renameBranch(repo: string, oldName: string, newName: string): Promise<ErrorInfo> {
	return gitErrorInfo(['branch', '-m', oldName, newName], repo);
}

/**
 * 把分支或提交合并进当前分支。
 *
 * `squash` 与 `createNewCommit` 互斥，前者优先；压缩合并且未指定 `noCommit` 时若暂存区有改动则自动提交。
 *
 * @param repo - 仓库路径。
 * @param obj - 被合并的对象。
 * @param actionOn - 合并对象类型，用于自动提交的信息。
 * @param createNewCommit - 是否使用 `--no-ff`。
 * @param squash - 是否使用 `--squash`。
 * @param noCommit - 是否使用 `--no-commit`。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export async function merge(repo: string, obj: string, actionOn: string, createNewCommit: boolean, squash: boolean, noCommit: boolean): Promise<ErrorInfo> {
	const args = ['merge', obj];
	if (squash) args.push('--squash');
	else if (createNewCommit) args.push('--no-ff');
	if (noCommit) args.push('--no-commit');

	const mergeError = await gitErrorInfo(args, repo);
	if (mergeError !== null) return mergeError;
	return squash && !noCommit ? commitSquashIfStagedChangesExist(repo, obj, actionOn) : null;
}

/**
 * 把当前分支变基到分支或提交。
 *
 * 交互式变基需要终端，本实现直接返回不支持。
 *
 * @param repo - 仓库路径。
 * @param obj - 变基的目标对象。
 * @param actionOn - 变基对象类型。
 * @param ignoreDate - 是否使用 `--ignore-date`。
 * @param interactive - 是否交互式变基。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export async function rebase(repo: string, obj: string, actionOn: string, ignoreDate: boolean, interactive: boolean): Promise<ErrorInfo> {
	if (interactive) return 'DSH 版本不支持交互式变基';

	const args = ['rebase', obj];
	if (ignoreDate) args.push('--ignore-date');
	return gitErrorInfo(args, repo);
}

/**
 * 把指定修订导出为归档文件。
 *
 * @param repo - 仓库路径。
 * @param ref - 要归档的修订。
 * @param outputFilePath - 归档文件的输出路径。
 * @param type - 归档格式。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function archive(repo: string, ref: string, outputFilePath: string, type: 'tar' | 'zip'): Promise<ErrorInfo> {
	return gitErrorInfo(['archive', '--format=' + type, '-o', outputFilePath, ref], repo);
}

/**
 * 检出指定提交，进入分离头指针状态。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 提交哈希。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function checkoutCommit(repo: string, commitHash: string): Promise<ErrorInfo> {
	return gitErrorInfo(['checkout', commitHash], repo);
}

/**
 * 把指定提交拣选到当前分支。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 提交哈希。
 * @param parentIndex - 合并提交要沿用的父提交序号；非合并提交传不大于 0 的值。
 * @param recordOrigin - 是否使用 `-x` 记录来源提交。
 * @param noCommit - 是否使用 `--no-commit` 只应用改动。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function cherrypickCommit(repo: string, commitHash: string, parentIndex: number, recordOrigin: boolean, noCommit: boolean): Promise<ErrorInfo> {
	const args = ['cherry-pick'];
	if (noCommit) args.push('--no-commit');
	if (recordOrigin) args.push('-x');
	if (parentIndex > 0) args.push('-m', parentIndex.toString());
	args.push(commitHash);
	return gitErrorInfo(args, repo);
}

/**
 * 从当前分支丢弃指定提交。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 要丢弃的提交哈希。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function dropCommit(repo: string, commitHash: string): Promise<ErrorInfo> {
	return gitErrorInfo(['rebase', '--onto', commitHash + '^', commitHash], repo);
}

/**
 * 把当前分支重置到指定提交。
 *
 * @param repo - 仓库路径。
 * @param commit - 目标提交。
 * @param resetMode - 重置模式。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function resetToCommit(repo: string, commit: string, resetMode: ResetMode): Promise<ErrorInfo> {
	return gitErrorInfo(['reset', '--' + resetMode, commit], repo);
}

/**
 * 还原指定提交的改动。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 要还原的提交哈希。
 * @param parentIndex - 合并提交要沿用的父提交序号；非合并提交传不大于 0 的值。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function revertCommit(repo: string, commitHash: string, parentIndex: number): Promise<ErrorInfo> {
	const args = ['revert', '--no-edit'];
	if (parentIndex > 0) args.push('-m', parentIndex.toString());
	args.push(commitHash);
	return gitErrorInfo(args, repo);
}

/**
 * 写入一条配置。
 *
 * @param repo - 仓库路径。
 * @param key - 配置键。
 * @param value - 配置值。
 * @param location - 写入位置。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function setConfigValue(repo: string, key: string, value: string, location: ConfigLocation): Promise<ErrorInfo> {
	return gitErrorInfo(['config', '--' + location, key, value], repo);
}

/**
 * 删除一条配置的全部取值。
 *
 * @param repo - 仓库路径。
 * @param key - 配置键。
 * @param location - 配置所在位置。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function unsetConfigValue(repo: string, key: string, location: ConfigLocation): Promise<ErrorInfo> {
	return gitErrorInfo(['config', '--' + location, '--unset-all', key], repo);
}

/**
 * 清理未跟踪文件。
 *
 * @param repo - 仓库路径。
 * @param directories - 是否连同未跟踪目录一并清理。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function cleanUntrackedFiles(repo: string, directories: boolean): Promise<ErrorInfo> {
	return gitErrorInfo(['clean', '-f' + (directories ? 'd' : '')], repo);
}

/**
 * 把单个文件还原到指定修订的版本。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 目标修订。
 * @param filePath - 文件路径。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function resetFileToRevision(repo: string, commitHash: string, filePath: string): Promise<ErrorInfo> {
	return gitErrorInfo(['checkout', commitHash, '--', filePath], repo);
}

/**
 * 应用一条贮藏，保留该贮藏。
 *
 * @param repo - 仓库路径。
 * @param selector - 贮藏选择器。
 * @param reinstateIndex - 是否使用 `--index` 恢复暂存状态。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function applyStash(repo: string, selector: string, reinstateIndex: boolean): Promise<ErrorInfo> {
	const args = ['stash', 'apply'];
	if (reinstateIndex) args.push('--index');
	args.push(selector);
	return gitErrorInfo(args, repo);
}

/**
 * 基于一条贮藏新建分支并应用该贮藏。
 *
 * @param repo - 仓库路径。
 * @param selector - 贮藏选择器。
 * @param branchName - 新分支名。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function branchFromStash(repo: string, selector: string, branchName: string): Promise<ErrorInfo> {
	return gitErrorInfo(['stash', 'branch', branchName, selector], repo);
}

/**
 * 丢弃一条贮藏。
 *
 * @param repo - 仓库路径。
 * @param selector - 贮藏选择器。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function dropStash(repo: string, selector: string): Promise<ErrorInfo> {
	return gitErrorInfo(['stash', 'drop', selector], repo);
}

/**
 * 弹出并应用一条贮藏。
 *
 * @param repo - 仓库路径。
 * @param selector - 贮藏选择器。
 * @param reinstateIndex - 是否使用 `--index` 恢复暂存状态。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function popStash(repo: string, selector: string, reinstateIndex: boolean): Promise<ErrorInfo> {
	const args = ['stash', 'pop'];
	if (reinstateIndex) args.push('--index');
	args.push(selector);
	return gitErrorInfo(args, repo);
}

/**
 * 把当前未提交改动存入一条新贮藏。
 *
 * @param repo - 仓库路径。
 * @param message - 贮藏信息；空串表示不指定信息。
 * @param includeUntracked - 是否使用 `--include-untracked` 一并存入未跟踪文件。
 * @returns 成功为 null；失败为 git 的 stderr 文本。
 */
export function pushStash(repo: string, message: string, includeUntracked: boolean): Promise<ErrorInfo> {
	const args = ['stash', 'push'];
	if (includeUntracked) args.push('--include-untracked');
	if (message !== '') args.push('--message', message);
	return gitErrorInfo(args, repo);
}

/** 合并到选中分支的结果。 */
export interface MergeIntoBranchResult {
	/** 失败时的错误文本；成功为 null。 */
	readonly error: ErrorInfo;
	/** 检出并合并后所在的分支名。 */
	readonly branchName: string;
	/** git 生成的初始合并提交信息；无待合并状态时为 null。 */
	readonly mergeMessage: string | null;
	/** 合并是否因冲突而停下；停下时仍有待合并状态。 */
	readonly conflicted: boolean;
}

/**
 * 读出待合并状态下 git 生成的提交信息。
 *
 * `MERGE_MSG` 的位置随工作树而变（链接工作树在 `.git/worktrees/<name>/` 下），
 * 因此经 `git rev-parse --git-path MERGE_MSG` 取路径。无待合并状态时该文件不存在。
 *
 * @param repo - 仓库路径。
 * @returns 提交信息；无待合并状态时返回 null。
 */
async function readMergeMessage(repo: string): Promise<string | null> {
	const result = await runGit(['rev-parse', '--git-path', 'MERGE_MSG'], repo);
	if (result.code !== 0) return null;
	const relative = result.stdout.trim();
	if (relative === '') return null;
	const absolute = nodePath.isAbsolute(relative) ? relative : nodePath.resolve(repo, relative);
	try {
		const text = await fs.readFile(absolute, 'utf8');
		return text.replace(/[\r\n]+$/, '');
	} catch {
		return null;
	}
}

/**
 * 检出选中的分支，并把检出前的当前分支合并过去，停在未提交状态。
 *
 * 合并固定带 `--no-ff`：目标分支若是当前分支的祖先，不加该选项会直接快进、不产生
 * 待合并状态与提交信息。合并成功与冲突都保留 `MERGE_HEAD`，冲突时 git 以非零退出，
 * 但初始提交信息仍已写入 `MERGE_MSG`，因此两种情况都回传该信息。
 *
 * @param repo - 仓库路径。
 * @param branchName - 要检出并合并到的分支名。
 * @param message - 合并提交信息；空串表示使用 git 生成的初始信息。
 * @returns 分支名、初始合并信息与冲突标记；检出或合并失败时 `error` 为错误文本。
 */
export async function mergeCurrentIntoBranch(repo: string, branchName: string, message: string): Promise<MergeIntoBranchResult> {
	const empty: MergeIntoBranchResult = { error: null, branchName, mergeMessage: null, conflicted: false };

	/* 检出前的当前分支名；分离头指针时为空，此时没有可合并回去的分支。 */
	const current = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], repo);
	const source = current.code === 0 ? current.stdout.trim() : '';
	if (source === '') {
		return { ...empty, error: '当前处于分离头指针状态，没有可合并到选中分支的分支。' };
	}
	if (source === branchName) {
		return { ...empty, error: '选中的就是当前分支。' };
	}

	const checkoutError = await gitErrorInfo(['checkout', branchName], repo);
	if (checkoutError !== null) return { ...empty, error: checkoutError };

	const args = ['merge', '--no-ff', '--no-commit'];
	if (message !== '') args.push('--message', message);
	args.push(source);
	const mergeError = await gitErrorInfo(args, repo);
	const mergeMessage = await readMergeMessage(repo);
	/* 非零退出可能是冲突（仍处待合并状态），也可能是真正的失败；以 MERGE_HEAD 区分。 */
	if (mergeError !== null) {
		const mergeHead = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repo);
		if (mergeHead.code !== 0) return { ...empty, error: mergeError };
		return { error: null, branchName, mergeMessage, conflicted: true };
	}
	return { error: null, branchName, mergeMessage, conflicted: false };
}
