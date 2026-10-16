/**
 * 标签的创建与删除。
 */
import { callApi, callApiRaw, commandError, firstError } from './http.ts';


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
	return firstError(payload);
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
	const payload = await callApiRaw(cwd, { command: 'deleteTag', tagName, deleteOnRemote });
	return commandError(payload);
}


