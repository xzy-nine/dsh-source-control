/**
 * 自动刷新的调度器：连续变更按冷却节流，面板正忙时挂起到空闲再执行。
 *
 * 事件驱动的两处刷新（会话事件窗口与宿主仓库写事件流）共用同一套节流与挂起规则，
 * 差异只在「能否刷新」与「重载前是否作废缓存」，由调用方以回调给出。
 */
import { AUTO_REFRESH_COOLDOWN_MS } from './change-events.ts';

/** 面板正忙时的复核间隔（毫秒）。 */
const BUSY_RETRY_MS = 1000;

/** 调度器的入参。 */
export interface RefreshSchedulerOptions {
	/** 当前是否具备刷新条件；为 false 时放弃本次刷新。 */
	readonly canRefresh: () => boolean;
	/** 目标仓库是否正忙；为 true 时挂起到空闲。 */
	readonly isBusy: () => boolean;
	/** 重载一次。 */
	readonly refresh: () => Promise<void>;
	/** 重载前的作废动作；省略时不做。 */
	readonly beforeRefresh?: () => void;
}

/** 调度器。 */
export interface RefreshScheduler {
	/** 立即尝试重载一次。 */
	readonly runRefresh: () => void;
	/** 冷却满后重载；冷却未满时挂起一次收尾。 */
	readonly scheduleRefresh: () => void;
	/** 停止调度并清掉挂起的定时器。 */
	readonly dispose: () => void;
}

/**
 * 创建一个刷新调度器。
 *
 * @param options - 见 {@link RefreshSchedulerOptions}。
 * @returns 调度器。
 */
export function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler {
	let disposed = false;
	let lastRefreshAt = 0;
	let timer: number | null = null;

	/** 重载一次；面板忙时挂起到空闲。 */
	const runRefresh = (): void => {
		if (disposed || !options.canRefresh()) return;
		if (options.isBusy()) {
			if (timer === null) timer = window.setTimeout(() => { timer = null; runRefresh(); }, BUSY_RETRY_MS);
			return;
		}
		lastRefreshAt = Date.now();
		options.beforeRefresh?.();
		void options.refresh().catch(() => { /* 重载失败由面板自身提示 */ });
	};

	/** 冷却满后再重载；冷却未满时挂起一次收尾。 */
	const scheduleRefresh = (): void => {
		const wait = AUTO_REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAt);
		if (wait > 0) {
			if (timer === null) timer = window.setTimeout(() => { timer = null; runRefresh(); }, wait);
			return;
		}
		runRefresh();
	};

	return {
		runRefresh,
		scheduleRefresh,
		dispose: () => {
			disposed = true;
			if (timer !== null) window.clearTimeout(timer);
		},
	};
}
