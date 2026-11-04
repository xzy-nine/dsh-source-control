/**
 * 后台刷新的状态与提示：登记进行中的取数、给出进行中标志与相对时间文案。
 *
 * 与 `busy.ts` 的分工：忙碌记录用户发起的操作，会禁用控件；这里的后台刷新是面板自行取数
 * （事件驱动、宿主写事件、兜底轮询、定时抓取），不禁用任何控件，只用于界面指示。
 * 纯函数、无 React 依赖，可直接单测。
 */
import type { BackgroundFlags, BackgroundRefresh, BackgroundScope, PanelState } from '../shared/types.ts';

/** 相对时间与刷新告知的文案。文案归此处，调用方与测试都按引用取用。 */
export const REFRESH_TEXT = {
	/** 一分钟以内。 */
	justNow: '刚刚',
	/** 分钟档模板；`{n}` 为分钟数。 */
	minutesAgo: '{n} 分钟前',
	/** 小时档模板；`{n}` 为小时数。 */
	hoursAgo: '{n} 小时前',
	/** 天档模板；`{n}` 为天数。 */
	daysAgo: '{n} 天前',
	/** 月档模板；`{n}` 为月数。 */
	monthsAgo: '{n} 个月前',
	/** 年档模板；`{n}` 为年数。 */
	yearsAgo: '{n} 年前',
	/** 告知前缀。 */
	noticePrefix: '已更新：',
	/** 工作区计数的名称与单位。 */
	entriesLabel: '工作区',
	entriesUnit: '个改动',
	/** 提交图计数的名称与单位。 */
	commitsLabel: '提交图',
	commitsUnit: '个提交',
} as const;

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

/** 相对时间分档：单位与数量；`now` 档不带数量。 */
export interface RefreshTimeBucket {
	/** 分档单位。 */
	readonly unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years';
	/** 该档的数量；`now` 档为 0。 */
	readonly n: number;
}

/** 分档到文案模板的映射。 */
const TEMPLATE_OF: Readonly<Record<RefreshTimeBucket['unit'], string>> = {
	now: REFRESH_TEXT.justNow,
	minutes: REFRESH_TEXT.minutesAgo,
	hours: REFRESH_TEXT.hoursAgo,
	days: REFRESH_TEXT.daysAgo,
	months: REFRESH_TEXT.monthsAgo,
	years: REFRESH_TEXT.yearsAgo,
};

/**
 * 把相对时间分档代入文案模板。
 *
 * @param bucket - 分档与数量。
 * @returns 相对时间文案。
 */
export function refreshTextOf(bucket: RefreshTimeBucket): string {
	return TEMPLATE_OF[bucket.unit].replace('{n}', String(bucket.n));
}

/** 一次刷新的前后计数：条目数与提交数。 */
export interface RefreshCounts {
	readonly entries: number;
	readonly commits: number;
}

/**
 * 生成「某个计数变化」的文案。
 *
 * @param label - 计数所属区域。
 * @param unit - 计数单位。
 * @param delta - 变化量；正数带 `+`。
 * @returns 文案。
 */
function deltaText(label: string, unit: string, delta: number): string {
	return `${label} ${delta > 0 ? '+' : ''}${String(delta)} ${unit}`;
}

/**
 * 生成刷新结果的轻量告知文案。
 *
 * 只在计数发生变化时给出文案：后台刷新频繁，无变化的刷新不该打扰用户。
 * 用户主动刷新不调用本函数——结果就在眼前。两个计数都按变化量给出，不报总数。
 * 调用方经 {@link refreshNoticeSince} 先判两轮是否可比，本函数只负责文案。
 *
 * @param before - 刷新前的计数。
 * @param after - 刷新后的计数。
 * @returns 告知文案；无变化时为空串。
 */
export function refreshNoticeOf(before: RefreshCounts, after: RefreshCounts): string {
	const parts: string[] = [];
	if (after.entries !== before.entries) {
		parts.push(deltaText(REFRESH_TEXT.entriesLabel, REFRESH_TEXT.entriesUnit, after.entries - before.entries));
	}
	if (after.commits !== before.commits) {
		parts.push(deltaText(REFRESH_TEXT.commitsLabel, REFRESH_TEXT.commitsUnit, after.commits - before.commits));
	}
	if (parts.length === 0) return '';
	return `${REFRESH_TEXT.noticePrefix}${parts.join('，')}`;
}

/** 一次后台刷新完成时的基线。 */
export interface RefreshBaseline extends RefreshCounts {
	/** 完成时刻，与 `lastRefreshAt` 同源。 */
	readonly at: number;
	/** 取数范围：仓库、引用起点、提交窗口与影响提交行的设置项。 */
	readonly scope: string;
	/** 该轮数据是否已就绪；加载中的计数不参与比较。 */
	readonly ready: boolean;
}

/**
 * 生成两轮后台刷新之间的告知文案。
 *
 * 范围不同或任一轮未就绪时不给文案：那类差值来自换仓库、换引用起点、加载更多或仍在加载，
 * 不是「这一轮取回了新变化」。
 *
 * @param previous - 上一轮基线；首次进入为 null。
 * @param current - 本轮基线。
 * @returns 告知文案；不可比较或无变化时为空串。
 */
export function refreshNoticeSince(previous: RefreshBaseline | null, current: RefreshBaseline): string {
	if (previous === null || !previous.ready || !current.ready || previous.scope !== current.scope) return '';
	return refreshNoticeOf(previous, current);
}
