/**
 * 反馈提交：把用户填写的正文、环境信息交 `gh issue create` 建 issue，再把日志文本作为
 * 独立评论追加到该 issue 下。
 *
 * 流程固定为三步：
 * 1. 取日志、脱敏；磁盘上的原始日志不动；
 * 2. `gh issue create` 用 `--body-file` 建 issue；
 * 3. 按 issue 评论上限把日志合并成若干条评论（`./feedback-comment.ts`），逐条
 *    `gh issue comment --body-file` 追加。
 *
 * 日志走评论而不是附件：GitHub 的附件接口不接受日志等文本类型，而评论正文上限 65536
 * 字符，落盘侧已按它约束单份文件，因此不需要附件环节。
 *
 * 失败一律归类为可读原因交给前端：缺 CLI、未登录、缺 scope、无权限、日志不可读。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { runCollect } from './host-runtime.js';
import { buildIssueBody, FEEDBACK_REPO, feedbackIssueTitle, type FeedbackFacts, type FeedbackType } from './feedback-text.js';
import { groupLogComments, type LogComment, type LogSource } from './feedback-comment.js';
import { currentLogFile, logRoot, recentLogFiles } from './logger.js';
import { redactSummary, redactText } from './log-redact.js';
import { OUTBOX_FOLDER } from './log-retention.js';

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
	return runCollect({
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
	/** 附带哪些日志文件（绝对路径）；缺省时取当前启动的日志文件。 */
	readonly logFiles?: readonly string[];
	/** 是否停用脱敏（停用即提交原始内容）。 */
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
	/** 已追加的日志评论条数；未附带日志时为 0。 */
	readonly commentCount: number;
	/** 日志评论提交失败的原因；全部成功或未附带日志时为 null。 */
	readonly commentError: string | null;
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

/** 一次读取到的日志：内容、文件名与绝对路径。 */
interface ReadLog extends LogSource {
	/** 绝对路径，作为截断说明里的位置。 */
	readonly path: string;
}

/**
 * 取用于提交的日志内容。
 *
 * 没有指定文件时取当前启动的那一份；当前还没有写出内容时退回最近的一份。
 *
 * @param options - 提交入参。
 * @returns 日志列表，按启动先后排列；一份都读不到时为空数组。
 */
function readLogsForAttach(options: SubmitFeedbackOptions): ReadLog[] {
	const paths = (options.logFiles ?? []).filter((path) => path !== '');
	const chosen = paths.length > 0
		? paths
		: (() => {
			const current = currentLogFile();
			if (current !== null) return [current];
			const recent = recentLogFiles(1);
			return recent.length === 0 ? [] : [recent[0].path];
		})();
	const read: ReadLog[] = [];
	for (const path of chosen) {
		try {
			read.push({ path, name: path.split(/[\\/]/).pop() ?? 'logcat.log', text: readFileSync(path, 'utf8') });
		} catch {
			/* 读不到的那一份跳过：其余仍可提交 */
		}
	}
	return read;
}

/**
 * 从 issue 地址取 issue 号。
 *
 * @param url - `gh issue create` 回投的地址。
 * @returns issue 号；地址不含编号时为 null。
 */
function issueNumberFrom(url: string): string | null {
	const match = /\/issues\/(\d+)\s*$/.exec(url.trim());
	return match === null ? null : match[1];
}

/** 一条评论正文的字符上限，与 GitHub 的 issue 评论正文上限一致。 */
export const COMMENT_BODY_LIMIT = 65536;

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
	let comments: readonly LogComment[] = [];
	let logs: ReadLog[] = [];
	let facts: FeedbackFacts = {
		type: options.type,
		description: options.description,
		pluginVersion: options.pluginVersion,
		platform: platformText(),
		node: process.version,
		logFiles: [],
		logCommentCount: 0,
		redaction: '',
		exemptionCount: (options.exemptions ?? []).length,
	};
	if (options.attachLogs) {
		logs = readLogsForAttach(options);
		if (logs.length === 0) {
			return { url: '', error: '没有可附带的日志文件。', kind: 'unknown', logDir, commentCount: 0, commentError: null };
		}
		const username = process.env.USERNAME ?? process.env.USER ?? '';
		const counts = { credential: 0, token: 0, user: 0 };
		const sources: LogSource[] = [];
		for (const log of logs) {
			const masked = options.disableRedaction === true
				? { text: log.text, counts: { credential: 0, token: 0, user: 0 } }
				: redactText(log.text, { username, exemptions: options.exemptions ?? [] });
			counts.credential += masked.counts.credential;
			counts.token += masked.counts.token;
			counts.user += masked.counts.user;
			sources.push({ name: log.name, text: masked.text });
		}
		const paths: Record<string, string> = {};
		for (const log of logs) paths[log.name] = log.path;
		comments = groupLogComments(sources, COMMENT_BODY_LIMIT, paths);
		facts = {
			...facts,
			logFiles: logs.map((log) => log.name),
			logCommentCount: comments.length,
			redaction: redactSummary(counts),
		};
	}
	// 正文走 --body-file：长描述与日志说明会让命令行参数超出系统上限。
	const dir = issueBodyDir();
	mkdirSync(dir, { recursive: true });
	const bodyPath = join(dir, `issue-body-${String(Date.now())}.md`);
	writeFileSync(bodyPath, buildIssueBody(facts), 'utf8');
	const result = await runGh(
		['issue', 'create', '--repo', FEEDBACK_REPO, '--title', feedbackIssueTitle(options.type, options.title), '--body-file', bodyPath],
		// 提交与仓库无关：面板未选中仓库时用宿主进程的工作目录。
		options.cwd === '' ? process.cwd() : options.cwd,
	);
	rmSync(bodyPath, { force: true });
	if (result.code !== 0) {
		const failure = classify(result);
		return { url: '', error: failure.message, kind: failure.kind, logDir, commentCount: 0, commentError: null };
	}
	const url = result.stdout.trim().split('\n').filter((line) => line.trim() !== '').pop() ?? '';
	// issue 已建成即算成功：日志评论的失败只回报原因，不重开一条 issue 制造重复。
	const commentError = await postLogComments(url, comments, options.cwd === '' ? process.cwd() : options.cwd);
	return { url, error: null, kind: 'ok', logDir, commentCount: comments.length, commentError };
}

/**
 * 把日志评论逐条追加到 issue 下。
 *
 * 逐条发送而不是一次多发：评论接口没有批量形态，一条失败不影响已发出的。
 *
 * @param url - issue 地址。
 * @param comments - 待发送的评论正文。
 * @param cwd - 执行 gh 的工作目录。
 * @returns 失败原因；全部成功或无需发送时为 null。
 */
async function postLogComments(url: string, comments: readonly LogComment[], cwd: string): Promise<string | null> {
	if (comments.length === 0) return null;
	const issue = issueNumberFrom(url);
	if (issue === null) return `无法从 issue 地址识别编号：${url}`;
	const dir = issueBodyDir();
	mkdirSync(dir, { recursive: true });
	for (const [index, comment] of comments.entries()) {
		const path = join(dir, `comment-${String(Date.now())}-${String(index)}.md`);
		writeFileSync(path, comment.body, 'utf8');
		const result = await runGh(['issue', 'comment', issue, '--repo', FEEDBACK_REPO, '--body-file', path], cwd);
		rmSync(path, { force: true });
		if (result.code !== 0) {
			const failure = classify(result);
			return `第 ${String(index + 1)}/${String(comments.length)} 条日志评论发送失败：${failure.message}`;
		}
	}
	return null;
}

/**
 * issue 正文与评论正文的暂存目录。
 *
 * 载体文件在提交过程内即删；提交中途失败留下的那几个由下次启动的 `cleanLogs()` 整目录清掉。
 *
 * @returns 绝对路径。
 */
function issueBodyDir(): string {
	return join(logRoot(), OUTBOX_FOLDER);
}
