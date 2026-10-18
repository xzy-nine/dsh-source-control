/**
 * 宿主仓库写事件驱动的自动刷新：订阅宿主事件流，别处的写操作也能即时反映。
 *
 * 事件驱动的文件改动刷新只订阅**当前会话**的事件窗口，因此别的会话、别的工作区或外部进程
 * 对同一仓库做的改动收不到任何信号。宿主把本进程里每次成功的仓库写操作推给所有面板，本 hook
 * 按仓库路径过滤后重载。
 *
 * 同一通道还推送仓库结构事件：工作树登记、子模块目录与 `.gitmodules` 的变化不经过执行层，
 * 收不到写事件，但会让仓库树多出或少掉节点，因此按工作区根过滤后请求重扫仓库树。
 *
 * 与文件改动刷新同样的门控：面板正忙时挂起，连续变更按冷却节流。
 */
import React from 'react';
import { matchesRepository, subscribeRepositoryWrites } from '../api/index.ts';
import { dropGraphWindows } from './use-graph-data.ts';
import { createRefreshScheduler } from './refresh-scheduler.ts';
import { isRepoBusy } from './busy.ts';
import type { BusyEntry } from '../shared/types.ts';

/** 仓库写事件订阅的入参。 */
export interface UseRepositoryWriteEventsOptions {
	/** 当前工作树路径；未选中时为 null。 */
	readonly workingTreePath: string | null;
	/** 仓库树所属的工作区根；无工作区时为 null。 */
	readonly cwd: string | null;
	/** 是否启用；关闭时不订阅。 */
	readonly enabled: boolean;
	/** 进行中的操作记录；目标仓库忙时挂起刷新。 */
	readonly busyRef: React.MutableRefObject<readonly BusyEntry[]>;
	/** 重载选中仓库的提交图与工作区。 */
	readonly refresh: () => Promise<void>;
	/** 重新枚举仓库树；结构事件命中工作区时调用。 */
	readonly rescan: () => void;
}

/**
 * 订阅宿主的仓库写事件并重载面板。
 *
 * 事件只带仓库路径，且可能来自任何会话；路径不在当前仓库内时忽略。面板自己发起的写操作也会
 * 收到一条事件，冷却与在途去重让这次重载与面板自身的对账刷新合并。
 *
 * 结构事件按工作区根过滤：命中即表示该工作区内的仓库树可能已变，重新枚举一次。重扫自身有
 * 30 秒冷却，因此连续的结构事件不会反复做全目录扫描。
 *
 * @param options - 见 {@link UseRepositoryWriteEventsOptions}。
 * @returns 无。
 */
export function useRepositoryWriteEvents({
	workingTreePath, cwd, enabled, busyRef, refresh, rescan,
}: UseRepositoryWriteEventsOptions): void {
	const refreshRef = React.useRef(refresh);
	refreshRef.current = refresh;
	const rescanRef = React.useRef(rescan);
	rescanRef.current = rescan;
	const targetRef = React.useRef(workingTreePath);
	targetRef.current = workingTreePath;
	const cwdRef = React.useRef(cwd);
	cwdRef.current = cwd;

	React.useEffect(() => {
		if (!enabled) return undefined;
		const scheduler = createRefreshScheduler({
			canRefresh: () => targetRef.current !== null,
			isBusy: () => isRepoBusy(busyRef.current, targetRef.current),
			// 写操作已改动该仓库：作废其提交图窗口与已知仓库信息，避免复用陈旧的一页。
			beforeRefresh: () => {
				const target = targetRef.current;
				if (target !== null) dropGraphWindows(target);
			},
			refresh: () => refreshRef.current(),
		});

		const unsubscribe = subscribeRepositoryWrites({
			onWrite: (event) => {
				const target = targetRef.current;
				if (target === null) return;
				if (!matchesRepository(target, event.repo)) return;
				scheduler.scheduleRefresh();
			},
			onTree: (event) => {
				const root = cwdRef.current;
				if (root === null || root === '') return;
				// 结构事件可能来自工作区内的任一仓库：命中即重扫整棵树。
				if (!matchesRepository(root, event.repo) && !matchesRepository(event.repo, root)) return;
				rescanRef.current();
			},
		});

		return () => {
			scheduler.dispose();
			unsubscribe();
		};
	}, [enabled, busyRef]);
}
