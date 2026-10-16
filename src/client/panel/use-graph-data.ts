/**
 * 提交图数据：按选中仓库加载提交图与工作区，并对外暴露重载函数。
 *
 * 外部变更的检测分两条：文件改动事件驱动见 ./use-file-change-refresh.ts；本模块另有低频兜底
 * 轮询，覆盖事件窗口之外的外部写入。
 *
 * 一次重载向宿主发两次请求：提交图窗口，以及一次工作区快照（条目 + 分支/上游）。写操作后的
 * 对账复用同一参数的提交图窗口，避免重复取数；仓库切换与用户主动刷新时缓存作废。
 */
import React from 'react';
import { loadGraph, loadWorkingTreeSnapshot, type GraphData } from '../api/index.ts';
import { reportError } from './errors.ts';
import { entriesSignature } from './optimistic.ts';
import { FALLBACK_POLL_INTERVAL_MS, shouldFallbackRefresh } from './change-events.ts';
import { createCommitGraphCache } from '../graph/cache.ts';
import { isRepoBusy } from './busy.ts';

import type { BusyEntry, PanelState, RepoSync, Settings } from '../shared/types.ts';

/**
 * 提交图窗口缓存。
 *
 * 写操作后的对账会再次请求同一段窗口，而每个窗口都是一次完整的 git log；容量按「同时活跃的
 * 窗口数」定，覆盖首屏与最近几页。
 */
const graphWindows = createCommitGraphCache<GraphData>();

/**
 * 丢弃某个仓库的全部提交图窗口。
 *
 * 写操作与用户主动刷新后调用：引用与提交历史可能已经变化。
 *
 * @param repoPath - 仓库路径。
 * @returns 无。
 */
export function dropGraphWindows(repoPath: string): void {
	graphWindows.dropRepo(repoPath);
}

/**
 * 取一次提交图请求的缓存键。
 *
 * 键包含仓库路径与全部取数参数，参数任一项不同都视为不同窗口。
 *
 * @param repoPath - 仓库路径。
 * @param maxCommits - 本窗口的提交数上限。
 * @param skip - 从起点跳过的提交数。
 * @param settings - 当前设置。
 * @returns 缓存键。
 */
function graphKeyOf(repoPath: string, maxCommits: number, skip: number, settings: Settings): string {
	return graphWindows.keyOf(repoPath, {
		maxCommits,
		skip,
		ordering: settings.commitOrdering,
		showStashes: settings.showStashes,
		showTags: settings.showTags,
		showRemoteBranches: settings.showRemoteBranches,
		onlyFollowFirstParent: settings.onlyFollowFirstParent,
		includeCommitsMentionedByReflogs: settings.includeCommitsMentionedByReflogs,
	});
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

	/** 当前状态的引用：loadMore 在回调里读取已加载条数，避免把它列入依赖。 */
	const stateRef = React.useRef(state);
	stateRef.current = state;

	/** 上一次取图的仓库；与当前不同时窗口缓存一律作废。 */
	const loadedRepoRef = React.useRef<string | null>(null);

	/**
	 * 重新加载选中仓库的提交图与工作区。
	 *
	 * `full` 用于用户主动刷新与进入仓库：置加载态、清空该仓库的窗口缓存并重新取数。
	 * `reconcile` 用于写操作后的对账与后台自动刷新：保留现有数据、复用同参数的窗口，
	 * 避免列表闪烁与滚动位置丢失。
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
		// 换仓库后旧的窗口不再适用；用户主动刷新同样作废。
		if (mode === 'full' || loadedRepoRef.current !== workingTreePath) graphWindows.dropRepo(workingTreePath);
		loadedRepoRef.current = workingTreePath;
		if (mode === 'full') {
			setState((previous) => ({
				...previous, phase: 'loading', error: null, commits: [], entries: [], detail: null, selectedHash: null,
			}));
		} else {
			setState((previous) => ({ ...previous, error: null }));
		}
		try {
			// 只取第一个窗口：完整提交集驻留宿主，客户端按窗口分页取。
			const key = graphKeyOf(workingTreePath, maxCommits, 0, settings);
			let graph = mode === 'reconcile' ? graphWindows.get(key) : undefined;
			if (graph === undefined) {
				graph = await loadGraph(workingTreePath, {
					maxCommits,
					commitOrdering: settings.commitOrdering,
					showStashes: settings.showStashes,
					showTags: settings.showTags,
					showRemoteBranches: settings.showRemoteBranches,
					onlyFollowFirstParent: settings.onlyFollowFirstParent,
					includeCommitsMentionedByReflogs: settings.includeCommitsMentionedByReflogs,
					signal: controller.signal,
				});
				// 已中止的请求结果可能不完整，不写入缓存。
				if (!controller.signal.aborted) graphWindows.set(key, graph);
			}
			const snapshot = await loadWorkingTreeSnapshot(workingTreePath, controller.signal);
			if (generation !== generationRef.current) return;
			setState((previous) => ({
				...previous, phase: 'ready', error: null,
				commits: graph.commits, head: graph.head, more: graph.moreCommitsAvailable,
				remotes: graph.remotes, entries: snapshot.entries,
				detail: mode === 'full' ? null : previous.detail,
			}));
			// 领先/落后与条目来自同一次读取，不再单独请求。
			if (selectedId !== null) {
				setSyncById((previous) => new Map(previous).set(selectedId, {
					branch: snapshot.branch, upstream: snapshot.upstream,
					ahead: snapshot.ahead, behind: snapshot.behind,
				}));
			}
		} catch (error) {
			if (generation !== generationRef.current || controller.signal.aborted) return;
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, maxCommits, settings, hasWorkspace, selectedId, setSyncById]);

	/**
	 * 追加下一页。
	 *
	 * 偏移分页：下一页的起点是已加载条数。客户端保留从最新提交开始的完整前缀，因此向上滚动不需要
	 * 再取数 —— 反向取回只在「从头部淘汰」时才需要，而这里不做淘汰。窗口按参数缓存，回看已取过的
	 * 一段不再请求宿主。
	 *
	 * @returns 无。
	 */
	const loadMore = React.useCallback(async () => {
		if (workingTreePath === null) return;
		const skip = stateRef.current.commits.length;
		const generation = generationRef.current;
		try {
			const key = graphKeyOf(workingTreePath, maxCommits, skip, settings);
			let graph = graphWindows.get(key);
			if (graph === undefined) {
				graph = await loadGraph(workingTreePath, {
					maxCommits,
					skip,
					commitOrdering: settings.commitOrdering,
					showStashes: settings.showStashes,
					showTags: settings.showTags,
					showRemoteBranches: settings.showRemoteBranches,
					onlyFollowFirstParent: settings.onlyFollowFirstParent,
					includeCommitsMentionedByReflogs: settings.includeCommitsMentionedByReflogs,
				});
				graphWindows.set(key, graph);
			}
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
	 *
	 * 签名取自工作区快照：它与随后的重载读同一份数据，命中宿主侧同一份结果缓存。
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
					const snapshot = await loadWorkingTreeSnapshot(workingTreePath);
					if (cancelled) return;
					const signature = entriesSignature(snapshot.entries);
					const previous = lastSeen;
					seenCount = signature === previous ? seenCount + 1 : 1;
					lastSeen = signature;
					if (!shouldFallbackRefresh(signature, previous, loadedSigRef.current, seenCount)) return;
					// 外部写入可能已经产生提交，窗口缓存随之失效。
					graphWindows.dropRepo(workingTreePath);
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
