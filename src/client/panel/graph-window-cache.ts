/**
 * 提交图的客户端渲染态与取数参数缓存。
 *
 * 这里只保存两类东西，都不含数据副本：
 * - 渲染态：上次画出来的面板状态与已加载提交数上限，供面板重新挂载时首帧呈现；
 * - 取数参数：已知的远程与贮藏，随刷新请求回传宿主，使宿主跳过仓库信息批。
 *
 * 真正的数据缓存（提交图窗口、工作区快照）在宿主内存里，见 `source-control/host-cache.ts`。
 */
import type { PanelState, Remote } from '../shared/types.ts';
import type { GraphStash } from '../api/index.ts';

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
export function rememberPanelState(repoPath: string, state: PanelState, maxCommits: number): void {
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
export function rememberedPanelState(repoPath: string): PanelState | undefined {
	return lastPanelState.get(repoKeyOf(repoPath));
}

/**
 * 最近一次取数的仓库（模块级）。
 *
 * 不能用实例内的 ref：侧栏页签按会话存储，切换会话会让面板重新挂载，实例 ref 必为 null，
 * 于是每次挂载都会被当成「换了仓库」而丢弃渲染态。
 */
let activeGraphRepo: string | null = null;

/**
 * 取最近一次取数的仓库。
 *
 * @returns 仓库路径；从未取过时为 null。
 */
export function getActiveGraphRepo(): string | null {
	return activeGraphRepo;
}

/**
 * 记下最近一次取数的仓库。
 *
 * @param repoPath - 仓库路径。
 * @returns 无。
 */
export function setActiveGraphRepo(repoPath: string): void {
	activeGraphRepo = repoPath;
}

/** 一个仓库已知的远程与贮藏：随刷新请求传给宿主，宿主因此不重取仓库信息批。 */
export interface KnownRepoInfo {
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
 * 取仓库相关缓存的键。
 *
 * @param repoPath - 仓库路径。
 * @returns 归一化后的键。
 */
export function repoKeyOf(repoPath: string): string {
	return repoPath.replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 记下一个仓库已知的远程与贮藏。
 *
 * @param repoPath - 仓库路径。
 * @param info - 远程与贮藏。
 * @returns 无。
 */
export function rememberRepoInfo(repoPath: string, info: KnownRepoInfo): void {
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
export function rememberedRepoInfo(repoPath: string): KnownRepoInfo | undefined {
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

/**
 * 刷新轮次计数器。
 *
 * 每次刷新取一个新编号随请求带给宿主：宿主据此把同一轮的几条命令归成一组记耗时，
 * 不再按时间窗口猜轮次边界。编号只在本次会话内单调递增，不持久化。
 */
let refreshIdCounter = 0;

/**
 * 本次会话的编号前缀。
 *
 * 宿主可能同时服务多个面板（多个浏览器标签页、多个工作区），各面板的计数器都从 1 开始，
 * 单靠计数器会把不同面板的轮次撞成同一组。前缀按会话随机一次即可区分。
 */
const refreshIdPrefix = Math.floor(Math.random() * 1_000_000) * 10_000;

/**
 * 取下一个刷新轮次编号。
 *
 * @returns 本次会话内单调递增的编号。
 */
export function nextRefreshId(): number {
	refreshIdCounter += 1;
	return refreshIdPrefix + refreshIdCounter;
}
