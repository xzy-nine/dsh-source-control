/**
 * 提交图数据：按选中仓库加载提交图与工作区，并对外暴露重载函数。
 *
 * 外部变更的检测分两条：文件改动事件驱动见 ./use-file-change-refresh.ts；本模块另有兜底轮询，
 * 覆盖事件窗口之外的写入，页签可见时按快档、不可见时按慢档。
 *
 * 一次重载向宿主发两次请求：提交图窗口，以及一次工作区快照（条目 + 分支/上游）。写操作后的
 * 对账复用同一参数的提交图窗口，避免重复取数；仓库切换与用户主动刷新时缓存作废。
 *
 * 仓库信息（远程、贮藏、当前分支名）只在首次进入该仓库时随提交图批取回，此后刷新随请求传入
 * 已知值；写操作后作废，使贮藏这类会变的字段重新读取。
 */
import React from 'react';
import { loadGraph, loadWorkingTreeSnapshot, type GraphData, type GraphStash, type WorkingTreeSnapshot } from '../api/index.ts';
import { reportError } from './errors.ts';
import { entriesSignature } from './optimistic.ts';
import { FALLBACK_POLL_ACTIVE_MS, FALLBACK_POLL_INTERVAL_MS, shouldFallbackRefresh, stableObservationsRequired } from './change-events.ts';
import { createCommitGraphCache } from '../graph/cache.ts';
import { isRepoBusy } from './busy.ts';
import { commitsListEqual, entriesEqual, remotesListEqual, uncommittedParentOf, withUncommittedCount } from './commit-diff.ts';

import type { BusyEntry, PanelState, Remote, RepoSync, Settings } from '../shared/types.ts';

/**
 * 提交图窗口缓存。
 *
 * 写操作后的对账会再次请求同一段窗口，而每个窗口都是一次完整的 git log；容量按「同时活跃的
 * 窗口数」定，覆盖首屏与最近几页。
 */
const graphWindows = createCommitGraphCache<GraphData>();

/** 一个仓库最近一次取到的仓库信息；供后续刷新随请求传入。 */
interface KnownRepoInfo {
	readonly remotes: Remote[];
	readonly stashes: GraphStash[];
	/** 当前分支名；分离头指针为 null。 */
	readonly branch: string | null;
}

/** 各仓库已知的仓库信息，键与提交图窗口缓存同一套归一化规则。 */
const knownRepoInfo = new Map<string, KnownRepoInfo>();

/**
 * 取仓库信息的键。
 *
 * @param repoPath - 仓库路径。
 * @returns 归一化后的键。
 */
function repoKeyOf(repoPath: string): string {
	return repoPath.replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 丢弃某个仓库的全部提交图窗口与已知仓库信息。
 *
 * 写操作与用户主动刷新后调用：引用、提交历史与贮藏可能已经变化。
 *
 * @param repoPath - 仓库路径。
 * @returns 无。
 */
export function dropGraphWindows(repoPath: string): void {
	graphWindows.dropRepo(repoPath);
	knownRepoInfo.delete(repoKeyOf(repoPath));
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
	/** 只重取工作区快照；供不改动引用与提交历史的工作区操作使用。 */
	readonly refreshEntries: () => Promise<void>;
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
/**
 * 把一个快照的分支、上游与领先/落后写回选中节点。
 *
 * 领先/落后与条目来自同一次读取，因此调用点都在拿到快照之后，不再单独请求。
 *
 * @param setSyncById - 节点同步状态的写入器。
 * @param selectedId - 选中节点 id；null 时不写。
 * @param snapshot - 本轮工作区快照。
 * @returns 无。
 */
function writeSync(
	setSyncById: React.Dispatch<React.SetStateAction<Map<string, RepoSync>>>,
	selectedId: string | null,
	snapshot: WorkingTreeSnapshot,
): void {
	if (selectedId === null) return;
	setSyncById((previous) => new Map(previous).set(selectedId, {
		branch: snapshot.branch, upstream: snapshot.upstream,
		ahead: snapshot.ahead, behind: snapshot.behind,
	}));
}

/**
 * 按一轮快照就地修正条目与未提交伪提交行。
 *
 * 条目未变时保持原引用：更改区的树计算按 `entries` 记忆化。父提交必须已在列表中，宿主不再负责
 * 这一判定，两处补出该行的调用点共用同一判据。
 *
 * @param previous - 当前状态。
 * @param snapshot - 本轮工作区快照。
 * @returns 新状态；条目未变时除 error 外保持原引用。
 */
function mergeSnapshot(previous: PanelState, snapshot: WorkingTreeSnapshot): PanelState {
	const entriesSame = entriesEqual(previous.entries, snapshot.entries);
	const parent = uncommittedParentOf(previous.commits, snapshot.head ?? previous.head);
	const commits = entriesSame
		? previous.commits
		: withUncommittedCount(previous.commits, snapshot.entries.length, parent);
	return {
		...previous, error: null,
		entries: entriesSame ? previous.entries : snapshot.entries,
		commits,
	};
}

export function useGraphData({
	workingTreePath, hasWorkspace, maxCommits, settings, selectedId, setSyncById,
}: UseGraphDataOptions): UseGraphDataResult {
	const [state, setState] = React.useState<PanelState>({
		phase: 'loading', error: null, commits: [], head: null, more: false,
		entries: [], selectedHash: null, detail: null, busy: [], remotes: [],
	});
	const generationRef = React.useRef(0);
	const controllerRef = React.useRef<AbortController | null>(null);
	/** 只取快照那一路的控制器；与提交图的控制器分开，避免作废在途的提交图请求。 */
	const entriesControllerRef = React.useRef<AbortController | null>(null);
	const busyRef = React.useRef<readonly BusyEntry[]>([]);

	/** 当前状态的引用：loadMore 在回调里读取已加载条数，避免把它列入依赖。 */
	const stateRef = React.useRef(state);
	stateRef.current = state;

	/** 上一次取图的仓库；与当前不同时窗口缓存一律作废。 */
	const loadedRepoRef = React.useRef<string | null>(null);
	/** 已加载提交图对应的 HEAD：取自同一轮快照，兜底轮询据此判断 HEAD 是否移动。 */
	const loadedHeadRef = React.useRef<string | null>(null);

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
		// 换仓库后旧的窗口与已知仓库信息不再适用；用户主动刷新同样作废。
		const repoChanged = loadedRepoRef.current !== workingTreePath;
		if (mode === 'full' || repoChanged) dropGraphWindows(workingTreePath);
		// 换仓库后旧 HEAD 不再适用；full 刷新沿用同仓库的旧值，直到本轮快照返回后写入。
		if (repoChanged) loadedHeadRef.current = null;
		loadedRepoRef.current = workingTreePath;
		if (mode === 'full') {
			setState((previous) => ({
				...previous, phase: 'loading', error: null, commits: [], entries: [], detail: null, selectedHash: null,
			}));
		} else {
			setState((previous) => ({ ...previous, error: null }));
		}
		try {
			/*
			 * 提交图与工作区快照互不依赖，两路并行：串行要等两组请求依次结束，并行只等最慢的一组。
			 * 提交图命中窗口缓存时只剩快照一路。
			 *
			 * 两路各自就绪即写入：工作区快照通常先回，更改区因此不必等提交图就能画出变更列表。
			 * 只写 `entries`，不改 `phase` —— 图形区按 `phase === 'loading'` 显示占位，提前置
			 * ready 会让它误显示「这个仓库还没有提交」。
			 *
			 * 只取第一个窗口：完整提交集驻留宿主，客户端按窗口分页取。
			 */
			const key = graphKeyOf(workingTreePath, maxCommits, 0, settings);
			const cached = mode === 'reconcile' ? graphWindows.get(key) : undefined;
			/*
			 * 仓库信息只在首次进入该仓库时取：已知的远程、贮藏与分支名随请求传入，宿主因此
			 * 不重取仓库信息批。取回后存入本仓库的已知值，供后续刷新复用；换仓库与写操作后
			 * 由 dropGraphWindows 一并作废。
			 */
			const known = knownRepoInfo.get(repoKeyOf(workingTreePath)) ?? null;
			const graphSource = cached ?? loadGraph(workingTreePath, {
				maxCommits,
				commitOrdering: settings.commitOrdering,
				showStashes: settings.showStashes,
				showTags: settings.showTags,
				showRemoteBranches: settings.showRemoteBranches,
				onlyFollowFirstParent: settings.onlyFollowFirstParent,
				includeCommitsMentionedByReflogs: settings.includeCommitsMentionedByReflogs,
				withRepoInfo: known === null,
				...(known === null ? {} : {
					remotes: known.remotes, stashes: known.stashes, branch: known.branch,
				}),
				signal: controller.signal,
			}).then((graph) => {
				// 已中止的响应可能不完整，不写入已知仓库信息。
				if (known === null && !controller.signal.aborted) {
					knownRepoInfo.set(repoKeyOf(workingTreePath), {
						remotes: graph.remotes, stashes: graph.stashes, branch: graph.head,
					});
				}
				return graph;
			});
			const snapshotSource = loadWorkingTreeSnapshot(workingTreePath, controller.signal).then((snapshot) => {
				if (generation !== generationRef.current || controller.signal.aborted) return snapshot;
				// 提交列表与快照同轮写入：HEAD 以快照为准，不从提交列表首条推导。
				loadedHeadRef.current = snapshot.head;
				/*
				 * 条目未变时保持原引用：更改区的树计算按 `entries` 记忆化。用户主动刷新不做短路，
				 * 它必须真正重建。
				 */
				setState((previous) => ({
					...previous, error: null,
					entries: mode === 'reconcile' && entriesEqual(previous.entries, snapshot.entries)
						? previous.entries
						: snapshot.entries,
				}));
				writeSync(setSyncById, selectedId, snapshot);
				return snapshot;
			});
			const [graph, snapshot] = await Promise.all([graphSource, snapshotSource]);
			// 已中止的请求结果可能不完整，不写入缓存。
			if (cached === undefined && !controller.signal.aborted) graphWindows.set(key, graph);
			if (generation !== generationRef.current) return;
			/*
			 * 未提交伪提交行由这里补出：宿主不再为它读一次工作区，提交图的返回时刻因此不取决于
			 * `git status`。条目数取同一轮的快照，与该行需要的父提交（HEAD）同源。
			 *
			 * 补出的行必须挂在提交列表里真实存在的父提交上：宿主列表与快照可能读自不同的时刻，
			 * HEAD 已移动时该行会指向一个不在列表里的哈希，泳道图在该处断线。
			 */
			const commits = withUncommittedCount(
				graph.commits, snapshot.entries.length,
				uncommittedParentOf(graph.commits, snapshot.head),
			);
			/*
			 * 对账刷新时数据未变则保持原数组引用：图形区与更改区按引用记忆化，换引用会让泳道布局
			 * 与变更树整体重算。用户主动刷新（`full`）不做短路：它必须真正重建。
			 */
			const keep = mode === 'reconcile';
			setState((previous) => {
				const commitsSame = keep
					&& previous.head === graph.head && previous.more === graph.moreCommitsAvailable
					&& commitsListEqual(previous.commits, commits);
				const entriesSame = keep && entriesEqual(previous.entries, snapshot.entries);
				const remotesSame = keep && remotesListEqual(previous.remotes, graph.remotes);
				return {
					...previous, phase: 'ready', error: null,
					commits: commitsSame ? previous.commits : commits,
					head: graph.head, more: graph.moreCommitsAvailable,
					remotes: remotesSame ? previous.remotes : graph.remotes,
					entries: entriesSame ? previous.entries : snapshot.entries,
					detail: mode === 'full' ? null : previous.detail,
				};
			});
		} catch (error) {
			if (generation !== generationRef.current || controller.signal.aborted) return;
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, maxCommits, settings, hasWorkspace, selectedId, setSyncById]);

	/**
	 * 只重取工作区快照并写入条目。
	 *
	 * 供不改动引用与提交历史的工作区操作（暂存、取消暂存、丢弃、忽略规则）使用：这类操作后提交
	 * 图必然不变，重取整页提交只是白等一次 git log。提交图窗口缓存因此保持有效。
	 *
	 * 未提交伪提交行上的改动数由条目数决定，这里按同一判据就地修正（含条目数由零变正时补出该行），
	 * 避免该行缺失或显示过期的数字。
	 *
	 * 不递增 `generationRef`、不 abort 在途请求：在途的提交图请求可能正把 `phase` 从 loading 推向
	 * ready，作废它会让图形区永久停在 loading（`phase` 只由 {@link refresh} 写入）。快照请求自带
	 * 控制器，只中止上一次快照。
	 *
	 * 与 {@link refresh} 的 `reconcile` 同一语义：不改 `phase`，不触碰 `detail` 与 `selectedHash`。
	 *
	 * @returns 无。
	 */
	const refreshEntries = React.useCallback(async () => {
		if (workingTreePath === null) return;
		// 只替换快照请求的控制器：提交图那一路（若有）继续跑完并自行收敛 phase。
		entriesControllerRef.current?.abort();
		const controller = new AbortController();
		entriesControllerRef.current = controller;
		const repo = workingTreePath;
		try {
			const snapshot = await loadWorkingTreeSnapshot(repo, controller.signal);
			// 换仓库后这次结果不再适用；同仓库的并发快照以最后一次为准。
			if (controller.signal.aborted || repo !== loadedRepoRef.current) return;
			setState((previous) => mergeSnapshot(previous, snapshot));
			writeSync(setSyncById, selectedId, snapshot);
		} catch (error) {
			if (controller.signal.aborted) return;
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, selectedId, setSyncById]);

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
				// 翻页不取仓库信息；已知的远程与贮藏随请求传入，省去宿主侧的枚举。
				const known = knownRepoInfo.get(repoKeyOf(workingTreePath)) ?? null;
				graph = await loadGraph(workingTreePath, {
					maxCommits,
					skip,
					commitOrdering: settings.commitOrdering,
					showStashes: settings.showStashes,
					showTags: settings.showTags,
					showRemoteBranches: settings.showRemoteBranches,
					onlyFollowFirstParent: settings.onlyFollowFirstParent,
					includeCommitsMentionedByReflogs: settings.includeCommitsMentionedByReflogs,
					...(known === null ? {} : {
						remotes: known.remotes, stashes: known.stashes, branch: known.branch,
					}),
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
	 * 兜底轮询：覆盖事件窗口之外的写入（其它会话、其它工作区、编辑器、终端），是事件驱动之外的
	 * 定期校对。页签可见时按快档跑，不可见时退回慢档以省资源，切换时重建定时器。
	 * 页签不可见、上一次未结束、面板正忙时跳过。
	 *
	 * 稳定判定按档位取所需观测次数：快档一次读到与已加载不同的签名即重载，慢档仍要求连续两次
	 * 读到同一份签名，避免克隆等长时间写盘期间反复拉取整棵目录树。
	 *
	 * 签名取自工作区快照：它与随后的重载读同一份数据，命中宿主侧同一份结果缓存。
	 */
	React.useEffect(() => {
		if (!settings.autoRefresh || workingTreePath === null) return undefined;
		let cancelled = false;
		let polling = false;
		let lastSeen = '';
		let seenCount = 0;
		let timerId: number | undefined;
		let timerInterval = 0;

		/** 已加载提交图的 HEAD：取自最近一轮快照。 */
		const loadedHead = (): string | null => loadedHeadRef.current;

		const poll = (): void => {
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
					const active = document.visibilityState === 'visible';
					const reload = active
						? seenCount >= stableObservationsRequired(true) && signature !== loadedSigRef.current
						: shouldFallbackRefresh(signature, previous, loadedSigRef.current, seenCount);
					if (!reload) return;
					/*
					 * 轮询读到的是**工作区**签名，它只说明有文件改动，不说明引用或提交历史变了。
					 * 区分两者的是 HEAD：只有 HEAD 移动（提交、检出、重置等）才需要重取提交图 ——
					 * 窗口缓存的键不含 HEAD，不作废会返回陈旧的一页。
					 *
					 * 纯文件改动只更新变更区：一律作废缓存会让每次保存都重取整页提交
					 * （大仓库数百毫秒），并让图形区整体重渲染。
					 */
					if (snapshot.head !== null && snapshot.head !== loadedHead()) {
						graphWindows.dropRepo(workingTreePath);
						/*
						 * 快照已带回当前分支名：外部检出会改分支，就地更新已知值即可，不必为一次
						 * 外部提交重取整批仓库信息。
						 */
						const repoKey = repoKeyOf(workingTreePath);
						const known = knownRepoInfo.get(repoKey);
						if (known !== undefined && known.branch !== snapshot.branch) {
							knownRepoInfo.set(repoKey, { ...known, branch: snapshot.branch });
						}
						void refresh();
						return;
					}
					setState((previous) => mergeSnapshot(previous, snapshot));
				} catch { /* 忽略兜底轮询失败 */ } finally {
					polling = false;
				}
			})();
		};

		/** 按页签可见性取轮询间隔，间隔未变时保留原定时器。 */
		const schedule = (): void => {
			const next = document.visibilityState === 'visible' ? FALLBACK_POLL_ACTIVE_MS : FALLBACK_POLL_INTERVAL_MS;
			if (timerId !== undefined && next === timerInterval) return;
			if (timerId !== undefined) window.clearInterval(timerId);
			timerInterval = next;
			timerId = window.setInterval(poll, next);
		};

		const onVisibilityChange = (): void => { schedule(); };
		document.addEventListener('visibilitychange', onVisibilityChange);
		schedule();
		return () => {
			cancelled = true;
			document.removeEventListener('visibilitychange', onVisibilityChange);
			if (timerId !== undefined) window.clearInterval(timerId);
		};
	}, [workingTreePath, refresh, settings.autoRefresh]);

	return { state, setState, refresh, refreshEntries, loadMore, busyRef };

}
