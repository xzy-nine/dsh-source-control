/**
 * 反馈提交：把用户填写的正文、环境信息与打包好的日志交 `gh issue create` 提交到本插件仓库，
 * 并把 issue 地址交回前端由用户打开、手动上传日志压缩包。
 *
 * 流程固定为三步：
 * 1. 取日志、脱敏、打包成 zip（`./log-archive.ts`），磁盘上的原始日志不动；
 * 2. `gh issue create` 用 `--body-file` 建 issue——正文里写明压缩包名与上传步骤；
 * 3. 返回 issue 地址与压缩包绝对路径，前端据此提示用户上传。
 *
 * 失败一律归类为可读原因交给前端：缺 CLI、未登录、缺 scope、无权限、日志不可读。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { collectProcess } from './child-process.js';
import { buildIssueBody, FEEDBACK_REPO, feedbackIssueTitle, type FeedbackFacts, type FeedbackType } from './feedback-text.js';
import { currentLogFile, logRoot, recentLogFiles } from './logger.js';
import { redactSummary, redactText } from './log-redact.js';
import { archiveFileName, archiveLog, outboxDir } from './log-archive.js';

/** 一次 `gh` 调用的结果。 */
interface GhRun {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * 运行一次 `gh`。
 *
 * @param args - 参数数组。
 * @param cwd - 工作目录。
 * @returns 退出码与输出。
 */
function runGh(args: readonly string[], cwd: string): Promise<GhRun> {
	return collectProcess({
		command: 'gh',
		args,
		cwd,
		env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' },
	});
}

/** 反馈提交入参。 */
export interface SubmitFeedbackOptions {
	/** 反馈类型。 */
	readonly type: FeedbackType;
	/** 标题。 */
	readonly title: string;
	/** 描述。 */
	readonly description: string;
	/** 是否附带日志。 */
	readonly attachLogs: boolean;
	/** 附带的日志文件绝对路径；缺省时取当前启动的日志文件。 */
	readonly logFile?: string;
	/** 是否停用脱敏（停用即打包原始内容）。 */
	readonly disableRedaction?: boolean;
	/** 豁免保留的字符串。 */
	readonly exemptions?: readonly string[];
	/** 插件版本。 */
	readonly pluginVersion: string;
	/** 执行 gh 的工作目录。 */
	readonly cwd: string;
}

/** 反馈提交结果。 */
export interface SubmitFeedbackResult {
	/** issue 地址；失败时为空串。 */
	readonly url: string;
	/** 失败原因；成功时为 null。 */
	readonly error: string | null;
	/** 失败分类，供前端决定提示方式。 */
	readonly kind: 'ok' | 'missing-cli' | 'not-logged-in' | 'missing-scope' | 'forbidden' | 'invalid' | 'unknown';
	/** 日志目录绝对路径：失败时提示用户手动提交用。 */
	readonly logDir: string;
	/** 日志压缩包绝对路径；未附带日志时为 null。 */
	readonly archive: string | null;
	/** 压缩包是否成功压缩；false 表示给出的是未压缩副本。 */
	readonly compressed: boolean;
}

/**
 * 分类 `gh` 的失败。
 *
 * @param result - `gh` 调用结果。
 * @returns 分类与给用户看的说明。
 */
function classify(result: GhRun): { kind: SubmitFeedbackResult['kind']; message: string } {
	const text = `${result.stderr}\n${result.stdout}`.trim();
	if (result.code === -1 && /ENOENT/i.test(result.stderr)) {
		return { kind: 'missing-cli', message: '未找到 gh CLI，请先安装 GitHub CLI（https://cli.github.com）并登录。' };
	}
	const scope = /needs the "([^"]+)" scope/.exec(text)?.[1] ?? null;
	if (scope !== null) return { kind: 'missing-scope', message: `GitHub 授权缺少 ${scope} 权限，请运行 gh auth refresh -s ${scope} 后重试。` };
	if (/gh auth login|not logged in|authentication required|bad credentials/i.test(text)) {
		return { kind: 'not-logged-in', message: 'gh 未登录，请运行 gh auth login 后重试。' };
	}
	if (/HTTP 403|Must have admin rights|Resource not accessible/i.test(text)) {
		return { kind: 'forbidden', message: '当前账号没有在该仓库创建 issue 的权限。' };
	}
	if (/HTTP 422|HTTP 404/i.test(text)) {
		return { kind: 'invalid', message: 'GitHub 拒绝了该请求，请检查标题与描述后重试。' };
	}
	return { kind: 'unknown', message: text === '' ? 'gh 执行失败' : text };
}

/**
 * 取用于附带的日志内容。
 *
 * @param options - 提交入参。
 * @returns 日志原文与文件名；不可读取时为 null。
 */
function readLogForAttach(options: SubmitFeedbackOptions): { text: string; name: string } | null {
	const path = options.logFile ?? currentLogFile();
	if (path !== null) {
		try {
			const name = path.split(/[\\/]/).pop() ?? 'logcat.log';
			return { text: readFileSync(path, 'utf8'), name };
		} catch {
			return null;
		}
	}
	const recent = recentLogFiles(1);
	if (recent.length === 0) return null;
	try {
		return { text: readFileSync(recent[0].path, 'utf8'), name: recent[0].name };
	} catch {
		return null;
	}
}

/**
 * 平台描述。
 *
 * @returns 文本，如 `win32 10.0 x64`。
 */
function platformText(): string {
	return `${process.platform} ${os.release()} ${process.arch}`;
}

/**
 * 提交一条反馈。
 *
 * @param options - 见 {@link SubmitFeedbackOptions}。
 * @returns 提交结果。
 */
export async function submitFeedback(options: SubmitFeedbackOptions): Promise<SubmitFeedbackResult> {
	const logDir = logRoot();
	let archive: string | null = null;
	let compressed = false;
	let facts: FeedbackFacts = {
		type: options.type,
		description: options.description,
		pluginVersion: options.pluginVersion,
		platform: platformText(),
		node: process.version,
		logFile: null,
		logSize: null,
		redaction: '',
		exemptionCount: (options.exemptions ?? []).length,
	};
	if (options.attachLogs) {
		const raw = readLogForAttach(options);
		if (raw === null) {
			return { url: '', error: '没有可附带的日志文件。', kind: 'unknown', logDir, archive: null, compressed: false };
		}
		const masked = options.disableRedaction === true
			? { text: raw.text, counts: { credential: 0, token: 0, user: 0 } }
			: redactText(raw.text, { username: process.env.USERNAME ?? process.env.USER ?? '', exemptions: options.exemptions ?? [] });
		const packed = await archiveLog(raw.name, masked.text);
		archive = packed.path;
		compressed = packed.compressed;
		facts = {
			...facts,
			logFile: archiveFileName(packed.path),
			logSize: packed.size,
			redaction: redactSummary(masked.counts),
		};
	}
	// 正文走 --body-file：长描述与日志说明会让命令行参数超出系统上限。
	const dir = outboxDir();
	mkdirSync(dir, { recursive: true });
	const bodyPath = join(dir, `issue-body-${String(Date.now())}.md`);
	writeFileSync(bodyPath, buildIssueBody(facts), 'utf8');
	const result = await runGh(
		['issue', 'create', '--repo', FEEDBACK_REPO, '--title', feedbackIssueTitle(options.type, options.title), '--body-file', bodyPath],
		options.cwd,
	);
	if (result.code === 0) {
		const url = result.stdout.trim().split('\n').filter((line) => line.trim() !== '').pop() ?? '';
		return { url, error: null, kind: 'ok', logDir, archive, compressed };
	}
	const failure = classify(result);
	return { url: '', error: failure.message, kind: failure.kind, logDir, archive, compressed };
}
