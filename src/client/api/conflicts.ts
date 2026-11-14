/**
 * 冲突条目的解决命令客户端。
 *
 * 宿主按路径逐个处置，单条失败只回投原因，因此这里把结局原样交给调用方：
 * 变更区据此只移除真正解决的条目，失败原因由面板汇总提示。
 */
import { callApiRaw, errorList } from './http.ts';
import type { ConflictAction, ConflictReport } from '../shared/types.ts';

/**
 * 对一批未合并路径执行解决动作。
 *
 * @param repo - 仓库路径。
 * @param paths - 文件路径，相对仓库根。
 * @param action - 解决动作。
 * @returns 已处置的路径与失败原因。
 */
export async function resolveConflict(repo: string, paths: readonly string[], action: ConflictAction): Promise<ConflictReport> {
	const payload = await callApiRaw(repo, { command: 'resolveConflict', paths, action });
	const resolved = Array.isArray(payload.resolved)
		? (payload.resolved as unknown[]).filter((path): path is string => typeof path === 'string')
		: [];
	return { resolved, errors: errorList(payload) };
}
