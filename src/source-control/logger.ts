/**
 * 宿主侧文本日志：logcat 格式、每次启动一个文件、按日归档、按体积与保留期清理。
 *
 * 目录布局见 `./log-retention.ts`：`<root>/<YYYY-MM-DD>/logcat-<date>-<time>-<pid>.log`。
 * 根目录解析与状态文档同序：`DSH_SOURCE_CONTROL_HOME`（单测隔离）→ `DSH_HOME` → `~/.dsh`。
 *
 * 写入策略：行先入缓冲，按 `FLUSH_DELAY_MS` 合并为一次追加写；进程退出时同步收尾。
 * 体积与保留期清理在写入前按当日与全部日文件夹各判一次，判据见 log-retention.ts。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatLogLines, type LogLevel } from './log-format.js';

export type { LogLevel };
import {
	dayFolderName, isDayFolderName, logFileName, LOG_RETENTION_DAYS, orderLogFiles, planDayEvictions, planExpiredDayFolders, DAY_FOLDER_LIMIT_BYTES,
} from './log-retention.js';

/** 写入合并窗口（毫秒）。 */
const FLUSH_DELAY_MS = 250;

/** 单条消息的字符上限；超长消息截断，避免一次写入撑爆体积上限。 */
const MAX_MESSAGE_CHARS = 8000;

/** 日志根目录；无法定位时为 null。 */
let rootDir: string | null = null;

/** 当前启动的日志文件；未初始化时为 null。 */
let filePath: string | null = null;

/** 当前启动的日文件夹路径。 */
let dayDir: string | null = null;

/** 待写入的行。 */
let buffer: string[] = [];

/** 合并写定时器。 */
let timer: ReturnType<typeof setTimeout> | undefined;

/** 是否已安装退出钩子。 */
let exitHookInstalled = false;

/**
 * 解析日志根目录。
 *
 * @returns 绝对路径。
 */
function resolveRootDir(): string {
	const override = process.env.DSH_SOURCE_CONTROL_HOME;
	if (override !== undefined && override.trim().length > 0) return join(override.trim(), 'logs');
	const envHome = process.env.DSH_HOME;
	if (envHome !== undefined && envHome.trim().length > 0) return join(envHome.trim(), 'dsh-source-control', 'logs');
	return join(homedir(), '.dsh', 'dsh-source-control', 'logs');
}

/**
 * 日志根目录的绝对路径。
 *
 * @returns 路径。
 */
export function logRoot(): string {
	if (rootDir === null) rootDir = resolveRootDir();
	return rootDir;
}

/**
 * 当前启动的日志文件路径；尚未写入时为 null。
 *
 * @returns 路径。
 */
export function currentLogFile(): string | null {
	return filePath;
}

/**
 * 打开本次启动的日志文件：建立日文件夹、生成文件名并安装退出钩子。
 *
 * @param now - 启动时间。
 */
function openFile(now: Date): void {
	const dir = join(logRoot(), dayFolderName(now));
	mkdirSync(dir, { recursive: true });
	dayDir = dir;
	filePath = join(dir, logFileName(now));
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		// 同步收尾：缓冲里剩下的行在进程退出前落盘。
		process.on('exit', () => { flushSync(); });
	}
}

/**
 * 立即写出一行。
 *
 * @param line - 已格式化的一行。
 */
function writeLine(line: string): void {
	if (filePath === null) return;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		appendFileSync(filePath, `${line}\n`, 'utf8');
	} catch {
		/* 日志不可写不影响插件功能 */
	}
}

/**
 * 同步写出全部缓冲。
 */
export function flushSync(): void {
	if (timer !== undefined) {
		clearTimeout(timer);
		timer = undefined;
	}
	if (buffer.length === 0) return;
	const lines = buffer;
	buffer = [];
	for (const line of lines) writeLine(line);
}

/**
 * 安排一次合并写。
 */
function schedule(): void {
	if (timer !== undefined) return;
	timer = setTimeout(() => {
		timer = undefined;
		flushSync();
	}, FLUSH_DELAY_MS);
	// 定时器不阻止进程退出。
	timer.unref();
}

/**
 * 写一条日志。
 *
 * @param level - 级别。
 * @param tag - 标签。
 * @param message - 消息正文。
 */
export function log(level: LogLevel, tag: string, message: string): void {
	const now = new Date();
	if (filePath === null) openFile(now);
	const text = message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
	for (const line of formatLogLines({ time: now, pid: process.pid, tid: 0, level, tag, message: text })) buffer.push(line);
	// 缓冲过长时立即落盘，避免等待窗口内堆积。
	if (buffer.length >= 512) flushSync();
	else schedule();
}

/** 调试级别。 */
export function logDebug(tag: string, message: string): void { log('D', tag, message); }
/** 信息级别。 */
export function logInfo(tag: string, message: string): void { log('I', tag, message); }
/** 警告级别。 */
export function logWarn(tag: string, message: string): void { log('W', tag, message); }
/** 错误级别。 */
export function logError(tag: string, message: string): void { log('E', tag, message); }

/** 一个日文件夹内的文件与体积。 */
interface DayEntry {
	readonly name: string;
	readonly size: number;
}

/**
 * 列出一个日文件夹内的日志文件。
 *
 * @param dir - 日文件夹路径。
 * @returns 文件与体积；读取失败时为空数组。
 */
function listDayFiles(dir: string): DayEntry[] {
	try {
		const entries: DayEntry[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith('.log')) continue;
			try {
				entries.push({ name, size: statSync(join(dir, name)).size });
			} catch {
				/* 单个文件读不到时跳过 */
			}
		}
		return entries;
	} catch {
		return [];
	}
}

/** 一个可附带的日志文件。 */
export interface LogFileInfo {
	/** 绝对路径。 */
	readonly path: string;
	/** 日文件夹名（`YYYY-MM-DD`）。 */
	readonly day: string;
	/** 文件名。 */
	readonly name: string;
	/** 体积（字节）。 */
	readonly size: number;
	/** 最后写入时间（毫秒）。 */
	readonly modified: number;
}

/**
 * 列出最近的日志文件，按启动先后排列（最新在前）。
 *
 * 跨日文件夹汇总；日文件夹名与文件名都含时间，因此先按日文件夹倒序、再按文件名倒序即可。
 *
 * @param limit - 最多返回的文件数。
 * @returns 日志文件列表。
 */
export function recentLogFiles(limit = 10): LogFileInfo[] {
	const root = logRoot();
	let days: string[];
	try {
		days = readdirSync(root).filter((name) => isDayFolderName(name)).sort();
	} catch {
		return [];
	}
	const files: LogFileInfo[] = [];
	for (let index = days.length - 1; index >= 0 && files.length < limit; index -= 1) {
		const day = days[index];
		const dir = join(root, day);
		for (const entry of orderLogFiles(listDayFiles(dir)).reverse()) {
			if (files.length >= limit) break;
			const path = join(dir, entry.name);
			try {
				files.push({ path, day, name: entry.name, size: entry.size, modified: statSync(path).mtimeMs });
			} catch {
				/* 单个文件读不到时跳过 */
			}
		}
	}
	return files;
}

/**
 * 清理过期日文件夹与超限文件。
 *
 * 保留期按日文件夹名判断；体积按同一文件夹内的启动先后淘汰，当前写入的文件不受影响。
 *
 * @param now - 当前时间。
 */
export function cleanLogs(now: Date = new Date()): void {
	flushSync();
	const root = logRoot();
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return;
	}
	const expired = planExpiredDayFolders(names, now, LOG_RETENTION_DAYS);
	for (const name of expired) {
		try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* 占用中的目录留待下次 */ }
	}
	if (expired.length > 0) logInfo('logs', `清理超出保留期（${String(LOG_RETENTION_DAYS)} 天）的日文件夹，共删除 ${String(expired.length)} 个：${expired.join('、')}`);
	const current = dayDir;
	if (current === null) return;
	const currentName = current;
	const keep = filePath === null ? [] : [filePath.split(/[\\/]/).pop() ?? ''];
	const evicted = planDayEvictions(listDayFiles(currentName), DAY_FOLDER_LIMIT_BYTES, keep);
	for (const name of evicted) {
		try { rmSync(join(currentName, name), { force: true }); } catch { /* 单个文件删不掉时跳过 */ }
	}
	if (evicted.length > 0) logInfo('logs', `当日日志体积超出 ${String(DAY_FOLDER_LIMIT_BYTES / (1024 * 1024))} MB 上限，按启动先后淘汰 ${String(evicted.length)} 个较旧的文件：${evicted.join('、')}`);
}

/**
 * 初始化日志：打开本次启动的文件并做一次清理。
 *
 * @returns 本次启动的日志文件路径。
 */
export function initLog(): string {
	const now = new Date();
	if (filePath === null) openFile(now);
	cleanLogs(now);
	return filePath ?? '';
}

/**
 * 测试用：重置模块状态。
 */
export function resetLogStateForTests(): void {
	flushSync();
	rootDir = null;
	filePath = null;
	dayDir = null;
	buffer = [];
}