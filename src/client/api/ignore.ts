/**
 * 忽略规则写入与本地排除文件状态。
 */
import { callApi } from './http.ts';

/** 写入 `.gitignore` 的结果。 */
export interface IgnoreWriteResult {
	/** 规则写入的文件，相对仓库根。 */
	readonly file: string;
	/** 该文件是否为本次新建。 */
	readonly created: boolean;
	/** 写入前该文件是否已在版本控制中：未跟踪时没有可比较的差异。 */
	readonly tracked: boolean;
	/** 本次写入的规则；规则已存在时为 null。 */
	readonly rule: string | null;
}

/** 本地排除文件的状态。 */
export interface LocalExcludeState {
	/** 排除文件的绝对路径。 */
	readonly path: string;
	/** 有效条目。 */
	readonly entries: readonly string[];
}

/**
 * 把路径写进最近的 `.gitignore`。
 *
 * @param cwd - 会话工作区路径。
 * @param path - 目标路径，相对当前工作树根。
 * @returns 写入结果。
 */
export async function addToGitignore(cwd: string, path: string): Promise<IgnoreWriteResult> {
	const payload = await callApi(cwd, { command: 'addToGitignore', path });
	const result = (payload.result ?? {}) as Record<string, unknown>;
	return {
		file: typeof result.file === 'string' ? result.file : '',
		created: result.created === true,
		tracked: result.tracked === true,
		rule: typeof result.rule === 'string' ? result.rule : null,
	};
}

/**
 * 把路径写进本地排除文件 `.git/info/exclude`。
 *
 * @param cwd - 会话工作区路径。
 * @param path - 目标路径，相对当前工作树根。
 * @returns 写入后的排除状态。
 */
export async function addToLocalExclude(cwd: string, path: string): Promise<LocalExcludeState> {
	const payload = await callApi(cwd, { command: 'addToLocalExclude', path });
	return localExcludeStateOf(payload);
}

/**
 * 读取本地排除文件的条目。
 *
 * @param cwd - 会话工作区路径。
 * @returns 排除文件路径与有效条目。
 */
export async function localExcludeState(cwd: string): Promise<LocalExcludeState> {
	const payload = await callApi(cwd, { command: 'localExcludeState' });
	return localExcludeStateOf(payload);
}

/**
 * 从宿主响应里取本地排除状态。
 *
 * @param payload - 宿主响应。
 * @returns 排除文件路径与有效条目。
 */
function localExcludeStateOf(payload: Record<string, unknown>): LocalExcludeState {
	const state = (payload.state ?? {}) as Record<string, unknown>;
	const entries = Array.isArray(state.entries) ? state.entries.filter((item): item is string => typeof item === 'string') : [];
	return { path: typeof state.path === 'string' ? state.path : '', entries };
}
