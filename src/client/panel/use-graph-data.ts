/**
 * 提交图数据：按选中仓库加载提交图与工作区，并低频轮询外部变更。
 */
import React from 'react';
import { loadGraph, loadRepoSync, loadWorkingTree } from '../api.ts';
import { reportError } from './errors.ts';
import { shouldAutoRefresh } from './poll-gate.ts';
import type { PanelState, RepoSync, Settings, WorkingTreeEntry } from '../types.ts';

/**
 * 工作区变更的签名：路径与状态码逐条拼接，用于判断外部是否改动过工作区。
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
}

/**
 * 加载提交图与工作区，并低频轮询外部变更。
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
	const entriesSigRef = React.useRef('');
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

	/*
	 * 低频轮询：检测外部工作区变更。
	 *
	 * 判据是「连续两次轮询看到同一份签名」才认为变化已稳定。克隆等长时间写盘期间，
	 * 目标目录已出现但还不是仓库，外层仓库的 `git status --untracked-files=all` 会把
	 * 这棵正在增长的目录树整体列为未跟踪文件；只看「与上次不同」就会在克隆全程每 15 秒
	 * 触发一次完整重载（提交图 + 工作区 + 领先/落后），与服务端争抢资源。
	 * 稳定后才重载，且两次自动重载之间至少间隔 60 秒。
	 */
	entriesSigRef.current = entriesSignature(state.entries);
	busyRef.current = state.busy;
	React.useEffect(() => {
		if (workingTreePath === null) return undefined;
		let cancelled = false;
		let polling = false;
		let lastSeen = '';
		let lastAutoRefresh = 0;
		const intervalId = setInterval(() => {
			if (cancelled || polling || document.visibilityState !== 'visible' || busyRef.current) return;
			polling = true;
			void (async () => {
				try {
					const signature = entriesSignature(await loadWorkingTree(workingTreePath));
					if (cancelled) return;
					if (!shouldAutoRefresh({
						signature, lastSeen, loaded: entriesSigRef.current, lastRefreshAt: lastAutoRefresh, now: Date.now(),
					})) {
						lastSeen = signature;
						return;
					}
					lastSeen = signature;
					lastAutoRefresh = Date.now();
					void refresh();
				} catch { /* 忽略轮询失败 */ } finally {
					polling = false;
				}
			})();
		}, 15000);
		return () => { cancelled = true; clearInterval(intervalId); };
	}, [workingTreePath, refresh]);

	return { state, setState, refresh };
}
