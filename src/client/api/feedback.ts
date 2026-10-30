/**
 * 反馈与日志：提交反馈、读取日志位置与最近文件。
 */
import { callApi, commandError } from './http.ts';
import { textOf } from '../shared/text.ts';

/** 反馈类型。 */
export type FeedbackType = 'bug' | 'suggestion' | 'other';

/** 最近的一个日志文件。 */
export interface LogFileInfo {
	readonly path: string;
	readonly day: string;
	readonly name: string;
	readonly size: number;
	/** 宿主给出的体积文本，如 `312.4 KB`。 */
	readonly sizeText: string;
	readonly modified: number;
}

/** 日志位置信息。 */
export interface FeedbackInfo {
	/** 日志根目录绝对路径。 */
	readonly logDir: string;
	/** 当前启动的日志文件；未写入时为 null。 */
	readonly currentFile: string | null;
	/** 最近的日志文件，按启动先后倒序。 */
	readonly files: readonly LogFileInfo[];
}

/** 提交结果。 */
export interface SubmitFeedbackOutcome {
	/** issue 地址；失败时为空串。 */
	readonly url: string;
	/** 失败原因；成功时为 null。 */
	readonly error: string | null;
	/** 失败分类。 */
	readonly kind: string;
	/** 日志目录。 */
	readonly logDir: string;
	/** 日志压缩包绝对路径；未附带日志时为 null。 */
	readonly archive: string | null;
	/** 压缩包是否成功压缩。 */
	readonly compressed: boolean;
}

/**
 * 读取日志位置信息。
 *
 * 日志位置与所选仓库无关，因此工作区未知时也照常读取。
 *
 * @param cwd - 会话工作区路径；未知时传 null。
 * @returns 日志目录、当前文件与最近文件。
 */
export async function loadFeedbackInfo(cwd: string | null): Promise<FeedbackInfo> {
	const payload = await callApi(cwd, { command: 'feedbackInfo' });
	const files = Array.isArray(payload.files) ? payload.files : [];
	return {
		logDir: textOf(payload.logDir),
		currentFile: typeof payload.currentFile === 'string' && payload.currentFile !== '' ? payload.currentFile : null,
		files: files.map((item) => {
			const file = item as Record<string, unknown>;
			return {
				path: textOf(file.path), day: textOf(file.day), name: textOf(file.name),
				size: typeof file.size === 'number' ? file.size : 0,
				sizeText: textOf(file.sizeText),
				modified: typeof file.modified === 'number' ? file.modified : 0,
			};
		}),
	};
}

/**
 * 提交一条反馈。
 *
 * @param cwd - 会话工作区路径。
 * @param options - 反馈内容与附带选项。
 * @returns 提交结果。
 */
export async function submitFeedback(cwd: string, options: {
	readonly type: FeedbackType;
	readonly title: string;
	readonly description: string;
	readonly attachLogs: boolean;
	readonly disableRedaction: boolean;
	readonly exemptions: readonly string[];
	readonly pluginVersion: string;
}): Promise<SubmitFeedbackOutcome> {
	const payload = await callApi(cwd, { command: 'submitFeedback', ...options });
	const error = commandError(payload);
	return {
		url: textOf(payload.url),
		error,
		kind: textOf(payload.kind),
		logDir: textOf(payload.logDir),
		archive: typeof payload.archive === 'string' && payload.archive !== '' ? payload.archive : null,
		compressed: payload.compressed === true,
	};
}
