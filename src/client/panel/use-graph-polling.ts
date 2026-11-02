/**
 * 提交图的兜底轮询：覆盖事件窗口之外的写入（其它会话、其它工作区、编辑器、终端）。
 *
 * 页签可见时按快档跑，不可见时退回慢档以省资源，切换时重建定时器。页签不可见、上一次未结束、
 * 面板正忙时跳过。
 */
import React from 'react';
import { invalidateHostCache, loadWorkingTreeSnapshot, type WorkingTreeSnapshot } from '../api/index.ts';
import { entriesSignature } from './optimistic.ts';
import { fallbackPollMs, shouldFallbackRefresh, stableObservationsRequired } from './change-events.ts';
import { isRepoBusy } from './busy.ts';
import { beginBackground, endBackground } from './refresh-status.ts';
import { mergeSnapshot } from './graph-state.ts';
import { nextRefreshId } from './graph-window-cache.ts';
import type { BusyEntry, PanelState, Settings } from '../shared/types.ts';

/** 兜底轮询的入参。 */
export interface UseGraphPollingOptions {
	/** 当前工作树路径；未选中时为 null。 */
	readonly workingTreePath: string | null;
	/** 当前设置；只读取自动刷新开关与两档间隔。 */
	readonly settings: Settings;
	/** 进行中的操作记录：面板正忙时跳过本轮。 */
	readonly busyRef: React.MutableRefObject<readonly BusyEntry[]>;
	/** 面板状态写入器。 */
	readonly setState: React.Dispatch<React.SetStateAction<PanelState>>;
	/** 已加载提交图的 HEAD；取自最近一轮快照。 */
	readonly loadedHeadRef: React.MutableRefObject<string | null>;
	/** 只重取提交图并合并进现有状态。 */
	readonly reloadGraphOnly: (repo: string, snapshot: WorkingTreeSnapshot) => Promise<void>;
	/** 已加载的工作区签名：签名未变即不必重载。 */
	readonly loadedSignature: string;
}

/**
 * 订阅兜底轮询。
 *
 * 稳定判定按档位取所需观测次数：快档一次读到与已加载不同的签名即重载，慢档仍要求连续两次
 * 读到同一份签名，避免克隆等长时间写盘期间反复拉取整棵目录树。
 *
 * 签名取自工作区快照：它与随后的重载读同一份数据，命中宿主侧同一份结果缓存。
 *
 * @param options - 见 {@link UseGraphPollingOptions}。
 * @returns 无。
 */
export function useGraphPolling({
	workingTreePath, settings, busyRef, setState, loadedHeadRef, reloadGraphOnly, loadedSignature,
}: UseGraphPollingOptions): void {
	/** 已加载签名的当前值：effect 只在间隔变化时重建，读它必须走 ref。 */
	const loadedSigRef = React.useRef(loadedSignature);
	loadedSigRef.current = loadedSignature;

	React.useEffect(() => {
		if (!settings.autoRefresh || workingTreePath === null) return undefined;
		const cancelled = { current: false };
		let polling = false;
		let lastSeen = '';
		let seenCount = 0;
		let timerId: number | undefined;
		let timerInterval = 0;

		/** 已加载提交图的 HEAD：取自最近一轮快照。 */
		const loadedHead = (): string | null => loadedHeadRef.current;

		const poll = (): void => {
			if (cancelled.current || polling || document.visibilityState !== 'visible' || isRepoBusy(busyRef.current, workingTreePath)) return;
			polling = true;
			// 轮询读的也是工作区快照：与其它后台刷新同一套指示，取数期间给出反馈。
			setState((previous) => beginBackground(previous, 'entries'));
			void (async () => {
				try {
					// 轮询必须读当前值：命中宿主快照缓存会让签名永远不变，外部改动再也发现不了。
					const snapshot = await loadWorkingTreeSnapshot(workingTreePath, undefined, true, nextRefreshId());
					if (cancelled.current) return;
					const signature = entriesSignature(snapshot.entries);
					const previous = lastSeen;
					seenCount = signature === previous ? seenCount + 1 : 1;
					lastSeen = signature;
					const active = document.visibilityState === 'visible';
					const reload = active
						? seenCount >= stableObservationsRequired(true) && signature !== loadedSigRef.current
						: shouldFallbackRefresh(signature, previous, loadedSigRef.current, seenCount);
					if (!reload) return;
					/*
					 * 轮询读到的是**工作区**签名，它只说明有文件改动，不说明引用或提交历史变了。
					 * 区分两者的是 HEAD：只有 HEAD 移动（提交、检出、重置等）才需要重取提交图。
					 *
					 * 外部进程的提交不经过本插件的执行层，宿主收不到写事件、缓存不会自动作废，
					 * 因此这里显式请宿主作废该仓库的缓存。宿主缓存键已含 HEAD，作废是为覆盖
					 * 「HEAD 未动但引用变了」的情形（fetch、打标签等）。
					 *
					 * 只重取提交图：本轮快照已经在手，再走一次全量刷新会把它重读一遍。
					 *
					 * 纯文件改动只更新变更区：一律作废缓存会让每次保存都重取整页提交
					 * （大仓库数百毫秒），并让图形区整体重渲染。
					 */
					if (snapshot.head !== null && snapshot.head !== loadedHead()) {
						await invalidateHostCache(workingTreePath).catch(() => { /* 作废失败按未作废处理 */ });
						await reloadGraphOnly(workingTreePath, snapshot);
						return;
					}
					setState((state) => mergeSnapshot(endBackground(state, 'entries'), snapshot));
				} catch { /* 忽略兜底轮询失败 */ } finally {
					setState((state) => endBackground(state, 'entries'));
					polling = false;
				}
			})();
		};

		/** 按页签可见性取轮询间隔，间隔未变时保留原定时器。 */
		const schedule = (): void => {
			const active = document.visibilityState === 'visible';
			const next = fallbackPollMs(active ? settings.pollActiveSeconds : settings.pollIdleSeconds, active);
			if (timerId !== undefined && next === timerInterval) return;
			if (timerId !== undefined) window.clearInterval(timerId);
			timerInterval = next;
			timerId = window.setInterval(poll, next);
		};

		const onVisibilityChange = (): void => { schedule(); };
		document.addEventListener('visibilitychange', onVisibilityChange);
		schedule();
		return () => {
			cancelled.current = true;
			document.removeEventListener('visibilitychange', onVisibilityChange);
			if (timerId !== undefined) window.clearInterval(timerId);
		};
	}, [workingTreePath, reloadGraphOnly, settings.autoRefresh, settings.pollActiveSeconds, settings.pollIdleSeconds, busyRef, setState, loadedHeadRef]);
}
