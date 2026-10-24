/**
 * 仓库树预加载：按会话工作区取回仓库树、工作树/子模块与领先/落后并发布快照。
 *
 * 取数在插件激活时启动，与面板是否打开无关；面板打开时先呈现已发布的快照，再在后台重取。
 * 同一工作区同时只有一份在途取数，重新取数时中止上一份。
 *
 * 预加载状态放在模块级映射里，因此多个面板实例（同一工作区的多个会话）共用一份结果。
 */
import { discoverRepositories, enrichRepositories, loadReposSync } from '../api/index.ts';
import { createEnrichClaims, ENRICH_FAILURE_LIMIT, type EnrichClaims } from './enrich-claims.ts';
import { runEnrichBatch } from './enrich-run.ts';
import { attachChildren } from './repo-tree.ts';
import type { RepoNode, RepoSync } from '../shared/types.ts';

/** 一个工作区的仓库树快照。 */
export interface WorkspaceSnapshot {
	/** 工作区根路径，保持首次登记时的写法。 */
	readonly root: string;
	/** 已挂好工作树与子模块的仓库节点。 */
	readonly nodes: RepoNode[];
	/** 是否因目录数上限提前结束。 */
	readonly truncated: boolean;
	/** 宿主是否按持久化位置取树，未逐层扫描。 */
	readonly usedCache: boolean;
	/** 取数状态。 */
	readonly status: 'loading' | 'ready' | 'error';
	/** 失败文本；无错误为 null。 */
	readonly error: string | null;
	/** 发现代次：每次浅层发现或位置纠正递增。 */
	readonly discoveryRevision: number;
	/** 节点 id -> 领先/落后。 */
	readonly syncById: ReadonlyMap<string, RepoSync>;
}

/** 预加载选项。 */
export interface PreloadOptions {
	/** 已有在途取数时中止并重取；缺省时在途即复用。 */
	readonly force?: boolean;
}

/**
 * 一次重取的最短间隔（毫秒）。
 *
 * 同一工作区可能同时挂着多个会话面板，各自挂载时都会请求一次；没有这个下限时每个面板
 * 都会中止上一份在途取数重来一遍，而重取包含一次全目录扫描，多个面板叠加即把宿主拖住。
 */
const REFRESH_COOLDOWN_MS = 30_000;

/**
 * 两次完整目录扫描之间的最短间隔（毫秒）。
 *
 * 持久化位置命中时只需核对已知路径，但位置本身可能过期（仓库被移动、删除或新增）。
 * 按此间隔跟一次完整扫描即可纠正，不必每次重取都扫。
 */
const FULL_SCAN_INTERVAL_MS = 10 * 60_000;

/** 一个工作区的预加载状态。 */
interface WorkspaceEntry {
	readonly root: string;
	snapshot: WorkspaceSnapshot;
	/** 最近一次发现得到的节点（未挂 children）。 */
	baseNodes: RepoNode[];
	/** 仓库路径 -> 已补齐的 children。 */
	childrenByPath: Map<string, RepoNode[]>;
	/** 补齐占用登记。 */
	readonly claims: EnrichClaims;
	readonly listeners: Set<() => void>;
	/** 在途取数；无在途时为 null。 */
	running: Promise<void> | null;
	/** 在途取数的取消控制器。 */
	controller: AbortController | null;
	/** 代次：每次重新取数递增，旧代次的结果不写回。 */
	generation: number;
	/** 最近一次取数完成或开始的时刻；用于重取冷却。 */
	refreshedAt: number;
	/** 最近一次完整目录扫描的时刻；用于完整扫描的节流。 */
	lastFullScanAt: number;
	/**
	 * 取数进行期间到达的结构重取请求。
	 *
	 * 合并连续请求，不丢弃：丢弃会让「创建后立刻移除」这类紧随其后的结构变化永久
	 * 不反映，节点留在指向已不存在目录的状态。
	 */
	pendingRefresh: boolean;
}

/** 工作区归一化键 -> 预加载状态。 */
const entries = new Map<string, WorkspaceEntry>();

/**
 * 取工作区的归一化键。
 *
 * @param root - 工作区根路径。
 * @returns 分隔符统一为 `/`、去掉尾斜杠；Windows 盘符路径统一小写。
 */
function rootKey(root: string): string {
	const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
	return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * 从会话列表快照里取主视图当前会话的工作区。
 *
 * 判据是会话行上的 `retainedBy.mainView`：主视图持有该会话的引用即表示它正被显示，
 * 与任何插件页是否打开无关。旧宿主没有该标记时回退 `current`。
 *
 * 子代理会话沿用父会话的工作区，不作为活跃会话。
 *
 * @param list - 会话列表快照（形状同 `SessionListState`）。
 * @returns 会话 id 与其工作区根；没有正在显示的会话时为 null。
 */
export function activeWorkspaceOf(list: unknown): { readonly sessionId: string; readonly cwd: string } | null {
	const state = list as {
		readonly ids?: unknown;
		readonly byId?: unknown;
		readonly current?: unknown;
	} | null;
	if (state === null || typeof state !== 'object') return null;
	const ids = Array.isArray(state.ids) ? state.ids : [];
	const byId = (state.byId ?? {}) as Record<string, unknown>;

	const pick = (id: string): { sessionId: string; cwd: string } | null => {
		const row = byId[id] as { readonly cwd?: unknown; readonly origin?: unknown } | undefined;
		if (row === undefined || typeof row.cwd !== 'string' || row.cwd === '') return null;
		if (row.origin === 'subagent') return null;
		return { sessionId: id, cwd: row.cwd };
	};
	const isMain = (id: string): boolean => {
		const row = byId[id] as { readonly retainedBy?: unknown } | undefined;
		if (row === undefined || row.retainedBy === null || typeof row.retainedBy !== 'object') return false;
		const count = (row.retainedBy as Record<string, unknown>).mainView;
		return typeof count === 'number' && count > 0;
	};

	// 旧宿主用 current 标出当前会话；有值时以它为准。
	const current = state.current;
	if (typeof current === 'string' && current !== '') {
		const hit = pick(current);
		if (hit !== null) return hit;
	}
	for (const id of ids) {
		if (typeof id !== 'string' || !isMain(id)) continue;
		const hit = pick(id);
		if (hit !== null) return hit;
	}
	for (const id of Object.keys(byId)) {
		if (ids.includes(id) || !isMain(id)) continue;
		const hit = pick(id);
		if (hit !== null) return hit;
	}
	return null;
}

/**
 * 取一个工作区已发布的快照。
 *
 * @param root - 工作区根路径。
 * @returns 快照；尚未预加载时为 null。
 */
export function getWorkspaceSnapshot(root: string): WorkspaceSnapshot | null {
	return entries.get(rootKey(root))?.snapshot ?? null;
}

/**
 * 订阅一个工作区的快照变化。
 *
 * @param root - 工作区根路径。
 * @param listener - 快照变化时调用。
 * @returns 取消订阅。
 */
export function subscribeWorkspace(root: string, listener: () => void): () => void {
	const entry = entries.get(rootKey(root));
	if (entry === undefined) return () => {};
	entry.listeners.add(listener);
	return () => { entry.listeners.delete(listener); };
}

/**
 * 创建一个工作区的预加载状态。
 *
 * @param root - 工作区根路径。
 * @returns 预加载状态。
 */
function createEntry(root: string): WorkspaceEntry {
	return {
		root,
		snapshot: {
			root, nodes: [], truncated: false, usedCache: false,
			status: 'loading', error: null, discoveryRevision: 0, syncById: new Map(),
		},
		baseNodes: [],
		childrenByPath: new Map(),
		claims: createEnrichClaims(),
		listeners: new Set(),
		running: null,
		controller: null,
		generation: 0,
		refreshedAt: 0,
		lastFullScanAt: 0,
		pendingRefresh: false,
	};
}

/**
 * 发布一份快照并通知订阅者。
 *
 * @param entry - 预加载状态。
 * @param patch - 快照变更。
 * @returns 无。
 */
function publish(entry: WorkspaceEntry, patch: Partial<WorkspaceSnapshot>): void {
	entry.snapshot = { ...entry.snapshot, ...patch, root: entry.root };
	for (const listener of [...entry.listeners]) {
		try {
			listener();
		} catch {
			/* 单个订阅者异常不影响其它订阅者 */
		}
	}
}

/**
 * 按当前发现结果与补齐记录重建节点。
 *
 * @param entry - 预加载状态。
 * @returns 挂好 children 的节点。
 */
function rebuildNodes(entry: WorkspaceEntry): RepoNode[] {
	return attachChildren(entry.baseNodes, entry.childrenByPath) as RepoNode[];
}

/**
 * 应用一次发现结果。
 *
 * @param entry - 预加载状态。
 * @param result - 发现结果。
 * @returns 无。
 */
function applyDiscovery(
	entry: WorkspaceEntry,
	result: { readonly nodes: RepoNode[]; readonly truncated: boolean; readonly usedCache: boolean },
): void {
	entry.baseNodes = result.nodes;
	// 消失的仓库作废补齐记录与占用登记：位置再次出现时重新补齐。
	const paths = new Set(result.nodes.filter((node) => node.kind === 'repo').map((node) => node.path));
	if (entry.childrenByPath.size > 0) {
		const next = new Map<string, RepoNode[]>();
		for (const [path, children] of entry.childrenByPath) if (paths.has(path)) next.set(path, children);
		entry.childrenByPath = next;
	}
	const stale = entry.claims.keys().filter((path) => !paths.has(path));
	if (stale.length > 0) entry.claims.forget(stale);
	publish(entry, {
		nodes: rebuildNodes(entry),
		truncated: result.truncated,
		usedCache: result.usedCache,
		status: 'ready',
		error: null,
		discoveryRevision: entry.snapshot.discoveryRevision + 1,
	});
}

/**
 * 写入一批补齐结果。
 *
 * @param entry - 预加载状态。
 * @param batch - 本批仓库路径。
 * @param enriched - 宿主回投的节点。
 * @returns 无。
 */
function applyEnriched(entry: WorkspaceEntry, batch: readonly string[], enriched: readonly RepoNode[]): void {
	const byPath = new Map(enriched.map((node) => [node.path, node.children]));
	const next = new Map(entry.childrenByPath);
	for (const path of batch) next.set(path, byPath.get(path) ?? []);
	entry.childrenByPath = next;
	publish(entry, { nodes: rebuildNodes(entry) });
}

/**
 * 一次补齐请求携带的仓库数上限。
 *
 * 补齐对每个仓库读工作树登记与 `.gitmodules`，仓库多时一次下发会让宿主同时做大量文件读取，
 * 并把结果挤在同一批响应里。分批后每批完成即发布一次快照，树因此逐步长出工作树与子模块节点。
 */
const ENRICH_BATCH_SIZE = 8;

/**
 * 把一组路径切成每批不超过给定大小的批次。
 *
 * @param paths - 全部路径。
 * @param size - 每批上限；小于 1 时按 1 处理。
 * @returns 批次列表。
 */
export function chunkPaths(paths: readonly string[], size: number): string[][] {
	// NaN 经 Math.max 仍是 NaN，循环步长因此为 NaN、一批都切不出来；先收敛到有限整数。
	const limit = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1;
	const batches: string[][] = [];
	for (let index = 0; index < paths.length; index += limit) {
		batches.push(paths.slice(index, index + limit));
	}
	return batches;
}

/**
 * 补齐全部顶层仓库的工作树与子模块。
 *
 * 按 {@link ENRICH_BATCH_SIZE} 分批下发，每批完成即发布一次快照。空结果与失败按路径累计
 * 次数重试，到上限后按「没有工作树与子模块」处理。
 *
 * @param entry - 预加载状态。
 * @param controller - 本轮取消控制器。
 * @returns 无。
 */
async function enrichAll(entry: WorkspaceEntry, controller: AbortController): Promise<void> {
	const all = entry.baseNodes.filter((node) => node.kind === 'repo').map((node) => node.path);
	const cancelled = (): boolean => controller.signal.aborted;
	for (let attempt = 0; attempt <= ENRICH_FAILURE_LIMIT; attempt += 1) {
		if (cancelled()) return;
		const pending = all.filter((path) => !entry.claims.has(path));
		if (pending.length === 0) return;
		/** 本批是否有需要重试的路径；由 runEnrichBatch 的回调写入。 */
		const state = { retry: false };
		for (const batch of chunkPaths(pending, ENRICH_BATCH_SIZE)) {
			if (cancelled()) return;
			await runEnrichBatch(batch, {
				claims: entry.claims,
				isCancelled: cancelled,
				fetchEnriched: (paths) => enrichRepositories(entry.root, paths, controller.signal),
				requestRetry: () => { state.retry = true; },
				write: (paths, enriched) => { applyEnriched(entry, paths, enriched); },
			});
		}
		if (!state.retry || cancelled()) return;
	}
}

/**
 * 批量读取全部节点的领先/落后并写回快照。
 *
 * 一次请求取回全部节点，不按批切分。
 *
 * @param entry - 预加载状态。
 * @param controller - 本轮取消控制器。
 * @returns 无。
 */
async function syncAll(entry: WorkspaceEntry, controller: AbortController): Promise<void> {
	const paths: string[] = [];
	const idsByPath = new Map<string, string[]>();
	const collect = (nodes: readonly RepoNode[]): void => {
		for (const node of nodes) {
			const ids = idsByPath.get(node.path);
			if (ids === undefined) {
				idsByPath.set(node.path, [node.id]);
				paths.push(node.path);
			} else {
				ids.push(node.id);
			}
			collect(node.children);
		}
	};
	collect(entry.snapshot.nodes);
	if (paths.length === 0) return;
	const results = await loadReposSync(entry.root, paths, controller.signal);
	if (controller.signal.aborted) return;
	const next = new Map(entry.snapshot.syncById);
	for (const result of results) {
		const sync: RepoSync = {
			branch: result.branch, upstream: result.upstream, ahead: result.ahead, behind: result.behind,
		};
		for (const id of idsByPath.get(result.path) ?? []) next.set(id, sync);
	}
	publish(entry, { syncById: next });
}

/**
 * 启动一个工作区的取数。
 *
 * @param entry - 预加载状态。
 * @returns 无。
 */
function start(entry: WorkspaceEntry): void {
	entry.controller?.abort();
	const controller = new AbortController();
	entry.controller = controller;
	entry.generation += 1;
	entry.refreshedAt = Date.now();
	const generation = entry.generation;
	const cancelled = (): boolean => controller.signal.aborted || entry.generation !== generation;
	// 已有节点时保持 ready：重取期间界面继续显示上一轮结果，不闪回占位。
	publish(entry, { status: entry.snapshot.nodes.length > 0 ? 'ready' : 'loading', error: null });
	const run = (async (): Promise<void> => {
		try {
			const result = await discoverRepositories(entry.root, { shallow: true }, controller.signal);
			if (cancelled()) return;
			applyDiscovery(entry, result);
			/*
			 * 持久化位置可能已过期：绕开它重扫一次，按新位置纠正。
			 *
			 * 不每次都扫：持久化位置命中时本可以只核对已知路径，每次都跟一次全目录扫描会让
			 * 「命中缓存」反而更慢。改为按 {@link FULL_SCAN_INTERVAL_MS} 节流，另外在快路径
			 * 结果为空时立即重扫——那说明缓存整体失效，只能靠完整扫描找回。
			 */
			const now = Date.now();
			const stale = now - entry.lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
			if (result.usedCache && (result.nodes.length === 0 || stale)) {
				const corrected = await discoverRepositories(entry.root, { shallow: true, fullScan: true }, controller.signal);
				if (cancelled()) return;
				entry.lastFullScanAt = Date.now();
				applyDiscovery(entry, corrected);
			}
			await enrichAll(entry, controller);
			if (cancelled()) return;
			await syncAll(entry, controller);
		} catch (error) {
			if (cancelled()) return;
			publish(entry, {
				status: 'error',
				error: error instanceof Error ? error.message : String(error),
			});
		}
	})();
	entry.running = run;
	void run.finally(() => {
		entry.refreshedAt = Date.now();
		if (entry.running !== run) return;
		entry.running = null;
		entry.controller = null;
		/*
		 * 取数期间登记的结构变更：它发生在本次发现之后，本次结果必然不含它，因此立即再取一次，
		 * 不按冷却等待。挂起标志清掉后只重取一次，不会因同一批事件反复重取。
		 */
		if (entry.pendingRefresh) {
			clearPendingRefresh(entry);
			enrichAgain(entry);
		}
	});
}

/**
 * 预加载一个工作区的仓库树。
 *
 * 同一工作区可能同时挂着多个会话面板：在途时一律复用，`force` 也受重取冷却约束，
 * 避免每个面板挂载都中止上一份取数、重新做一次全目录扫描。
 *
 * @param root - 工作区根路径。
 * @param options - 见 {@link PreloadOptions}。
 * @returns 无。
 */
export function preloadWorkspace(root: string, options: PreloadOptions = {}): void {
	if (root === '') return;
	const key = rootKey(root);
	let entry = entries.get(key);
	if (entry === undefined) {
		entry = createEntry(root);
		entries.set(key, entry);
	}
	if (entry.running !== null) return;
	if (options.force === true && Date.now() - entry.refreshedAt < REFRESH_COOLDOWN_MS) return;
	start(entry);
}

/**
 * 重置一个工作区的预加载状态。
 *
 * 保留工作区条目与订阅者，只重置取数状态与缓存数据，并发布一份空的 loading 快照。重新扫描后
 * 树先回到占位，随后由 {@link preloadWorkspace} 重新取数并逐阶段发布。
 *
 * 用户主动重扫用它：先清空再重取。结构事件驱动的重扫用 {@link refreshWorkspace}，它不清空树。
 *
 * @param root - 工作区根路径。
 * @returns 无。
 */
export function dropWorkspace(root: string): void {
	const key = rootKey(root);
	const entry = entries.get(key);
	if (entry === undefined) return;
	clearPendingRefresh(entry);
	entry.generation += 1;
	entry.controller?.abort();
	entry.controller = null;
	entry.running = null;
	entry.refreshedAt = 0;
	entry.baseNodes = [];
	entry.childrenByPath = new Map();
	entry.claims.clear();
	publish(entry, {
		nodes: [], truncated: false, usedCache: false, status: 'loading', error: null,
		discoveryRevision: entry.snapshot.discoveryRevision + 1, syncById: new Map(),
	});
}

/**
 * 取消一个挂起的结构重取。
 *
 * @param entry - 预加载状态。
 * @returns 无。
 */
function clearPendingRefresh(entry: WorkspaceEntry): void {
	entry.pendingRefresh = false;
}

/**
 * 按最新结构重取一个工作区的仓库树，不清空已发布的树。
 *
 * 供结构事件（工作树或子模块增删）使用：重取期间树继续显示上一轮结果，新结果到达后替换，
 * 因此不闪回占位。作废补齐记录与占用登记，使新增的工作树与子模块被重新枚举。
 *
 * 不受重取冷却约束：结构事件是真实的目录变化，丢弃或延迟它会让树与实际不符 —— 创建后立刻
 * 移除时，移除落在冷却期内，树会一直保留已不存在的工作树（点击它还报 `spawn git ENOENT`）。
 * 冷却只用于面板挂载触发的重取，那里的重复请求没有语义差别。
 *
 * 在途期间到达的请求登记为 `pendingRefresh`，本次取数结束后立即再取一次：本次发现发生在
 * 变化之前，结果必然不含该变化。
 *
 * @param root - 工作区根路径。
 * @returns 无。
 */
export function refreshWorkspace(root: string): void {
	if (root === '') return;
	const key = rootKey(root);
	const entry = entries.get(key);
	if (entry === undefined) {
		preloadWorkspace(root);
		return;
	}
	if (entry.running !== null) {
		// 取数进行中：登记挂起请求，由本轮取数结束后统一触发一次后续重取。
		entry.pendingRefresh = true;
		return;
	}
	enrichAgain(entry);
}

/**
 * 作废补齐结果并重新取数。
 *
 * 保留 `baseNodes` 与已发布的树，只清掉补齐记录：工作树与子模块要重新枚举。
 *
 * @param entry - 预加载状态。
 * @returns 无。
 */
function enrichAgain(entry: WorkspaceEntry): void {
	entry.childrenByPath = new Map();
	entry.claims.clear();
	start(entry);
}
