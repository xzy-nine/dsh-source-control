/**
 * 标签的创建、删除、推送与详情查询。
 */
import { callApi, callApiRaw } from './http.ts';

/** 附注标签详情。 */
export interface TagDetails {
	readonly message?: string;
	readonly tagger?: string;
	readonly date?: string;
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
	const payload = await callApiRaw(cwd, { command: 'deleteTag', tagName, deleteOnRemote });
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
