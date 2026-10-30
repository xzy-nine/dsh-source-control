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
import { invalidateHostCache, loadGraph, loadWorkingTreeSnapshot, logClient, type WorkingTreeSnapshot } from '../api/index.ts';
import { reportError } from './errors.ts';
import { entriesSignature } from './optimistic.ts';
import { fallbackPollMs, shouldFallbackRefresh, stableObservationsRequired } from './change-events.ts';
import { isRepoBusy } from './busy.ts';
import { beginBackground, endBackground } from './refresh-status.ts';
import {
	branchNamesEqual, commitsListEqual, entriesEqual, logCommitCountOf, mergeCommits, mergeEntries,
	remotesListEqual, uncommittedParentOf, withUncommittedCount,
} from './commit-diff.ts';
import { DEFAULT_REF_FILTER, filterBranchesOf } from './refs.ts';
import type { RefFilter } from './refs.ts';

import type { BusyEntry, Commit, PanelState, Remote, RepoSync, Settings } from '../shared/types.ts';
import type { GraphStash, GraphData } from '../api/index.ts';

/**
 * 各仓库最近一次渲染的面板状态。
 *
 * 这是**渲染态**，不是数据缓存：数据缓存（提交图窗口、仓库信息、工作区快照）在宿主内存里，
 * 见 `source-control/host-cache.ts`。这里只记住界面最后一次画出来的结果，供面板重新挂载时
 * 首帧呈现——侧栏页签按会话存储，切换会话会让面板整体重新挂载。
 */
const lastPanelState = new Map<string, PanelState>();

/**
 * 各仓库最近一次已加载的提交数上限。
 *
 * 重新挂载时 `maxCommits` 会回到初始值，宿主缓存键随之变化、命中不到已取过的窗口。
 * 这是与渲染态配套的取数参数，因此与它一起留在客户端。
 */
const lastMaxCommits = new Map<string, number>();

/** 状态缓存的仓库数上限；超出按插入序淘汰最旧。 */
const LAST_PANEL_STATE_LIMIT = 8;

/**
 * 取一个仓库最近一次已加载的提交数上限。
 *
 * @param repoPath - 仓库路径。
 * @returns 提交数上限；从未加载过时为 undefined。
 */
export function rememberedMaxCommits(repoPath: string): number | undefined {
	return lastMaxCommits.get(repoKeyOf(repoPath));
}

/**
 * 记下一个仓库最近一次渲染的面板状态。
 *
 * @param repoPath - 仓库路径。
 * @param state - 面板状态。
 * @param maxCommits - 该状态对应的提交数上限。
 * @returns 无。
 */
function rememberPanelState(repoPath: string, state: PanelState, maxCommits: number): void {
	const key = repoKeyOf(repoPath);
	lastPanelState.delete(key);
	lastPanelState.set(key, state);
	lastMaxCommits.delete(key);
	lastMaxCommits.set(key, maxCommits);
	while (lastPanelState.size > LAST_PANEL_STATE_LIMIT) {
		const oldest = lastPanelState.keys().next();
		if (oldest.done === true) break;
		lastPanelState.delete(oldest.value);
		lastMaxCommits.delete(oldest.value);
	}
}

/**
 * 取一个仓库最近一次渲染的面板状态。
 *
 * @param repoPath - 仓库路径。
 * @returns 面板状态；从未渲染过时为 undefined。
 */
function rememberedPanelState(repoPath: string): PanelState | undefined {
	return lastPanelState.get(repoKeyOf(repoPath));
}

/**
 * 最近一次取数的仓库（模块级）。
 *
 * 不能用实例内的 ref：侧栏页签按会话存储，切换会话会让面板重新挂载，实例 ref 必为 null，
 * 于是每次挂载都会被当成「换了仓库」而丢弃渲染态。
 */
let activeGraphRepo: string | null = null;

/** 一个仓库已知的远程与贮藏：随刷新请求传给宿主，宿主因此不重取仓库信息批。 */
interface KnownRepoInfo {
	readonly remotes: readonly Remote[];
	readonly stashes: readonly GraphStash[];
}

/**
 * 各仓库已知的远程与贮藏（模块级）。
 *
 * 首次进入仓库时随提交图请求一并取回（`withRepoInfo`），此后刷新把它们传回宿主：宿主据此
 * 跳过仓库信息批，一次刷新少起一组子进程。写操作会改变贮藏与远程，因此由
 * {@link dropGraphWindows} 作废。键同 {@link repoKeyOf}。
 */
const knownRepoInfo = new Map<string, KnownRepoInfo>();

/** 已知仓库信息的条目上限；超出按插入序淘汰最旧。 */
const KNOWN_REPO_INFO_LIMIT = 8;

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
 * 记下一个仓库已知的远程与贮藏。
 *
 * @param repoPath - 仓库路径。
 * @param info - 远程与贮藏。
 * @returns 无。
 */
function rememberRepoInfo(repoPath: string, info: KnownRepoInfo): void {
	const key = repoKeyOf(repoPath);
	knownRepoInfo.delete(key);
	knownRepoInfo.set(key, info);
	while (knownRepoInfo.size > KNOWN_REPO_INFO_LIMIT) {
		const oldest = knownRepoInfo.keys().next();
		if (oldest.done === true) break;
		knownRepoInfo.delete(oldest.value);
	}
}

/**
 * 取一个仓库已知的远程与贮藏。
 *
 * @param repoPath - 仓库路径。
 * @returns 已知值；从未取过时为 undefined。
 */
function rememberedRepoInfo(repoPath: string): KnownRepoInfo | undefined {
	return knownRepoInfo.get(repoKeyOf(repoPath));
}

/**
 * 丢弃某个仓库的渲染态与已知仓库信息。
 *
 * 写操作与用户主动刷新后调用：界面必须按新数据重建。数据缓存由宿主在写操作后自行作废，
 * 这里不需要通知宿主。
 *
 * @param repoPath - 仓库路径。
 * @returns 无。
 */
export function dropGraphWindows(repoPath: string): void {
	const key = repoKeyOf(repoPath);
	lastPanelState.delete(key);
	lastMaxCommits.delete(key);
	// 贮藏与远程随写操作变化，作废后下一次取数重新带回。
	knownRepoInfo.delete(key);
}

/**
 * 只丢弃一个仓库的渲染态。
 *
 * 引用筛选变化只换提交窗口，远程与贮藏不受影响：整表作废会让下一次取数多带一次仓库信息批。
 *
 * @param repoPath - 仓库路径。
 * @returns 无。
 */
export function dropRenderedGraph(repoPath: string): void {
	lastPanelState.delete(repoKeyOf(repoPath));
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
	/** 引用筛选：决定提交图的取数起点，与 VS Code 图形视图同一模型；省略时按自动。 */
	readonly filter?: RefFilter;
	/** 自动筛选的分叉来源：带所属分支，供本 hook 校验是否与当前分支匹配。 */
	readonly branchBase?: { readonly branch: string; readonly base: string | null } | null;
	/** 首帧可用的当前分支与上游（仓库树快照提供），避免首次进入少带筛选条件多取一次。 */
	readonly headHint?: string | null;
	readonly upstreamHint?: string | null;
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
	/** 取数范围：仓库、引用起点、提交窗口与影响提交行的设置项。范围相同的两轮提交列表才可比。 */
	readonly graphScope: string;
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
	setSyncById((previous) => {
		const current = previous.get(selectedId);
		/* 四项都未变时返回原 Map：仓库行按该引用记忆化，每轮换新 Map 会让它跟着重渲染。 */
		if (current !== undefined
			&& current.branch === snapshot.branch && current.upstream === snapshot.upstream
			&& current.ahead === snapshot.ahead && current.behind === snapshot.behind) {
			return previous;
		}
		return new Map(previous).set(selectedId, {
			branch: snapshot.branch, upstream: snapshot.upstream,
			ahead: snapshot.ahead, behind: snapshot.behind,
		});
	});
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
		: mergeCommits(previous.commits, withUncommittedCount(previous.commits, snapshot.entries.length, parent));
	return {
		...previous, error: null, merging: snapshot.merging,
		headHash: snapshot.head, upstream: snapshot.upstream,
		entries: entriesSame ? previous.entries : mergeEntries(previous.entries, snapshot.entries),
		commits,
	};
}

/**
 * 组装一次提交图取数请求。
 *
 * 三处取数（首屏与对账刷新、翻页、轮询后的补取）用的是同一组设置与同一套「已知仓库信息」
 * 规则，集中在这里避免三份各自漂移：某处漏传 `remotes` 就会让宿主多取一次仓库信息。
 *
 * @param repo - 仓库路径。
 * @param maxCommits - 已加载的提交数上限。
 * @param settings - 当前设置。
 * @param skip - 要跳过的提交数；省略时取第一页。
 * @param branches - 引用起点；null 表示全部引用。
 * @returns 取数请求。
 */
function graphRequest(
	repo: string,
	maxCommits: number,
	settings: Settings,
	skip?: number,
	branches: readonly string[] | null = null,
): Parameters<typeof loadGraph>[1] {
	const known = rememberedRepoInfo(repo);
	return {
		branches,
		maxCommits,
		commitOrdering: settings.commitOrdering,
		showStashes: settings.showStashes,
		showTags: settings.showTags,
		showRemoteBranches: settings.showRemoteBranches,
		onlyFollowFirstParent: settings.onlyFollowFirstParent,
		includeCommitsMentionedByReflogs: settings.includeCommitsMentionedByReflogs,
		// 首次进入该仓库时随本批取回仓库信息；此后把已知值传回，宿主跳过仓库信息批。
		withRepoInfo: known === undefined,
		...(known === undefined ? {} : { remotes: known.remotes, stashes: known.stashes }),
		...(skip === undefined ? {} : { skip }),
	};
}

/**
 * 对账刷新与轮询补取要请求的提交窗口。
 *
 * 触底加载取过的提交保留在客户端列表里：按已加载条数请求，后台刷新就不会把列表收回到初始
 * 窗口——收回去会让用户已看过的那段消失，提交数差值也会被误报。
 *
 * @param maxCommits - 已加载的提交数上限。
 * @param commits - 当前提交列表。
 * @returns 本轮请求的提交数上限。
 */
function reconcileWindow(maxCommits: number, commits: readonly Commit[]): number {
	return Math.max(maxCommits, logCommitCountOf(commits));
}

/**
 * 记下本轮取回的远程与贮藏。
 *
 * 判据是响应确实带回了仓库信息且读取成功（`infoKnown`），不看内容是否为空：空远程与空贮藏
 * 同样是事实，记下它们才不会让下一次刷新再取一次仓库信息。
 *
 * @param repo - 仓库路径。
 * @param known - 本轮取数前是否已有已知值；已有则无需重记。
 * @param graph - 本轮取回的提交图数据。
 * @returns 无。
 */
function rememberFromGraph(repo: string, known: KnownRepoInfo | undefined, graph: GraphData): void {
	if (known !== undefined) return;
	if (!graph.infoKnown) return;
	rememberRepoInfo(repo, { remotes: graph.remotes, stashes: graph.stashes });
}

export function useGraphData({
	workingTreePath, hasWorkspace, maxCommits, settings, selectedId, setSyncById,
	filter = DEFAULT_REF_FILTER, branchBase = null, headHint = null, upstreamHint = null,
}: UseGraphDataOptions): UseGraphDataResult {
	/*
	 * 初始状态直接取该仓库上一次的结果。
	 *
	 * 侧栏页签按会话存储，切换会话会让面板整体重新挂载；若从空占位开始，图形区与更改区
	 * 必然先闪一次占位再重新取数，看起来就是「切换会话要重新加载」。
	 *
	 * 没有渲染态时用调用方给出的分支与上游作为首帧取值：自动筛选据此在第一轮就带上起点，
	 * 不必先取一遍全部引用再按快照结果重取。
	 */
	const [state, setState] = React.useState<PanelState>(() => {
		const remembered = workingTreePath === null ? undefined : rememberedPanelState(workingTreePath);
		if (remembered !== undefined) {
			return { ...remembered, headHash: remembered.headHash ?? null, upstream: remembered.upstream ?? null };
		}
		return {
			phase: 'loading', error: null, commits: [], head: headHint, headHash: null, upstream: upstreamHint,
			more: false, nextSkip: 0,
			entries: [], selectedHash: null, detail: null, busy: [], remotes: [], foreignBranches: [], merging: false,
			background: [], lastRefreshAt: 0,
		};
	});
	const generationRef = React.useRef(0);
	const controllerRef = React.useRef<AbortController | null>(null);
	/** 只取快照那一路的控制器；与提交图的控制器分开，避免作废在途的提交图请求。 */
	const entriesControllerRef = React.useRef<AbortController | null>(null);
	const busyRef = React.useRef<readonly BusyEntry[]>([]);

	/** 当前状态的引用：loadMore 在回调里读取已加载条数，避免把它列入依赖。 */
	const stateRef = React.useRef(state);
	stateRef.current = state;

	/*
	 * 取数起点由筛选与当前分支/上游/分叉来源派生。
	 *
	 * 分支与上游来自上一轮快照：换分支后这一轮先按旧值取、快照返回后起点变化再重取一次；
	 * 渲染态里留有上次的取值，因此同一仓库的重复刷新不会触发这次重取。
	 */
	const headName = state.head ?? headHint;
	const upstreamName = state.upstream ?? upstreamHint;
	const baseRef = branchBase !== null && branchBase.branch === headName ? branchBase.base : null;
	const graphBranches = React.useMemo(
		() => filterBranchesOf(filter, {
			head: headName, headHash: state.headHash ?? null,
			upstream: upstreamName, base: baseRef,
		}),
		[filter, headName, state.headHash, upstreamName, baseRef],
	);
	/** 取数起点的稳定编码：作为依赖与「起点是否变化」的判据。 */
	const branchesKey = graphBranches === null ? '*' : JSON.stringify(graphBranches);
	const branchesRef = React.useRef(graphBranches);
	branchesRef.current = graphBranches;
	/** 换仓库时的起点要按新仓库的分支提示重算，不能沿用上一个仓库的起点。 */
	const hintRef = React.useRef({ filter, head: headHint, upstream: upstreamHint });
	hintRef.current = { filter, head: headHint, upstream: upstreamHint };
	/** 上一次取数使用的起点，用于判断筛选或分支变化后是否要按新窗口重取。 */
	const loadedBranchesRef = React.useRef<string | null>(null);
	/**
	 * 取数范围：仓库、引用起点、提交窗口与影响提交行的设置项。
	 *
	 * 后台刷新告知只在范围相同的两轮之间比较计数：换仓库、换引用起点或加载更多之后，
	 * 两份提交列表不是同一批数据，差值没有意义。
	 */
	const graphScope = React.useMemo(() => JSON.stringify([
		workingTreePath, branchesKey, reconcileWindow(maxCommits, state.commits),
		settings.commitOrdering, settings.showStashes, settings.showTags, settings.showRemoteBranches,
		settings.onlyFollowFirstParent, settings.includeCommitsMentionedByReflogs,
	]), [workingTreePath, branchesKey, maxCommits, state.commits, settings]);

	/**
	 * 选中节点的引用。
	 *
	 * `refresh` 只把领先/落后写回选中节点，同仓库内改变选中不改变取数结果；把 `selectedId`
	 * 放进依赖会让每次改选都触发一次整页取数。
	 */
	const selectedIdRef = React.useRef<string | null>(selectedId);
	selectedIdRef.current = selectedId;

	/**
	 * 上一次取图的仓库；与当前不同时渲染态与请求参数一并重置。
	 *
	 * 初值取模块级记录：重新挂载时不能把「同一个仓库」误判成换了仓库。
	 */
	const loadedRepoRef = React.useRef<string | null>(activeGraphRepo);
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
		const startedAt = Date.now();
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;
		// 换仓库后旧的渲染态不再适用；用户主动刷新同样丢弃。
		const repoChanged = loadedRepoRef.current !== workingTreePath;
		/*
		 * 本轮取数起点：换仓库时上一个仓库的分支名在新仓库里可能不存在，不能沿用；按新仓库的
		 * 分支提示重算（提示来自仓库树，切换时已同步更新），拿不到提示时退回全部引用。
		 */
		const requestBranches = repoChanged
			? filterBranchesOf(hintRef.current.filter, {
				head: hintRef.current.head, headHash: null, upstream: hintRef.current.upstream, base: null,
			})
			: branchesRef.current;
		const requestKey = requestBranches === null ? '*' : JSON.stringify(requestBranches);
		/*
		 * 取数起点变化（筛选切换、换分支、分叉来源就绪）：旧窗口与旧渲染态都不再适用。
		 * 只在已有过一轮取数时算变化，首次进入按初始状态处理；换仓库由 repoChanged 负责。
		 */
		const branchesChanged = !repoChanged && loadedBranchesRef.current !== null && loadedBranchesRef.current !== requestKey;
		loadedBranchesRef.current = requestKey;
		// 同一仓库同一取数起点的对账保留已加载的分页；换仓库或换起点按初始窗口重取。
		const requestMax = mode === 'reconcile' && !repoChanged && !branchesChanged
			? reconcileWindow(maxCommits, stateRef.current.commits)
			: maxCommits;
		if (mode === 'full' || repoChanged) {
			dropGraphWindows(workingTreePath);
		} else if (branchesChanged) {
			dropRenderedGraph(workingTreePath);
		}
		activeGraphRepo = workingTreePath;
		// 换仓库后旧 HEAD 不再适用；同仓库沿用旧值，直到本轮快照返回后写入。
		if (repoChanged) loadedHeadRef.current = null;
		loadedRepoRef.current = workingTreePath;
		/*
		 * 后台刷新登记：reconcile 模式的两路都在进行中时给出界面指示，结束后移除。
		 * full 模式沿用 phase：用户主动刷新要看占位，不需要额外指示。
		 */
		const background = mode === 'reconcile';
		if (background) setState((previous) => beginBackground(beginBackground(previous, 'graph'), 'entries'));
		if (mode === 'full') {
			setState((previous) => ({
				...previous, phase: 'loading', error: null, commits: [], entries: [], detail: null, selectedHash: null,
			}));
		} else if (repoChanged) {
			/*
			 * 换到另一个仓库：先清空旧仓库的数据，只保留不随条目变化的部分。重新挂载时
			 * `repoChanged` 为 false、初始状态已是上次结果，因此不进这里。
			 *
			 * 条目与提交列表必须清空：保留会让更改区与图形区在取数返回前一直显示上一个仓库的
			 * 内容，用户会把它当成新仓库的数据。分支、上游与 HEAD 一并清掉：它们是上一个仓库
			 * 的事实，本轮取数起点已按新仓库的提示单独算过。
			 */
			setState((previous) => ({
				...previous,
				phase: 'loading', error: null,
				commits: [], entries: [], head: null, headHash: null, upstream: null, more: false, nextSkip: 0,
				detail: null, selectedHash: null,
			}));
		} else if (branchesChanged) {
			/*
			 * 换筛选或换分支：提交列表按新的引用起点重取，旧列表对新起点没有意义。
			 * 只清图形区，更改区与条目不受筛选影响，保留可省一次重绘；分支与上游要保持原值，
			 * 它们正是本轮起点的输入。
			 */
			setState((previous) => ({
				...previous, phase: 'loading', error: null,
				commits: [], more: false, nextSkip: 0,
				detail: null, selectedHash: null,
			}));
		} else {
			setState((previous) => ({ ...previous, error: null }));
		}
		try {
			/*
			 * 提交图与工作区快照互不依赖，两路并行：串行要等两组请求依次结束，并行只等最慢的一组。
			 *
			 * 两路各自就绪即写入：工作区快照通常先回，更改区因此不必等提交图就能画出变更列表。
			 * 只写 `entries`，不改 `phase` —— 图形区按 `phase === 'loading'` 显示占位，提前置
			 * ready 会让它误显示「这个仓库还没有提交」。
			 *
			 * 只取第一个窗口：完整提交集驻留宿主，客户端按窗口分页取。窗口缓存也在宿主，
			 * 命中与否由宿主决定，客户端不再自建一份。
			 */
			/*
			 * 仓库信息（远程与贮藏）只在某仓库首次取数时随本批取回（`withRepoInfo`），此后把已知值
			 * 传回宿主：宿主据此跳过仓库信息批，一次刷新少起一组子进程。写操作与主动刷新会作废
			 * 已知值（`dropGraphWindows`），下一次取数因此重新带回。
			 */
			const known = rememberedRepoInfo(workingTreePath);
			const graphSource = loadGraph(workingTreePath, {
				...graphRequest(workingTreePath, requestMax, settings, undefined, requestBranches),
				signal: controller.signal,
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
						: mergeEntries(previous.entries, snapshot.entries),
				}));
				writeSync(setSyncById, selectedIdRef.current, snapshot);
				return snapshot;
			});
			const [graph, snapshot] = await Promise.all([graphSource, snapshotSource]);
			if (generation !== generationRef.current) return;
			rememberFromGraph(workingTreePath, known, graph);
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
				const foreignSame = keep && branchNamesEqual(previous.foreignBranches, graph.foreignBranches);
				const settled = background
					? endBackground(endBackground(previous, 'graph'), 'entries')
					: previous;
				return {
					...settled, phase: 'ready', error: null, merging: snapshot.merging,
					commits: commitsSame ? settled.commits : mergeCommits(settled.commits, commits),
					head: graph.head, headHash: snapshot.head, upstream: snapshot.upstream,
					more: graph.moreCommitsAvailable, nextSkip: graph.nextSkip,
					remotes: remotesSame ? settled.remotes : graph.remotes,
					foreignBranches: foreignSame ? settled.foreignBranches : graph.foreignBranches,
					entries: entriesSame ? settled.entries : mergeEntries(settled.entries, snapshot.entries),
					detail: mode === 'full' ? null : settled.detail,
				};
			});
			logClient('I', 'refresh', `${mode === 'full' ? '主动刷新' : '对账刷新'}完成，仓库 ${workingTreePath}，耗时 ${String(Date.now() - startedAt)} ms`);
		} catch (error) {
			if (generation !== generationRef.current || controller.signal.aborted) return;
			if (background) setState((previous) => endBackground(endBackground(previous, 'graph'), 'entries'));
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, maxCommits, settings, hasWorkspace, setSyncById, branchesKey]);

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
		const startedAt = Date.now();
		setState((previous) => beginBackground(previous, 'entries'));
		try {
			const snapshot = await loadWorkingTreeSnapshot(repo, controller.signal);
			// 换仓库后这次结果不再适用；同仓库的并发快照以最后一次为准。
			if (controller.signal.aborted || repo !== loadedRepoRef.current) return;
			setState((previous) => mergeSnapshot(endBackground(previous, 'entries'), snapshot));
			writeSync(setSyncById, selectedId, snapshot);
			logClient('D', 'refresh', `只取工作区快照完成，仓库 ${repo}，耗时 ${String(Date.now() - startedAt)} ms`);
		} catch (error) {
			if (controller.signal.aborted) return;
			setState((previous) => endBackground(previous, 'entries'));
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, selectedId, setSyncById]);

	/**
	 * 只重取提交图并合并进现有状态。
	 *
	 * 供兜底轮询在 HEAD 移动时使用：那一轮已经读到工作区快照，再走 {@link refresh} 会把同一份
	 * 快照重读一次。提交图与快照两路里只剩提交图要取。
	 *
	 * 不递增 `generationRef`、不 abort 在途请求：与 {@link refreshEntries} 同理，作废在途的
	 * 提交图请求会让图形区停在 loading。
	 *
	 * @param repo - 仓库路径。
	 * @param snapshot - 本轮已读到的工作区快照。
	 * @returns 无。
	 */
	const reloadGraphOnly = React.useCallback(async (repo: string, snapshot: WorkingTreeSnapshot) => {
		const generation = generationRef.current;
		setState((previous) => beginBackground(previous, 'graph'));
		try {
			const known = rememberedRepoInfo(repo);
			const graph = await loadGraph(repo, graphRequest(repo, reconcileWindow(maxCommits, stateRef.current.commits), settings, undefined, branchesRef.current));
			if (generation !== generationRef.current || repo !== loadedRepoRef.current) return;
			loadedHeadRef.current = snapshot.head;
			const commits = withUncommittedCount(
				graph.commits, snapshot.entries.length,
				uncommittedParentOf(graph.commits, snapshot.head),
			);
			setState((previous) => {
				const commitsSame = previous.head === graph.head && previous.more === graph.moreCommitsAvailable
					&& commitsListEqual(previous.commits, commits);
				const entriesSame = entriesEqual(previous.entries, snapshot.entries);
				const remotesSame = remotesListEqual(previous.remotes, graph.remotes);
				const foreignSame = branchNamesEqual(previous.foreignBranches, graph.foreignBranches);
				return {
					...endBackground(endBackground(previous, 'graph'), 'entries'),
					phase: 'ready', error: null, merging: snapshot.merging,
					commits: commitsSame ? previous.commits : mergeCommits(previous.commits, commits),
					head: graph.head, headHash: snapshot.head, upstream: snapshot.upstream,
					more: graph.moreCommitsAvailable, nextSkip: graph.nextSkip,
					remotes: remotesSame ? previous.remotes : graph.remotes,
					foreignBranches: foreignSame ? previous.foreignBranches : graph.foreignBranches,
					entries: entriesSame ? previous.entries : mergeEntries(previous.entries, snapshot.entries),
				};
			});
			rememberFromGraph(repo, known, graph);
		} catch (error) {
			if (generation !== generationRef.current) return;
			setState((previous) => endBackground(previous, 'graph'));
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [maxCommits, settings, branchesKey]);

	/**
	 * 追加下一页。
	 *
	 * 偏移分页：下一页的起点是已加载条数。客户端保留从最新提交开始的完整前缀，因此向上滚动不需要
	 * 再取数 —— 反向取回只在「从头部淘汰」时才需要，而这里不做淘汰。窗口缓存由宿主维护，
	 * 回看已取过的一段同样不再真正跑 git。
	 *
	 * @returns 无。
	 */
	const loadMore = React.useCallback(async () => {
		if (workingTreePath === null) return;
		/*
		 * 偏移量用宿主上一窗口给出的 `nextSkip`。
		 *
		 * 不能按已加载列表长度算：列表里除了 `git log` 记录，还可能插入贮藏行与未提交伪提交行，
		 * 它们都不是日志记录，计入会让偏移虚高、下一页跳过真实提交，或停在原地反复请求同一窗口。
		 */
		const skip = stateRef.current.nextSkip;
		const generation = generationRef.current;
		try {
			// 翻页同样复用已知的远程与贮藏：宿主因此不必为标注远程分支与插入贮藏行补取仓库信息。
			const graph = await loadGraph(workingTreePath, graphRequest(workingTreePath, maxCommits, settings, skip, branchesRef.current));
			if (generation !== generationRef.current) return;
			setState((current) => {
				const known = new Set(current.commits.map((commit) => commit.hash));
				const fresh = graph.commits.filter((commit) => !known.has(commit.hash));
				/*
				 * 没有取回任何新提交时保持原引用并收敛 `more`。
				 *
				 * 图形区按 `commits` 引用判断「是否取回了新数据」并据此再补取一次；无条件新建数组
				 * 会让「这一页全是已加载提交」也被判成有进展，于是反复请求同一偏移，表现为页末
				 * 不停翻页。偏移没有推进时不可能再取到新内容。
				 */
				if (fresh.length === 0) {
					if (!current.more) return current;
					return { ...current, more: false, nextSkip: graph.nextSkip };
				}
				return {
					...current,
					commits: mergeCommits(current.commits, [...current.commits, ...fresh]),
					more: graph.moreCommitsAvailable,
					nextSkip: graph.nextSkip,
					// 翻页同样带回当前工作树的占用分支：新增提交上可能挂着这些分支。
					foreignBranches: branchNamesEqual(current.foreignBranches, graph.foreignBranches)
						? current.foreignBranches
						: graph.foreignBranches,
				};
			});
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, maxCommits, settings, branchesKey]);

	React.useEffect(() => { void refresh(); }, [refresh]);
	React.useEffect(() => { busyRef.current = state.busy; }, [state.busy]);

	/*
	 * 记下最近一次渲染的面板状态：切换会话会让面板重新挂载，下次进入同一仓库时先呈现它，
	 * 不必从占位重新取数。只在有仓库且已有数据时记，避免把占位状态写进缓存。
	 * 进行中的操作不随重新挂载延续，因此保存前清空它们。
	 */
	React.useEffect(() => {
		if (workingTreePath === null || state.phase !== 'ready') return;
		rememberPanelState(workingTreePath, { ...state, busy: [] }, maxCommits);
	}, [workingTreePath, state, maxCommits]);

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
				const snapshot = await loadWorkingTreeSnapshot(workingTreePath, undefined, true);
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
					setState((previous) => mergeSnapshot(endBackground(previous, 'entries'), snapshot));
				} catch { /* 忽略兜底轮询失败 */ } finally {
					setState((previous) => endBackground(previous, 'entries'));
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
	}, [workingTreePath, reloadGraphOnly, settings.autoRefresh, settings.pollActiveSeconds, settings.pollIdleSeconds]);

	return { state, setState, refresh, refreshEntries, loadMore, busyRef, graphScope };

}
