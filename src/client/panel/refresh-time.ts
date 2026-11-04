/**
 * 「上次刷新」的相对时间文案：分档取自 ui-primitives，措辞取 `refresh-status.ts` 的模板。
 *
 * 分档与宿主其它界面共用同一份实现，本模块只把分档代入文案。
 */
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives';
import { refreshTextOf } from './refresh-status.ts';

/**
 * 把时刻格式化为相对时间文案。
 *
 * @param at - 目标时刻；0 表示从未刷新。
 * @param now - 当前时刻。
 * @returns 相对时间文案；从未刷新时为空串。
 */
export function lastRefreshText(at: number, now: number): string {
	if (at <= 0) return '';
	return refreshTextOf(relativeTime(at, now));
}
