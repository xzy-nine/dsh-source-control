/**
 * 定时抓取：启用后在窗口聚焦且面板空闲时按周期静默抓取远程。
 *
 * 与文件改动事件无关，是插件里唯一的定时网络操作。间隔取设置里的秒数，越界收拢。
 * 关闭开关或切换仓库时循环立即取消。
 */
import React from 'react';
import { AUTO_REFRESH_COOLDOWN_MS, autoFetchPeriodMs, nextAutoFetchPeriodMs } from './change-events.ts';
import { isRepoBusy } from './busy.ts';
import { normalizePath } from '../shared/path-key.ts';
import type { BusyEntry } from '../shared/types.ts';

/** 等待聚焦/空闲的复核节拍（毫秒）。 */
const GATE_RETRY_MS = 1000;

/**
 * 各仓库最近一次抓取的结束时刻。
 *
 * 模块级而不是实例内：侧栏页签按会话存储，切会话会让面板重新挂载、实例 ref 归零，切回来时
 * 会立刻再抓一轮。键同 `normalizePath`，与仓库树共用一种写法。
 */
const lastFetchAt = new Map<string, number>();

/**
 * 各仓库当前的抓取间隔毫秒数。
 *
 * 模块级而不是实例内：面板重新挂载时 effect 重建，局部变量会归零、退避级数丢失。
 * 键同 {@link normalizePath}。
 */
const fetchPeriodMs = new Map<string, number>();

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
	/** 执行一次抓取；返回引用是否发生变化。 */
	readonly fetch: (path: string) => Promise<boolean>;
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
 * 循环的第一轮在进入仓库后立即执行（同一仓库距上次抓取不足一个基础周期时先补足剩余时间），
 * 因此面板先用本地引用渲染，抓取完成后经 {@link UseAutoFetchOptions.onFetched} 更新远程分支
 * 与领先/落后。此后按 {@link nextAutoFetchPeriodMs} 给出的周期重复：无新引用时逐轮后延，
 * 拉到新引用即回到设置给出的基础周期。抓取抛错不改变周期。
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
		const cancelled = { current: false };
		/** 取消标志的取值函数；循环与循环体都经它读取。 */
		const isCancelled = (): boolean => cancelled.current;
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
			while (!isCancelled() && !(focused() && !isRepoBusy(busyRef.current, workingTreePath))) await sleep(GATE_RETRY_MS);
		};

		const key = normalizePath(workingTreePath);
		const baseMs = autoFetchPeriodMs(periodSeconds);
		/** 下一轮前的等待毫秒数；无新引用时逐轮后延。从模块级取上次的级数，挂载重置不归零。 */
		let periodMs = fetchPeriodMs.get(key) ?? baseMs;

		void (async () => {
			while (!isCancelled()) {
				await whenIdleAndFocused();
				if (isCancelled()) return;
				/*
				 * 切仓库、切会话都会重建本循环。距同一仓库上次抓取不足一个基础周期时先补足：
				 * 否则来回切换会各触发一次完整抓取。
				 */
				const since = Date.now() - (lastFetchAt.get(key) ?? 0);
				if (since < baseMs) {
					await sleep(baseMs - since);
					if (isCancelled()) return;
				}
				let changed = false;
				try {
					changed = await fetchRef.current(workingTreePath);
				} catch {
					/* 抓取失败不改变间隔：失败不等于远端没有新引用，按原周期重试 */
					await sleep(periodMs);
					continue;
				}
				if (isCancelled()) return;
				lastFetchAt.set(key, Date.now());
				// 只有引用确实变化才回调：失败或远端没有新提交时重载拿到的还是旧数据。
				if (changed) onFetchedRef.current?.(workingTreePath);
				periodMs = nextAutoFetchPeriodMs(periodMs, baseMs, changed);
				fetchPeriodMs.set(key, periodMs);
				// 周期下限另有兜底：设置值异常时也不会退化成密集抓取。
				await sleep(Math.max(AUTO_REFRESH_COOLDOWN_MS, periodMs));
			}
		})();

		return () => {
			cancelled.current = true;
			if (timer !== null) window.clearTimeout(timer);
			wake?.();
		};
	}, [workingTreePath, enabled, periodSeconds, busyRef]);
}
