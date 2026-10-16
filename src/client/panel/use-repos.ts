/**
 * 仓库发现：按会话工作区加载仓库树，先出浅层树再补齐工作树与子模块，并按可见行预取领先/落后。
 *
 * 首屏关键路径只有一次浅层发现：顶层仓库节点来自宿主的持久化位置（`stat` + 读 `HEAD`），
 * 不枚举工作树、不读 `.gitmodules`、不起 git 子进程。工作树与子模块随后在空闲回调里补齐。
 */
import React from 'react';
import { discoverRepositories, enrichRepositories, loadReposSync } from '../api/index.ts';
import { createEnrichClaims, type EnrichClaims } from './enrich-claims.ts';
import { runEnrichBatch } from './enrich-run.ts';
import { rememberRepoLocations, saveRepoLocations } from './repo-locations.ts';
import {
	ancestryOf, attachChildren, claimPendingSelection, findNode, flattenVisible, loadExpanded, loadSelection,
	planSelection, saveExpanded, saveSelection,
} from './repo-tree.ts';
import type { RepoNode, RepoSync } from '../shared/types.ts';

/** 一次批量请求的仓库路径数上限；超出的路径留到下一轮空闲回调。 */
const SYNC_BATCH = 24;

/** 单次补齐工作树与子模块的仓库数上限；超出的仓库留到下一轮空闲回调。 */
const ENRICH_BATCH = 24;

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
	/** 已补齐工作树与子模块的仓库路径占用登记：同一路径不重复下发，取消时释放。 */
	const enrichClaims = React.useRef<EnrichClaims>(createEnrichClaims());
	/** 最近一次浅层发现的节点：补齐结果写回时以它为底，避免与后台纠正互相覆盖。 */
	const baseNodesRef = React.useRef<RepoNode[]>([]);
	/** 仓库路径 -> 已补齐的工作树与子模块；重新扫描时清空。 */
	const childrenByPathRef = React.useRef<Map<string, RepoNode[]>>(new Map());
	/**
	 * 待认领的持久化选中 id。
	 *
	 * 持久化选中的可能是工作树或子模块，而浅层树里没有这些节点：首次发现只能回退成第一个仓库。
	 * 补齐完成后据此把选中改回原节点；用户在此期间手动选过则作废（见 selectNode）。
	 */
	const pendingSelectionRef = React.useRef<string | null>(null);

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
		 * 浅层结果不含工作树与子模块；已补齐的部分按仓库路径挂回，后台纠正因此不会抹掉它们。
		 * 选中与展开都在**挂好 children 的树**上计算：否则持久化选中的工作树在浅层树里找不到，
		 * 会被回退成第一个仓库。
		 *
		 * @param result - 发现结果。
		 * @param cacheLocations - 是否把顶层仓库位置写回缓存。
		 * @returns 无。
		 */
		const apply = (result: { nodes: RepoNode[]; truncated: boolean; usedCache: boolean }, cacheLocations: boolean): void => {
			if (controller.signal.aborted) return;
			baseNodesRef.current = result.nodes;
			const attached = attachChildren(result.nodes, childrenByPathRef.current);
			// 持久化选中的节点不在本次结果里时记下来：补齐后可能才出现，届时再认领。
			const plan = planSelection(attached, root, loadSelection(sessionId));
			pendingSelectionRef.current = plan.pendingId;
			const initial = findNode(attached, plan.selectedId);
			setRepoNodes(attached);
			// 纠正后消失的仓库：作废其补齐记录与标记，位置再次出现时会重新补齐。
			const paths = new Set(result.nodes.filter((node) => node.kind === 'repo').map((node) => node.path));
			if (childrenByPathRef.current.size > 0) {
				const next = new Map<string, RepoNode[]>();
				for (const [path, children] of childrenByPathRef.current) {
					if (paths.has(path)) next.set(path, children);
				}
				if (next.size !== childrenByPathRef.current.size) childrenByPathRef.current = next;
			}
			for (const path of enrichClaims.current.keys()) {
				if (!paths.has(path)) enrichClaims.current.forget([path]);
			}
			setSelectedId(initial === null ? null : initial.id);
			setExpandedIds((previous) => {
				const next = new Set(previous);
				if (initial !== null) for (const id of ancestryOf(attached, initial.id)) next.add(id);
				return next;
			});
			setTreeStatus('ready');
			setTreeNote(result.truncated ? '已达到扫描上限，仅显示部分仓库' : null);
			// 缓存只记顶层仓库：工作树与子模块依附于仓库，随 checkout 变化，运行时枚举即可。
			if (cacheLocations) {
				const topLevel = result.nodes.filter((node) => node.kind === 'repo').map((node) => ({ path: node.path, name: node.name }));
				// 宿主已按持久化位置取树时位置未变，只更新内存镜像；否则位置可能已变化，落盘一次。
				if (result.usedCache) rememberRepoLocations(root, topLevel);
				else saveRepoLocations(root, topLevel);
			}
		};
		const fail = (error: unknown): void => {
			if (controller.signal.aborted) return;
			setRepoNodes([]);
			setTreeStatus('error');
			setTreeNote(error instanceof Error ? error.message : String(error));
		};

		/**
		 * 首屏走浅层发现，随后在空闲回调里补齐工作树与子模块。
		 *
		 * 浅层发现只产出顶层仓库节点：宿主命中持久化位置时不起 git 子进程，因此界面能立即出内容。
		 * 位置缓存由宿主自行读取，这里不再单独预取一次；没有缓存时宿主退回完整扫描。
		 *
		 * @returns 无。
		 */
		const start = async (): Promise<void> => {
			setTreeStatus('loading');
			setTreeNote(null);
			const result = await discoverRepositories(root, { shallow: true }, controller.signal);
			apply(result, true);
			if (controller.signal.aborted) return;
			/*
			 * 后台纠正仓库位置：持久化位置可能已过期（仓库被移动、删除或新增）。这一路必须绕开
			 * 宿主的持久化位置，否则会再次返回同一份结果、永远扫不到变化。
			 */
			if (result.usedCache) {
				apply(await discoverRepositories(root, { shallow: true, fullScan: true }, controller.signal), true);
			}
		};
		void start().catch(fail);
		return () => { controller.abort(); };
	}, [cwd, sessionId, hasWorkspace, scanSeq]);

	/**
	 * 重新扫描仓库树。
	 *
	 * 补齐记录一并作废：工作树与子模块可能已被增删，重新枚举才会反映变化。只作废记录而不清空
	 * 标记，是让每轮重扫都重新枚举一次。
	 */
	const rescan = React.useCallback(() => {
		setSyncById(new Map());
		childrenByPathRef.current = new Map();
		enrichClaims.current.clear();
		setScanSeq((previous) => previous + 1);
	}, []);

	/** 选中一个仓库节点并持久化。 */
	const selectNode = React.useCallback((node: RepoNode) => {
		// 用户手动选中即作废待认领的持久化选中，避免补齐后把选中改回去。
		pendingSelectionRef.current = null;
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

	/* ── 后台补齐工作树与子模块 ─────────────────────────── */

	/** 一次补齐失败后的重试序号：递增以驱动下一轮空闲回调。 */
	const [enrichRetrySeq, setEnrichRetrySeq] = React.useState(0);

	/*
	 * 一次补齐一批仓库：只取还没有补齐记录的顶层仓库，交宿主枚举工作树与子模块。
	 *
	 * 判据是「补齐记录」而不是「当前有没有 children」：重扫会清空记录，此时树上仍挂着上一轮的
	 * children，按 children 判定就永远重补不到，已删除的工作树会残留。
	 *
	 * 结果按仓库路径存进 childrenByPath，再由 attachChildren 挂到当前树上：补出来的节点不影响
	 * 选中与首屏渲染，因此不阻塞界面。
	 */
	React.useEffect(() => {
		if (!hasWorkspace) return undefined;
		const root = cwd as string;
		let cancelled = false;
		// 本轮请求的取消信号：依赖变化或卸载时中止在途补齐。
		const controller = new AbortController();
		const idle = typeof window.requestIdleCallback === 'function'
			? (fn: () => void): number => window.requestIdleCallback(fn, { timeout: 1500 })
			: (fn: () => void): number => window.setTimeout(fn, 120);
		const cancelIdle = typeof window.cancelIdleCallback === 'function'
			? (handle: number): void => window.cancelIdleCallback(handle)
			: (handle: number): void => window.clearTimeout(handle);
		/** 本次 effect 已下发的路径：取消时按批释放占用，见下方 cleanup。 */
		let issued: string[] = [];
		const handle = idle(() => {
			void (async () => {
				const pending = repoNodes
					.filter((node) => node.kind === 'repo' && !enrichClaims.current.has(node.path))
					.slice(0, ENRICH_BATCH);
				if (pending.length === 0) return;
				const paths = pending.map((node) => node.path);
				issued = paths;
				await runEnrichBatch(paths, {
					claims: enrichClaims.current,
					isCancelled: () => cancelled,
					fetchEnriched: (batch) => enrichRepositories(root, batch, controller.signal),
					requestRetry: () => { setEnrichRetrySeq((previous) => previous + 1); },
					write: (batch, enriched) => {
						// 宿主按入参顺序回投节点，这里按 path 对齐：id 的大小写归一化不必重复推导。
						const byPath = new Map(enriched.map((node) => [node.path, node.children ?? []]));
						const next = new Map(childrenByPathRef.current);
						for (const path of batch) next.set(path, byPath.get(path) ?? []);
						childrenByPathRef.current = next;
						const attached = attachChildren(baseNodesRef.current, next);
						// 补齐后持久化选中的工作树/子模块可能才出现：出现即认领，否则保持首次发现的结果。
						const restored = claimPendingSelection(attached, pendingSelectionRef.current);
						if (restored !== null) {
							pendingSelectionRef.current = null;
							setSelectedId(restored.id);
							setExpandedIds((previous) => {
								const expanded = new Set(previous);
								for (const id of ancestryOf(attached, restored.id)) expanded.add(id);
								return expanded;
							});
						}
						setRepoNodes(attached);
					},
				});
			})();
		});
		/*
		 * 卸载或依赖变化会取消本轮：在途占用必须释放，否则这些路径此后既不下发、也不在已完成集合里，
		 * 工作树与子模块会永久不出现。取消后不再有写入机会，只有 rescan 能恢复。
		 */
		return () => {
			cancelled = true;
			controller.abort();
			cancelIdle(handle);
			if (issued.length > 0) {
				enrichClaims.current.release(issued);
				issued = [];
			}
		};
	}, [repoNodes, cwd, hasWorkspace, enrichRetrySeq]);

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
		// 本轮请求的取消信号：依赖变化或卸载时中止在途预取。
		const controller = new AbortController();
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
					const entries = await loadReposSync(root, paths, controller.signal);
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
					// 整批失败不写入缓存：清除在途后由下一轮空闲回调重试；被取消则不再重试。
					for (const path of paths) syncInFlight.current.delete(path);
					if (cancelled) return;
					setSyncRetrySeq((previous) => previous + 1);
				}
			})();
		});
		return () => { cancelled = true; controller.abort(); cancelIdle(handle); };
	}, [visibleRows, syncById, cwd, hasWorkspace, syncRetrySeq]);

	return {
		repoNodes, treeStatus, treeNote, selectedId, expandedIds, visibleRows, syncById, selectedNode,
		selectNode, toggleNode, setSelectedId, setSyncById, rescan,
	};
}
