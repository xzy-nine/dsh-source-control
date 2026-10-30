/**
 * 日志目录的命名、排序与清理判据（纯函数）。
 *
 * 目录布局：`<root>/<YYYY-MM-DD>/logcat-<YYYYMMDD>-<HHmmssSSS>-<pid>.log`。
 * 日文件夹名带日期，文件名带启动时刻，因此同一文件夹内按文件名升序即为启动先后。
 */

/** 单个日文件夹的体积上限（字节）。 */
export const DAY_FOLDER_LIMIT_BYTES = 15 * 1024 * 1024;

/** 日志保留天数：含当天在内的天数。 */
export const LOG_RETENTION_DAYS = 15;

/** 日文件夹名：`YYYY-MM-DD`。 */
const DAY_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 一个日志文件的名称与体积。 */
export interface LogFileEntry {
	readonly name: string;
	readonly size: number;
}

/** 补零到两位。 */
const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * 本地日期键：`YYYY-MM-DD`。
 *
 * @param time - 时间。
 * @returns 日期键。
 */
export function dayFolderName(time: Date): string {
	return `${time.getFullYear()}-${pad2(time.getMonth() + 1)}-${pad2(time.getDate())}`;
}

/**
 * 一次启动对应的日志文件名。
 *
 * 名称按启动时刻字典序排列，与启动先后一致。
 *
 * @param startup - 启动时间。
 * @param pid - 进程 id。
 * @returns 文件名。
 */
export function logFileName(startup: Date, pid: number): string {
	const date = `${startup.getFullYear()}${pad2(startup.getMonth() + 1)}${pad2(startup.getDate())}`;
	const clock = `${pad2(startup.getHours())}${pad2(startup.getMinutes())}${pad2(startup.getSeconds())}${String(startup.getMilliseconds()).padStart(3, '0')}`;
	return `logcat-${date}-${clock}-${String(pid)}.log`;
}

/**
 * 判断一个目录名是否是日文件夹名。
 *
 * @param name - 目录名。
 * @returns 是日文件夹名时为 true。
 */
export function isDayFolderName(name: string): boolean {
	return DAY_FOLDER_PATTERN.test(name);
}

/**
 * 按启动先后排列日志文件（文件名升序）。
 *
 * @param files - 文件列表。
 * @returns 新数组。
 */
export function orderLogFiles<T extends { readonly name: string }>(files: readonly T[]): T[] {
	return [...files].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * 日文件夹超限时的淘汰名单。
 *
 * 从最新文件向前累计体积，超出上限的旧文件进入淘汰名单；`keep` 中的文件不参与累计、
 * 也不被淘汰（当前进程正在写入的那一份）。
 *
 * @param files - 该日文件夹内的文件。
 * @param limitBytes - 体积上限（字节）。
 * @param keep - 需要保留的文件名。
 * @returns 待淘汰的文件名，按启动先后排列。
 */
export function planDayEvictions(files: readonly LogFileEntry[], limitBytes: number, keep: readonly string[]): string[] {
	const kept = new Set(keep);
	const ordered = orderLogFiles(files).filter((file) => !kept.has(file.name));
	const survivors = new Set<string>();
	let budget = limitBytes;
	for (let index = ordered.length - 1; index >= 0; index -= 1) {
		const file = ordered[index];
		budget -= Math.max(0, file.size);
		if (budget >= 0) survivors.add(file.name);
	}
	return ordered.filter((file) => !survivors.has(file.name)).map((file) => file.name);
}

/**
 * 已过保留期的日文件夹名单。
 *
 * 当天算第一天：保留 `retentionDays` 天，日期早于截止日的文件夹整体删除。
 *
 * @param names - 目录名列表。
 * @param now - 当前时间。
 * @param retentionDays - 保留天数。
 * @returns 待删除的目录名。
 */
export function planExpiredDayFolders(names: readonly string[], now: Date, retentionDays: number = LOG_RETENTION_DAYS): string[] {
	const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	cutoff.setDate(cutoff.getDate() - Math.max(0, retentionDays - 1));
	const cutoffKey = dayFolderName(cutoff);
	return names.filter((name) => isDayFolderName(name) && name < cutoffKey);
}
