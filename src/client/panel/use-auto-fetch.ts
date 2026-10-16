/**
 * 定时抓取：启用后在窗口聚焦且面板空闲时按周期静默抓取远程。
 *
 * 与文件改动事件无关，是插件里唯一的定时网络操作。间隔取设置里的秒数，越界收拢。
 * 关闭开关或切换仓库时循环立即取消。
 */
import React from 'react';
import { AUTO_REFRESH_COOLDOWN_MS, autoFetchPeriodMs } from './change-events.ts';
import { isRepoBusy } from './busy.ts';
import type { BusyEntry } from '../shared/types.ts';

/** 等待聚焦/空闲的复核节拍（毫秒）。 */
const GATE_RETRY_MS = 1000;

/** 定时抓取的入参。 */
export interface UseAutoFetchOptions {
	/** 当前工作树路径；未选中时为 null。 */
	readonly workingTreePath: string | null;
	/** 是否启用。 */
	readonly enabled: boolean;
	/** 抓取间隔（秒）。 */
	readonly periodSeconds: number;
	/** 进行中的操作记录；目标仓库忙时等待。 */
	readonly busyRef: React.MutableRefObject<readonly BusyEntry[]>;
	/** 执行一次抓取。 */
	readonly fetch: (path: string) => Promise<void>;
	/**
	 * 抓取成功后的回调。
	 *
	 * 抓取会改动远程引用与领先/落后，调用方据此作废提交图缓存并重载：进入仓库后的第一次抓取
	 * 因此表现为「先用本地引用渲染，抓取完成后更新远程分支与领先/落后」。
	 */
	readonly onFetched?: (path: string) => void;
}

/**
 * 按周期抓取当前仓库的远程引用。
 *
 * 循环的第一轮在进入仓库后立即执行，因此面板先用本地引用渲染，抓取完成后经
 * {@link UseAutoFetchOptions.onFetched} 更新远程分支与领先/落后；此后按周期重复。
 *
 * @param options - 见 {@link UseAutoFetchOptions}。
 * @returns 无。
 */
export function useAutoFetch({ workingTreePath, enabled, periodSeconds, busyRef, fetch, onFetched }: UseAutoFetchOptions): void {
	const fetchRef = React.useRef(fetch);
	fetchRef.current = fetch;
	const onFetchedRef = React.useRef(onFetched);
	onFetchedRef.current = onFetched;

	React.useEffect(() => {
		if (!enabled || workingTreePath === null) return undefined;
		let cancelled = false;
		let timer: number | null = null;
		let wake: (() => void) | null = null;

		/** 睡一段时间；取消或外部唤醒时提前结束。 */
		const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
			wake = resolve;
			timer = window.setTimeout(() => { timer = null; wake = null; resolve(); }, ms);
		});

		/** 窗口是否聚焦。 */
		const focused = (): boolean => typeof document === 'undefined'
			|| (document.visibilityState === 'visible' && document.hasFocus());

		/** 等到窗口聚焦且面板空闲。 */
		const whenIdleAndFocused = async (): Promise<void> => {
			while (!cancelled && !(focused() && !isRepoBusy(busyRef.current, workingTreePath))) await sleep(GATE_RETRY_MS);
		};

		void (async () => {
			while (!cancelled) {
				await whenIdleAndFocused();
				if (cancelled) return;
				let fetched = false;
				try {
					await fetchRef.current(workingTreePath);
					fetched = true;
				} catch {
					/* 抓取失败不改设置；下一次周期重试 */
				}
				if (cancelled) return;
				// 抓取成功才回调：失败时引用没变，重载没有意义。
				if (fetched) onFetchedRef.current?.(workingTreePath);
				// 周期下限另有兜底：设置值异常时也不会退化成密集抓取。
				await sleep(Math.max(AUTO_REFRESH_COOLDOWN_MS, autoFetchPeriodMs(periodSeconds)));
			}
		})();

		return () => {
			cancelled = true;
			if (timer !== null) window.clearTimeout(timer);
			wake?.();
		};
	}, [workingTreePath, enabled, periodSeconds, busyRef]);
}
