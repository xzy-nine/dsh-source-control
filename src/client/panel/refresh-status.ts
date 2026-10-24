/**
 * 后台刷新的状态与提示：登记进行中的取数、给出进行中标志与相对时间文案。
 *
 * 与 `busy.ts` 的分工：忙碌记录用户发起的操作，会禁用控件；这里的后台刷新是面板自行取数
 * （事件驱动、宿主写事件、兜底轮询、定时抓取），不禁用任何控件，只用于界面指示。
 * 纯函数、无 React 依赖，可直接单测。
 */
import type { BackgroundFlags, BackgroundRefresh, BackgroundScope, PanelState } from '../shared/types.ts';

/** 一分钟的毫秒数；相对时间文案按分档给出。 */
const MINUTE_MS = 60_000;

/** 一小时的毫秒数；超过一小时按「小时前」给出。 */
const HOUR_MS = 60 * MINUTE_MS;

/**
 * 登记一次后台刷新开始。
 *
 * 同一作用面只保留一份登记：并发刷新共用一条指示，结束按份移除。
 *
 * @param state - 当前面板状态。
 * @param scope - 作用面。
 * @param at - 开始时刻；省略取当前时间。
 * @returns 新面板状态；该作用面已在刷新时原样返回。
 */
export function beginBackground(state: PanelState, scope: BackgroundScope, at = Date.now()): PanelState {
	if (state.background.some((entry) => entry.scope === scope)) return state;
	return { ...state, background: [...state.background, { scope, at }] };
}

/**
 * 登记一次后台刷新结束。
 *
 * @param state - 当前面板状态。
 * @param scope - 作用面。
 * @param at - 完成时刻；写入 `lastRefreshAt`，供「上次刷新」文案使用。
 * @returns 新面板状态。
 */
export function endBackground(state: PanelState, scope: BackgroundScope, at = Date.now()): PanelState {
	const remaining = state.background.filter((entry) => entry.scope !== scope);
	const cleared = remaining.length === state.background.length;
	if (cleared && at <= state.lastRefreshAt) return state;
	return {
		...state,
		background: remaining,
		lastRefreshAt: at > state.lastRefreshAt ? at : state.lastRefreshAt,
	};
}

/**
 * 取各作用面的后台刷新进行中标志。
 *
 * @param entries - 后台刷新登记。
 * @returns 两个作用面各自的标志。
 */
export function backgroundFlagsOf(entries: readonly BackgroundRefresh[]): BackgroundFlags {
	return {
		graph: entries.some((entry) => entry.scope === 'graph'),
		entries: entries.some((entry) => entry.scope === 'entries'),
	};
}

/**
 * 把时刻格式化为相对时间文案。
 *
 * @param at - 目标时刻；0 表示从未刷新。
 * @param now - 当前时刻。
 * @returns 相对时间文案；从未刷新时为空串。
 */
export function lastRefreshText(at: number, now: number): string {
	if (at <= 0) return '';
	const diff = Math.max(0, now - at);
	if (diff < MINUTE_MS) return '刚刚';
	if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
	return `${Math.floor(diff / HOUR_MS)} 小时前`;
}

/** 一次刷新的前后计数：条目数与提交数。 */
export interface RefreshCounts {
	readonly entries: number;
	readonly commits: number;
}

/**
 * 生成刷新结果的轻量告知文案。
 *
 * 只在计数发生变化时给出文案：后台刷新频繁，无变化的刷新不该打扰用户。
 * 用户主动刷新不调用本函数——结果就在眼前。
 *
 * @param before - 刷新前的计数。
 * @param after - 刷新后的计数。
 * @returns 告知文案；无变化时为空串。
 */
export function refreshNoticeOf(before: RefreshCounts, after: RefreshCounts): string {
	const parts: string[] = [];
	if (after.entries !== before.entries) {
		parts.push(`工作区 ${after.entries} 个改动`);
	}
	if (after.commits !== before.commits) {
		const delta = after.commits - before.commits;
		parts.push(delta > 0 ? `提交图 +${delta} 个提交` : `提交图 ${delta} 个提交`);
	}
	if (parts.length === 0) return '';
	return `已更新：${parts.join('，')}`;
}
