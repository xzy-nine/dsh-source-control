/**
 * 反馈提交：用 `gh issue create` 建立 issue，日志脱敏后作为独立评论追加到该 issue 下。
 *
 * 正文与环境信息写进 `--body-file`；磁盘上的原始日志不动。日志按评论上限合并成若干条评论
 * （`./feedback-comment.ts`），逐条经 `gh issue comment --body-file` 追加。GitHub 的附件接口
 * 不接受日志等文本类型，因此日志走评论而不是附件。
 *
 * 失败归类为可读原因交给前端：缺 CLI、未登录、缺 scope、无权限、日志不可读。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { classifyGhFailure, runGh, type GhResult } from './gh-cli.js';
import type { FeedbackFailureKind, FeedbackLogFields } from '../shared/feedback-outcome.js';
import { buildIssueBody, FEEDBACK_REPO, feedbackIssueTitle, type FeedbackFacts, type FeedbackType } from './feedback-text.js';
import { groupLogComments, type LogComment, type LogSource } from './feedback-comment.js';
import { currentLogFile, logRoot, recentLogFiles } from './logger.js';
import { redactSummary, redactText } from './log-redact.js';
import { OUTBOX_FOLDER } from './log-retention.js';



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
export interface SubmitFeedbackResult extends FeedbackLogFields {
	/** issue 地址；失败时为空串。 */
	readonly url: string;
	/** 失败原因；成功时为 null。 */
	readonly error: string | null;
	/** 失败分类，供前端决定提示方式。 */
	readonly kind: FeedbackFailureKind;
}

/** 一次 `gh` 失败：给前端的结果分类与可读说明。 */
interface GhFailure {
	readonly kind: SubmitFeedbackResult['kind'];
	readonly message: string;
}

/** 一次带正文的 `gh` 调用：成功给出结果，失败给出已分类的原因。 */
type GhAttempt =
	| { readonly ok: true; readonly result: GhResult }
	| { readonly ok: false; readonly failure: GhFailure };

/**
 * 以 `--body-file` 形式把正文交给 `gh`，按退出码归纳成败；载体文件在返回前删除。
 *
 * 正文一律走 `--body-file`：长描述与日志文本会让命令行参数超出系统上限。文件名带时间戳
 * 与 `prefix`，同一毫秒内的两条评论因此互不覆盖。
 *
 * @param body - 正文。
 * @param prefix - 文件名前缀，用于在数据目录里区分用途。
 * @param argsOf - 由临时文件路径构造 `gh` 参数。
 * @param cwd - 执行 `gh` 的工作目录。
 * @returns 成功时的调用结果，或已分类的失败原因。
 */
async function runGhAttempt(
	body: string,
	prefix: string,
	argsOf: (path: string) => readonly string[],
	cwd: string,
): Promise<GhAttempt> {
	const dir = issueBodyDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${prefix}-${String(Date.now())}.md`);
	writeFileSync(path, body, 'utf8');
	try {
		const result = await runGh(argsOf(path), cwd);
		return result.code === 0 ? { ok: true, result } : { ok: false, failure: classify(result) };
	} finally {
		rmSync(path, { force: true });
	}
}

/**
 * 分类 `gh` 的失败。
 *
 * @param result - `gh` 调用结果。
 * @returns 分类与给用户看的说明。
 */
function classify(result: GhResult): GhFailure {
	const { kind, message } = classifyGhFailure(result);
	if (kind === 'missing-scope') return { kind, message };
	if (kind === 'forbidden') return { kind, message: '当前账号没有在该仓库创建 issue 的权限。' };
	if (kind === 'not-found') return { kind: 'invalid', message: 'GitHub 拒绝了该请求，请检查标题与描述后重试。' };
	return { kind: kind === 'invalid' ? 'invalid' : kind, message };
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
	const attempt = await runGhAttempt(
		buildIssueBody(facts),
		'issue-body',
		(path) => ['issue', 'create', '--repo', FEEDBACK_REPO, '--title', feedbackIssueTitle(options.type, options.title), '--body-file', path],
		// 提交与仓库无关：面板未选中仓库时用宿主进程的工作目录。
		options.cwd === '' ? process.cwd() : options.cwd,
	);
	if (!attempt.ok) {
		return { url: '', error: attempt.failure.message, kind: attempt.failure.kind, logDir, commentCount: 0, commentError: null };
	}
	const url = attempt.result.stdout.trim().split('\n').filter((line) => line.trim() !== '').pop() ?? '';
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
	for (const [index, comment] of comments.entries()) {
		const attempt = await runGhAttempt(
			comment.body,
			`comment-${String(index)}`,
			(path) => ['issue', 'comment', issue, '--repo', FEEDBACK_REPO, '--body-file', path],
			cwd,
		);
		if (!attempt.ok) return `第 ${String(index + 1)}/${String(comments.length)} 条日志评论发送失败：${attempt.failure.message}`;
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
