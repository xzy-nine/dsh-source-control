/**
 * 宿主 API 传输层：统一构造 POST 请求、解析响应并把错误文本转成异常。
 */

/** API 路由，与宿主注册的路径一致。 */
const API_PATH = '/dsh-source-control/gg/api';

/**
 * 调用一条宿主命令。
 *
 * 宿主在非 2xx 响应里同样带 `error` 文本（如未知命令、缺少参数），因此先读响应体再判断
 * 状态码：能取到文本就用它，取不到才退回状态码。
 *
 * @param cwd - 会话工作区路径，作为 repo 传给宿主。
 * @param message - 命令载荷，`command` 由调用方给出。
 * @param signal - 取消信号；中止时 fetch 抛 AbortError。
 * @returns 宿主响应。
 */
export async function callApi(cwd: string, message: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const payload = await callApiRaw(cwd, message, signal);
	const { error } = payload;
	if (typeof error === 'string' && error !== '') throw new Error(error);
	return payload;
}

/**
 * 调用一条宿主命令，把 `error` 原样留在返回值里而不抛错。
 *
 * 供需要按错误内容分支的调用方使用（如把 git 的英文长文替换为可读提示）；只关心
 * 成功/失败的调用方用 {@link callApi}。HTTP 层失败仍抛错，因为此时没有命令级信息。
 *
 * @param cwd - 会话工作区路径，作为 repo 传给宿主。
 * @param message - 命令载荷，`command` 由调用方给出。
 * @param signal - 取消信号。
 * @returns 宿主响应，含可能的 `error` 字段。
 */
export async function callApiRaw(cwd: string, message: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const response = await fetch(API_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ repo: cwd, ...message }),
		signal,
	});
	const text = await response.text();
	let payload: Record<string, unknown> = {};
	try {
		const parsed = text === '' ? {} : JSON.parse(text) as unknown;
		if (parsed !== null && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
	} catch {
		/* 非 JSON 响应：保留状态码作为错误信息 */
	}
	// 宿主在非 2xx（如未知命令）时同样带 `error` 文本，状态码只在没有该文本时兜底。
	const { error } = payload;
	if (typeof error === 'string' && error !== '') return payload;
	if (!response.ok) return { ...payload, error: `宿主返回 ${response.status}` };
	return payload;
}

/**
 * 把命令返回的错误文本转成异常。
 *
 * `run` 只提示抛出的错误，而命令把失败放在返回值里而不抛错：调用方忽略返回值即静默失败。
 * 需要按错误内容分支的调用方自行读取返回值，不使用本函数。
 *
 * @param error - 命令返回的错误文本；成功为 null。
 * @param describe - 展示前的文本整理；省略时原样抛出。
 */
export function throwIfError(error: string | null, describe: (error: string) => string = (text) => text): void {
	if (error !== null) throw new Error(describe(error));
}

/**
 * 取命令返回的 `error` 字段。
 *
 * @param payload - 宿主响应。
 * @returns 错误文本；缺失或为空串时为 null。
 */
export function commandError(payload: Record<string, unknown>): string | null {
	return typeof payload.error === 'string' && payload.error !== '' ? payload.error : null;
}

/**
 * 取命令返回的 `errors` 列表。
 *
 * @param payload - 宿主响应。
 * @returns 其中的字符串项；字段缺失或类型不符时为空数组。
 */
export function errorList(payload: Record<string, unknown>): string[] {
	return Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 取命令返回的第一条 `errors`。
 *
 * @param payload - 宿主响应。
 * @returns 首条错误文本；无错误时为 null。
 */
export function firstError(payload: Record<string, unknown>): string | null {
	const errors = errorList(payload);
	return errors.length > 0 ? errors[0] : null;
}
