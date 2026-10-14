/**
 * 提交图数据：按选中仓库加载提交图与工作区，并对外暴露重载函数。
 *
 * 外部变更的检测分两条：文件改动事件驱动见 ./use-file-change-refresh.ts；本模块另有低频兜底
 * 轮询，覆盖事件窗口之外的外部写入。
 */
import React from 'react';
import { loadGraph, loadRepoSync, loadWorkingTree } from '../api.ts';
import { reportError } from './errors.ts';
import { FALLBACK_POLL_INTERVAL_MS, shouldFallbackRefresh } from './change-events.ts';
import type { PanelState, RepoSync, Settings, WorkingTreeEntry } from '../types.ts';

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
	readonly refresh: () => Promise<void>;
	/** 面板忙碌标志；自动刷新据此挂起。 */
	readonly busyRef: React.MutableRefObject<boolean>;
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
		entries: [], selectedHash: null, detail: null, busy: false, remotes: [],
	});
	const generationRef = React.useRef(0);
	const controllerRef = React.useRef<AbortController | null>(null);
	const busyRef = React.useRef(false);

	/** 重新加载选中仓库的提交图与工作区。 */
	const refresh = React.useCallback(async () => {
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
		setState((previous) => ({ ...previous, phase: 'loading', error: null }));
		try {
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
				remotes: graph.remotes, entries,
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
		if (workingTreePath === null) return undefined;
		let cancelled = false;
		let polling = false;
		let lastSeen = '';
		let seenCount = 0;
		const intervalId = window.setInterval(() => {
			if (cancelled || polling || document.visibilityState !== 'visible' || busyRef.current) return;
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
	}, [workingTreePath, refresh]);

	return { state, setState, refresh, busyRef };
}
