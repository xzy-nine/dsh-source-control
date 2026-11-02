/**
 * 远程仓库与仓库配置：抓取、推送、远程增删改、用户身份与配置归档导出。
 */
import { callApi, callApiRaw, commandError, errorList } from './http.ts';

/**
 * 抓取远端引用。
 *
 * @param cwd - 会话工作区路径。
 * @param name - 远程名；null 表示全部远程。
 * @param prune - 是否修剪已删除的远程分支。
 * @param pruneTags - 是否修剪远程标签。
 * @returns 引用是否发生变化；无变化时调用方不必重取。
 */
export async function fetchRepo(cwd: string, name: string | null, prune = false, pruneTags = false): Promise<boolean> {
	const payload = await callApi(cwd, { command: 'fetch', name, prune, pruneTags });
	// 宿主编比较了抓取前后的引用：无变化时重取一遍拿到的还是旧数据。
	return payload.changed === true;
}

/**
 * 推送分支。
 *
 * @param cwd - 会话工作区路径。
 * @param branchName - 要推送的分支名。
 * @param remotes - 目标远程仓库；空数组表示不推送。
 * @param skipHooks - 是否跳过推送钩子（`--no-verify`）。
 * @param mode - 推送模式：空串为普通推送，`force` 覆盖远程分支。
 * @returns 每条远程的结果错误，无错误时为空数组。
 */
export async function pushBranch(
	cwd: string,
	branchName: string,
	remotes: readonly string[],
	skipHooks = false,
	mode: '' | 'force' | 'force-with-lease' = '',
): Promise<string[]> {
	const payload = await callApiRaw(cwd, { command: 'pushBranch', branchName, remotes, setUpstream: true, mode, skipHooks });
	return errorList(payload);
}

/**
 * 把当前分支推送到其上游。
 *
 * 不带参数执行 `git push`，目标由 git 按分支的上游配置决定。
 *
 * @param cwd - 会话工作区路径。
 * @param skipHooks - 是否跳过推送钩子（`--no-verify`）。
 * @returns 错误文本，无错误时返回 null。
 */
export async function pushUpstream(cwd: string, skipHooks = false): Promise<string | null> {
	// 用 raw 版本取回原始错误文本，调用方据此把 git 的英文长文替换为可读提示。
	const payload = await callApiRaw(cwd, { command: 'pushUpstream', skipHooks });
	return commandError(payload);
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
 * 删除远程。
 *
 * @param cwd - 会话工作区路径。
 * @param name - 远程名。
 * @returns 错误文本，无错误时返回 null。
 */
export async function deleteRemote(cwd: string, name: string): Promise<string | null> {
	const payload = await callApiRaw(cwd, { command: 'deleteRemote', name });
	return commandError(payload);
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
	const payload = await callApiRaw(cwd, { command: 'editUserDetails', name, email, location, deleteLocalName, deleteLocalEmail });
	return errorList(payload);
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
	const payload = await callApiRaw(cwd, { command: 'deleteUserDetails', name, email, location });
	return errorList(payload);
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
	const payload = await callApiRaw(cwd, { command: 'addRemote', name, url, pushUrl, fetch });
	return commandError(payload);
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
	const payload = await callApiRaw(cwd, { command: 'editRemote', nameOld, nameNew, urlOld, urlNew, pushUrlOld, pushUrlNew });
	return commandError(payload);
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
	const payload = await callApiRaw(cwd, { command: 'createArchive', ref, format, outputPath });
	return commandError(payload);
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
