/**
 * 提交图数据：按选中仓库加载提交图与工作区，并对外暴露重载函数。
 *
 * 外部变更的检测分两条：文件改动事件驱动见 ./use-file-change-refresh.ts；本模块另有低频兜底
 * 轮询，覆盖事件窗口之外的外部写入。
 */
import React from 'react';
import { loadGraph, loadRepoSync, loadWorkingTree } from '../api/index.ts';
import { reportError } from './errors.ts';
import { FALLBACK_POLL_INTERVAL_MS, shouldFallbackRefresh } from './change-events.ts';
import { isRepoBusy } from './busy.ts';

import type { BusyEntry, PanelState, RepoSync, Settings, WorkingTreeEntry } from '../shared/types.ts';

/**
 * 工作区变更的签名：路径与状态码逐条拼接，用于兜底轮询比对。
 *
 * @param entries - 工作区条目。
 * @returns 签名文本。
 */
function entriesSignature(entries: readonly WorkingTreeEntry[]): string {
	return entries.map((entry) => `${entry.path}:${entry.index}${entry.worktree}`).join('\n');
}


/** 提交图数据 hook 的入参。 */
export interface UseGraphDataOptions {
	/** 当前工作树路径；未选中时为 null。 */
	readonly workingTreePath: string | null;
	/** 会话是否有工作区。 */
	readonly hasWorkspace: boolean;
	/** 已加载的提交数上限。 */
	readonly maxCommits: number;
	/** 当前设置。 */
	readonly settings: Settings;
	/** 选中节点 id，用于回写领先/落后。 */
	readonly selectedId: string | null;
	/** 回写某个节点的领先/落后。 */
	readonly setSyncById: React.Dispatch<React.SetStateAction<Map<string, RepoSync>>>;
}

/** 提交图数据 hook 的返回值。 */
export interface UseGraphDataResult {
	/** 面板状态。 */
	readonly state: PanelState;
	/** 面板状态写入器。 */
	readonly setState: React.Dispatch<React.SetStateAction<PanelState>>;
	/** 重新加载选中仓库的提交图与工作区。 */
	readonly refresh: (mode?: 'full' | 'reconcile') => Promise<void>;
	/** 追加下一个提交窗口。 */
	readonly loadMore: () => Promise<void>;
	/** 取回更早的一段（窗口头部之前）；裁头后回看用。 */
	/** 进行中的操作记录；后台刷新据此判断目标仓库是否繁忙。 */
	readonly busyRef: React.MutableRefObject<readonly BusyEntry[]>;
}

/**
 * 加载提交图与工作区。
 *
 * @param options - 见 {@link UseGraphDataOptions}。
 * @returns 面板状态与刷新函数。
 */
export function useGraphData({
	workingTreePath, hasWorkspace, maxCommits, settings, selectedId, setSyncById,
}: UseGraphDataOptions): UseGraphDataResult {
	const [state, setState] = React.useState<PanelState>({
		phase: 'loading', error: null, commits: [], head: null, more: false,
		entries: [], selectedHash: null, detail: null, busy: [], remotes: [],
	});
	const generationRef = React.useRef(0);
	const controllerRef = React.useRef<AbortController | null>(null);
	const busyRef = React.useRef<readonly BusyEntry[]>([]);
	/**
	 * 已留存提交之前的泳道状态。
	 *
	 * 裁头后保留的行若从空泳道重算会整体左移，用该状态续算才能与裁之前一致；
	 * 只加载首页时为 null。
	 */
	/** 同一份状态的 ref：loadMore 内读种子，避免把它列入依赖。 */

	/** 当前状态的引用：loadMore 在回调里读取已加载条数，避免把它列入依赖。 */
	const stateRef = React.useRef(state);
	stateRef.current = state;

	/**
	 * 重新加载选中仓库的提交图与工作区。
	 *
	 * `full` 用于用户主动刷新与进入仓库：置加载态、先清空再填充。`reconcile` 用于写操作后的
	 * 对账与后台自动刷新：保留现有数据，只把新结果合并进去，避免列表闪烁与滚动位置丢失。
	 *
	 * @param mode - 刷新模式。
	 * @returns 无。
	 */
	const refresh = React.useCallback(async (mode: 'full' | 'reconcile' = 'reconcile') => {
		if (workingTreePath === null) {
			setState((previous) => ({
				...previous, phase: hasWorkspace ? 'loading' : 'no-workspace', error: null,
			}));
			return;
		}
		const generation = generationRef.current + 1;
		generationRef.current = generation;
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;
		if (mode === 'full') {
			setState((previous) => ({
				...previous, phase: 'loading', error: null, commits: [], entries: [], detail: null, selectedHash: null,
			}));
		} else {
			setState((previous) => ({ ...previous, error: null }));
		}
		try {
			// 只取第一个窗口：完整提交集驻留宿主，客户端按窗口分页取。
			const graph = await loadGraph(workingTreePath, {
				maxCommits,
				commitOrdering: settings.commitOrdering,
				showStashes: settings.showStashes,
				showTags: settings.showTags,
				showRemoteBranches: settings.showRemoteBranches,
				onlyFollowFirstParent: settings.onlyFollowFirstParent,
				includeCommitsMentionedByReflogs: settings.includeCommitsMentionedByReflogs,
				signal: controller.signal,
			});
			const entries = await loadWorkingTree(workingTreePath, controller.signal);
			if (generation !== generationRef.current) return;
			setState((previous) => ({
				...previous, phase: 'ready', error: null,
				commits: graph.commits, head: graph.head, more: graph.moreCommitsAvailable,
				// 重载后回到首屏：已裁计数归零。
				remotes: graph.remotes, entries,
				detail: mode === 'full' ? null : previous.detail,
			}));
			// 刷新选中仓库的领先/落后状态
			try {
				const sync = await loadRepoSync(workingTreePath, controller.signal);
				if (generation === generationRef.current && selectedId !== null) {
					setSyncById((previous) => new Map(previous).set(selectedId, sync));
				}
			} catch { /* 忽略 sync 刷新失败 */ }
		} catch (error) {
			if (generation !== generationRef.current || controller.signal.aborted) return;
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, maxCommits, settings, hasWorkspace, selectedId, setSyncById]);

	/**
	 * 追加下一页。
	 *
	 * 偏移分页：下一页的起点是已加载条数。客户端保留从最新提交开始的完整前缀，因此向上滚动不需要
	 * 再取数 —— 反向取回只在「从头部淘汰」时才需要，而这里不做淘汰。
	 *
	 * @returns 无。
	 */
	const loadMore = React.useCallback(async () => {
		if (workingTreePath === null) return;
		const skip = stateRef.current.commits.length;
		const generation = generationRef.current;
		try {
			const graph = await loadGraph(workingTreePath, {
				maxCommits,
				skip,
				commitOrdering: settings.commitOrdering,
				showStashes: settings.showStashes,
				showTags: settings.showTags,
				showRemoteBranches: settings.showRemoteBranches,
				onlyFollowFirstParent: settings.onlyFollowFirstParent,
				includeCommitsMentionedByReflogs: settings.includeCommitsMentionedByReflogs,
			});
			if (generation !== generationRef.current) return;
			setState((current) => {
				const known = new Set(current.commits.map((commit) => commit.hash));
				return {
					...current,
					commits: [...current.commits, ...graph.commits.filter((commit) => !known.has(commit.hash))],
					more: graph.moreCommitsAvailable,
				};
			});
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, maxCommits, settings]);

	React.useEffect(() => { void refresh(); }, [refresh]);
	React.useEffect(() => { busyRef.current = state.busy; }, [state.busy]);

	// 已加载的工作区签名：兜底轮询据此判断是否需要重载。
	const loadedSigRef = React.useRef('');
	loadedSigRef.current = entriesSignature(state.entries);

	/*
	 * 兜底轮询：覆盖事件窗口之外的外部写入（编辑器、终端、其它进程），是事件驱动之外的定期校对，
	 * 间隔远大于事件响应的及时性要求。页签不可见、上一次未结束、面板正忙时跳过；连续两次读到
	 * 同一份签名才重载，避免克隆等长时间写盘期间反复拉取整棵目录树。
	 */
	React.useEffect(() => {
		if (!settings.autoRefresh || workingTreePath === null) return undefined;
		let cancelled = false;
		let polling = false;
		let lastSeen = '';
		let seenCount = 0;
		const intervalId = window.setInterval(() => {
			if (cancelled || polling || document.visibilityState !== 'visible' || isRepoBusy(busyRef.current, workingTreePath)) return;
			polling = true;
			void (async () => {
				try {
					const signature = entriesSignature(await loadWorkingTree(workingTreePath));
					if (cancelled) return;
					const previous = lastSeen;
					seenCount = signature === previous ? seenCount + 1 : 1;
					lastSeen = signature;
					if (!shouldFallbackRefresh(signature, previous, loadedSigRef.current, seenCount)) return;
					void refresh();
				} catch { /* 忽略兜底轮询失败 */ } finally {
					polling = false;
				}
			})();
		}, FALLBACK_POLL_INTERVAL_MS);
		return () => { cancelled = true; window.clearInterval(intervalId); };
	}, [workingTreePath, refresh, settings.autoRefresh]);

	return { state, setState, refresh, loadMore, busyRef };

}