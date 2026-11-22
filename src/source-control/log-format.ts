/**
 * logcat 文本日志的格式层：时间戳、级别与单行拼装。
 *
 * 采用 Android logcat 的 threadtime 形态：
 * `MM-DD HH:MM:SS.mmm  PID  TID  LEVEL TAG: message`
 * 每条记录以时间戳开头；含换行的消息按行拆成多条记录，续行沿用同一时间戳与级别。
 */
import { pad2, pad3 } from '../shared/pad-number.js';

/** logcat 级别字符。 */
export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E';

/** 一条待写入的日志记录。 */
export interface LogRecord {
	/** 记录时间。 */
	readonly time: Date;
	/** 进程 id。 */
	readonly pid: number;
	/** 线程 id。 */
	readonly tid: number;
	/** 级别。 */
	readonly level: LogLevel;
	/** 标签，写日志的模块名。 */
	readonly tag: string;
	/** 消息正文；可含换行。 */
	readonly message: string;
}


/**
 * logcat 时间戳：`MM-DD HH:MM:SS.mmm`。
 *
 * @param time - 记录时间。
 * @returns 时间戳文本。
 */
export function formatLogTimestamp(time: Date): string {
	return `${pad2(time.getMonth() + 1)}-${pad2(time.getDate())} `
		+ `${pad2(time.getHours())}:${pad2(time.getMinutes())}:${pad2(time.getSeconds())}.${pad3(time.getMilliseconds())}`;
}

/** 进程号与线程号的列宽。 */
const THREAD_COLUMN = 5;

/** 一次子进程失败写进日志的 stderr 字符上限。 */
export const MAX_FAILURE_LOG_CHARS = 2000;

/**
 * 失败明细接在日志正文之后的片段。
 *
 * stderr 为空时不拼换行：否则会多出一条只有前缀的空记录。
 *
 * @param stderr - 子进程的标准错误。
 * @returns 以换行开头的明细；stderr 为空时为空串。
 */
export function failureLogTail(stderr: string): string {
	const detail = stderr.trim().slice(0, MAX_FAILURE_LOG_CHARS);
	return detail === '' ? '' : `\n${detail}`;
}

/**
 * 拼一条 logcat 记录（不含换行符）。
 *
 * 消息内含换行时逐行写出，续行共享同一时间戳与级别，因此每一行都以时间戳开头。
 *
 * @param record - 记录。
 * @returns 以 `\n` 分隔的若干行。
 */
export function formatLogLines(record: LogRecord): string[] {
	const stamp = formatLogTimestamp(record.time);
	const head = `${stamp} ${String(record.pid).padStart(THREAD_COLUMN)} ${String(record.tid).padStart(THREAD_COLUMN)} ${record.level} ${record.tag}: `;
	return record.message.split('\n').map((line) => head + line);
}
