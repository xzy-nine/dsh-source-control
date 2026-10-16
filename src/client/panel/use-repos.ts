/**
 * 存储库发现：按会话工作区加载仓库树，并按可见行预取领先/落后。
 */
import React from 'react';
import { discoverRepositories, loadReposSync } from '../api/index.ts';
import { loadRepoLocations, primeRepoLocations, saveRepoLocations } from './repo-locations.ts';
import {
	ancestryOf, flattenVisible, loadExpanded, loadSelection, saveExpanded, saveSelection, selectInitial,
} from './repo-tree.ts';
import type { RepoNode, RepoSync } from '../shared/types.ts';

/** 一次批量请求的仓库路径数上限；超出的路径留到下一轮空闲回调。 */
const SYNC_BATCH = 24;

/** 仓库发现 hook 的入参。 */
export interface UseReposOptions {
	/** 会话工作区路径；没有工作区时为 undefined。 */
	readonly cwd: string | undefined;
	/** 会话 id，用于持久化选中与展开状态。 */
	readonly sessionId: string;
}

/** 仓库发现 hook 的返回值。 */
export interface UseReposResult {
	/** 仓库节点列表。 */
	readonly repoNodes: RepoNode[];
	/** 树状态。 */
	readonly treeStatus: 'loading' | 'ready' | 'empty' | 'error';
	/** 扫描上限等提示；无提示为 null。 */
	readonly treeNote: string | null;
	/** 选中节点 id。 */
	readonly selectedId: string | null;
	/** 已展开节点 id。 */
	readonly expandedIds: ReadonlySet<string>;
	/** 可见行。 */
	readonly visibleRows: Array<{ node: RepoNode; depth: number }>;
	/** 每个节点的领先/落后。 */
	readonly syncById: ReadonlyMap<string, RepoSync>;
	/** 选中节点。 */
	readonly selectedNode: RepoNode | null;
	/** 选中一个节点并持久化。 */
	readonly selectNode: (node: RepoNode) => void;
	/** 展开或收起一个节点。 */
	readonly toggleNode: (node: RepoNode) => void;
	/** 选中节点 id 的写入器。 */
	readonly setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
	/** 记录某个节点的领先/落后。 */
	readonly setSyncById: React.Dispatch<React.SetStateAction<Map<string, RepoSync>>>;
	/** 重新扫描仓库树；克隆出新仓库后调用。 */
	readonly rescan: () => void;
}

/**
 * 加载仓库树并预取可见节点的领先/落后。
 *
 * @param options - 见 {@link UseReposOptions}。
 * @returns 树状态与操作。
 */
export function useRepos({ cwd, sessionId }: UseReposOptions): UseReposResult {
	const [repoNodes, setRepoNodes] = React.useState<RepoNode[]>([]);
	const [treeStatus, setTreeStatus] = React.useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
	const [treeNote, setTreeNote] = React.useState<string | null>(null);
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => loadExpanded(sessionId));
	const [syncById, setSyncById] = React.useState<Map<string, RepoSync>>(() => new Map());
	/** 每次重新扫描递增：作为发现 effect 的依赖，克隆出新仓库后据此重扫。 */
	const [scanSeq, setScanSeq] = React.useState(0);
	const hasWorkspace = cwd !== undefined && cwd !== null;

	React.useEffect(() => {
		if (!hasWorkspace) {
			setRepoNodes([]);
			setTreeStatus('empty');
			return undefined;
		}
		const controller = new AbortController();
		const root = cwd as string;
		/**
		 * 应用一次发现结果。
		 *
		 * @param result - 发现结果。
		 * @param cacheLocations - 是否把顶层仓库位置写回缓存。
		 * @returns 无。
		 */
		const apply = (result: { nodes: RepoNode[]; truncated: boolean }, cacheLocations: boolean): void => {
			if (controller.signal.aborted) return;
			const initial = selectInitial(result.nodes, root, loadSelection(sessionId));
			setRepoNodes(result.nodes);
			setSelectedId(initial === null ? null : initial.id);
			setExpandedIds((previous) => {
				const next = new Set(previous);
				if (initial !== null) for (const id of ancestryOf(result.nodes, initial.id)) next.add(id);
				return next;
			});
			setTreeStatus('ready');
			setTreeNote(result.truncated ? '已达到扫描上限，仅显示部分仓库' : null);
			// 缓存只记顶层仓库：工作树与子模块依附于仓库，随 checkout 变化，运行时枚举即可。
			if (cacheLocations) saveRepoLocations(root, result.nodes.filter((node) => node.kind === 'repo').map((node) => ({ path: node.path, name: node.name })));
		};
		const fail = (error: unknown): void => {
			if (controller.signal.aborted) return;
			setRepoNodes([]);
			setTreeStatus('error');
			setTreeNote(error instanceof Error ? error.message : String(error));
		};

		/**
		 * 先取仓库位置缓存，再决定走快路径还是完整扫描。
		 *
		 * 缓存由宿主持有，因此这里 await 一次；完整扫描动辄上百毫秒，这次往返不构成瓶颈。
		 *
		 * @returns 无。
		 */
		const start = async (): Promise<void> => {
			if (scanSeq === 0) await primeRepoLocations(root);
			if (controller.signal.aborted) return;
			const cached = scanSeq === 0 ? loadRepoLocations(root) : [];
			if (cached.length > 0) {
				// 命中缓存：先按已知路径取树（不扫目录），秒出界面；随后完整重扫一次纠正位置变化。
				const quick = await discoverRepositories(root, { knownRepos: cached.map((repo) => repo.path) }, controller.signal);
				apply(quick, false);
				if (controller.signal.aborted) return;
				apply(await discoverRepositories(root, {}, controller.signal), true);
				return;
			}
			setTreeStatus('loading');
			setTreeNote(null);
			apply(await discoverRepositories(root, {}, controller.signal), true);
		};
		void start().catch(fail);
		return () => { controller.abort(); };
	}, [cwd, sessionId, hasWorkspace, scanSeq]);

	/** 重新扫描仓库树。 */
	const rescan = React.useCallback(() => {
		setSyncById(new Map());
		setScanSeq((previous) => previous + 1);
	}, []);

	/** 选中一个仓库节点并持久化。 */
	const selectNode = React.useCallback((node: RepoNode) => {
		setSelectedId((previous) => {
			if (node.id === previous) return previous;
			saveSelection(sessionId, node.id);
			return node.id;
		});
	}, [sessionId]);

	/** 展开或收起一个仓库节点。 */
	const toggleNode = React.useCallback((node: RepoNode) => {
		setExpandedIds((previous) => {
			const next = new Set(previous);
			if (next.has(node.id)) next.delete(node.id);
			else next.add(node.id);
			saveExpanded(sessionId, next);
			return next;
		});
	}, [sessionId]);

	const visibleRows = React.useMemo(() => flattenVisible(repoNodes, expandedIds), [repoNodes, expandedIds]);
	const selectedNode = React.useMemo(() => {
		if (selectedId === null) return null;
		const find = (list: readonly RepoNode[]): RepoNode | null => {
			for (const node of list) {
				if (node.id === selectedId) return node;
				const found = find(node.children ?? []);
				if (found !== null) return found;
			}
			return null;
		};
		return find(repoNodes);
	}, [repoNodes, selectedId]);

	/* ── 后台预取可见节点的领先/落后 ─────────────────────── */

	/** 在途请求的仓库路径集合：同一路径不重复请求，回写后清除。 */
	const syncInFlight = React.useRef<Set<string>>(new Set());
	/** 整批预取失败后的重试序号：递增以驱动下一轮空闲回调。 */
	const [syncRetrySeq, setSyncRetrySeq] = React.useState(0);

	/*
	 * 一次批量取回可见节点：路径去重后交给宿主批量命令，宿主侧按仓库并发；
	 * 请求按路径在途去重，一次最多 SYNC_BATCH 个路径，超出的留到下一轮空闲回调。
	 */
	React.useEffect(() => {
		if (!hasWorkspace) return undefined;
		const root = cwd as string;
		let cancelled = false;
		const idle = typeof window.requestIdleCallback === 'function'
			? (fn: () => void): number => window.requestIdleCallback(fn, { timeout: 1500 })
			: (fn: () => void): number => window.setTimeout(fn, 120);
		const cancelIdle = typeof window.cancelIdleCallback === 'function'
			? (handle: number): void => window.cancelIdleCallback(handle)
			: (handle: number): void => window.clearTimeout(handle);
		const handle = idle(() => {
			void (async () => {
				// 同一路径可能对应多个节点：按路径收集节点 id，结果一次写回。
				const idsByPath = new Map<string, string[]>();
				for (const { node } of visibleRows) {
					if (syncById.has(node.id) || syncInFlight.current.has(node.path)) continue;
					const ids = idsByPath.get(node.path);
					if (ids !== undefined) { ids.push(node.id); continue; }
					if (idsByPath.size >= SYNC_BATCH) continue;
					idsByPath.set(node.path, [node.id]);
				}
				if (idsByPath.size === 0) return;
				const paths = [...idsByPath.keys()];
				for (const path of paths) syncInFlight.current.add(path);
				try {
					const entries = await loadReposSync(root, paths);
					for (const path of paths) syncInFlight.current.delete(path);
					if (cancelled) return;
					const patch = new Map<string, RepoSync>();
					for (const entry of entries) {
						for (const id of idsByPath.get(entry.path) ?? []) {
							patch.set(id, {
								branch: entry.branch, upstream: entry.upstream, ahead: entry.ahead, behind: entry.behind,
							});
						}
					}
					if (patch.size === 0) return;
					setSyncById((previous) => {
						const next = new Map(previous);
						for (const [id, sync] of patch) next.set(id, sync);
						return next;
					});
				} catch {
					// 整批失败不写入缓存：清除在途后由下一轮空闲回调重试。
					for (const path of paths) syncInFlight.current.delete(path);
					setSyncRetrySeq((previous) => previous + 1);
				}
			})();
		});
		return () => { cancelled = true; cancelIdle(handle); };
	}, [visibleRows, syncById, cwd, hasWorkspace, syncRetrySeq]);

	return {
		repoNodes, treeStatus, treeNote, selectedId, expandedIds, visibleRows, syncById, selectedNode,
		selectNode, toggleNode, setSelectedId, setSyncById, rescan,
	};
}
