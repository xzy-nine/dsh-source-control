/**
 * 存储库发现：按会话工作区加载仓库树，并按可见行预取领先/落后。
 */
import React from 'react';
import { discoverRepositories, loadRepoSync } from '../api/index.ts';
import {
	ancestryOf, flattenVisible, loadExpanded, loadSelection, saveExpanded, saveSelection, selectInitial,
} from '../repo-tree.ts';
import type { RepoNode, RepoSync } from '../types.ts';

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
		setTreeStatus('loading');
		setTreeNote(null);
		discoverRepositories(cwd as string, {}, controller.signal).then((result) => {
			if (controller.signal.aborted) return;
			const initial = selectInitial(result.nodes, cwd as string, loadSelection(sessionId));
			setRepoNodes(result.nodes);
			setSelectedId(initial === null ? null : initial.id);
			setExpandedIds((previous) => {
				const next = new Set(previous);
				if (initial !== null) for (const id of ancestryOf(result.nodes, initial.id)) next.add(id);
				return next;
			});
			setTreeStatus('ready');
			if (result.truncated) setTreeNote('已达到扫描上限，仅显示部分仓库');
		}).catch((error: unknown) => {
			if (controller.signal.aborted) return;
			setRepoNodes([]);
			setTreeStatus('error');
			setTreeNote(error instanceof Error ? error.message : String(error));
		});
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

	/*
	 * 一次只预取一个节点：领先/落后要跑三次 git，每个节点都是一次完整的服务端往返；
	 * 并发预取（尤其是仓库树刚重扫、节点全部变化时）会把服务端压满，拖慢其它响应。
	 */
	React.useEffect(() => {
		const pending = visibleRows.filter(({ node }) => !syncById.has(node.id));
		if (pending.length === 0) return undefined;
		let cancelled = false;
		const idle = typeof window.requestIdleCallback === 'function'
			? (fn: () => void): number => window.requestIdleCallback(fn, { timeout: 1500 })
			: (fn: () => void): number => window.setTimeout(fn, 120);
		const cancelIdle = typeof window.cancelIdleCallback === 'function'
			? (handle: number): void => window.cancelIdleCallback(handle)
			: (handle: number): void => window.clearTimeout(handle);
		const handle = idle(() => {
			void (async () => {
				for (const { node } of pending.slice(0, 1)) {
					if (cancelled) return;
					let sync: RepoSync = { branch: null, upstream: null, ahead: 0, behind: 0 };
					try {
						sync = await loadRepoSync(node.path);
					} catch {
						/* 无上游或非仓库时保留空徽标 */
					}
					if (cancelled) return;
					setSyncById((previous) => new Map(previous).set(node.id, sync));
				}
			})();
		});
		return () => { cancelled = true; cancelIdle(handle); };
	}, [visibleRows, syncById]);

	return {
		repoNodes, treeStatus, treeNote, selectedId, expandedIds, visibleRows, syncById, selectedNode,
		selectNode, toggleNode, setSelectedId, setSyncById, rescan,
	};
}
