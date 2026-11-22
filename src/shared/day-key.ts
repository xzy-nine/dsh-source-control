/**
 * 本地日期的换算：日志目录按 `YYYY-MM-DD` 分日，比较用字符串即可。
 *
 */
import { pad2 } from './pad-number.js';

/**
 * 本地日期键：`YYYY-MM-DD`。
 *
 * @param time - 时间。
 * @returns 日期键。
 */
export function dayKey(time: Date): string {
	return `${String(time.getFullYear())}-${pad2(time.getMonth() + 1)}-${pad2(time.getDate())}`;
}

/**
 * 最近 N 天（含当天）的日期下界。
 *
 * 当天算第一天，因此减去 `days - 1`。
 *
 * @param now - 当前时间。
 * @param days - 天数；小于 1 时按 1 处理。
 * @returns 下界的日期键。
 */
export function cutoffDayKey(now: Date, days: number): string {
	const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	cutoff.setDate(cutoff.getDate() - Math.max(0, days - 1));
	return dayKey(cutoff);
}
