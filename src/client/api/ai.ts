/**
 * AI 模型目录、流式提交信息生成与翻译。
 */
import { callApi } from './http.ts';

/** AI 模型目录端点。 */
const AI_MODELS_PATH = '/dsh-source-control/gg/ai-models';

/** AI 提交生成端点。 */
const AI_COMMIT_PATH = '/dsh-source-control/gg/ai-commit';

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
 * 翻译是否可用。
 *
 * 翻译服务由 cot-translation bundle 可选装载，未装载时调用方不显示翻译入口，
 * 而不是等用户点击后才失败。
 *
 * @param cwd - 会话工作区路径。
 * @returns 可用时为 true。
 */
export async function translateAvailable(cwd: string): Promise<boolean> {
	try {
		const payload = await callApi(cwd, { command: 'translateAvailable' });
		return payload.available === true;
	} catch {
		return false;
	}
}

/**
 * 翻译一段文本。
 *
 * 由宿主经官方 translator 服务转发；调用方按标题与正文行拆分后逐段请求，
 * 使译文保留原有换行结构。
 *
 * @param cwd - 会话工作区路径。
 * @param text - 待翻译文本。
 * @param targetLanguage - 目标语言标签。
 * @param signal - 取消信号。
 * @returns 译文。
 */
export async function translateText(cwd: string, text: string, targetLanguage: string, signal?: AbortSignal): Promise<string> {
	const payload = await callApi(cwd, { command: 'translateText', text, targetLanguage }, signal);
	return typeof payload.text === 'string' ? payload.text : text;
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
	handlers: CommitMessageHandlers, amend = false, language = '',
): Promise<void> {
	const res = await fetch(AI_COMMIT_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ repo: cwd, provider, model, rules, amend, language }),
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
