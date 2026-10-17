/**
 * 仓库发现：按会话工作区呈现仓库树，树由预加载模块取数并发布。
 *
 * 取数在插件激活时即按会话工作区后台启动（见 ./repo-preload.ts），因此面板打开时通常已有
 * 可直接呈现的树；本 hook 只订阅快照、维护选中与展开，并在挂载时请求一次后台重取。
 */
import React from 'react';
import {
	dropWorkspace, getWorkspaceSnapshot, preloadWorkspace, subscribeWorkspace, type WorkspaceSnapshot,
} from './repo-preload.ts';
import {
	ancestryOf, claimPendingSelection, findNode, flattenVisible, loadExpanded, loadSelection,
	planSelection, saveExpanded, saveSelection,
} from './repo-tree.ts';
import type { RepoNode, RepoSync } from '../shared/types.ts';

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
 * 取树状态。
 *
 * @param snapshot - 工作区快照；未预加载时为 null。
 * @param hasWorkspace - 会话是否有工作区。
 * @returns 树状态。
 */
function treeStatusOf(
	snapshot: WorkspaceSnapshot | null,
	hasWorkspace: boolean,
): 'loading' | 'ready' | 'empty' | 'error' {
	if (!hasWorkspace) return 'empty';
	if (snapshot === null || snapshot.status === 'loading') return 'loading';
	if (snapshot.status === 'error') return 'error';
	return snapshot.nodes.length === 0 ? 'empty' : 'ready';
}

/**
 * 取树的提示文本。
 *
 * @param snapshot - 工作区快照；未预加载时为 null。
 * @returns 提示文本；无提示为 null。
 */
function noteOf(snapshot: WorkspaceSnapshot | null): string | null {
	if (snapshot === null) return null;
	if (snapshot.status === 'error') return snapshot.error;
	return snapshot.truncated ? '已达到扫描上限，仅显示部分仓库' : null;
}

/**
 * 加载仓库树并订阅其更新。
 *
 * @param options - 见 {@link UseReposOptions}。
 * @returns 树状态与操作。
 */
export function useRepos({ cwd, sessionId }: UseReposOptions): UseReposResult {
	const hasWorkspace = cwd !== undefined;
	const initial = hasWorkspace ? getWorkspaceSnapshot(cwd) : null;
	const [repoNodes, setRepoNodes] = React.useState<RepoNode[]>(() => initial?.nodes ?? []);
	const [treeStatus, setTreeStatus] = React.useState<'loading' | 'ready' | 'empty' | 'error'>(
		() => treeStatusOf(initial, hasWorkspace),
	);
	const [treeNote, setTreeNote] = React.useState<string | null>(() => noteOf(initial));
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => loadExpanded(sessionId));
	const [syncById, setSyncById] = React.useState<Map<string, RepoSync>>(
		() => new Map(initial?.syncById ?? []),
	);
	/** 重新扫描序号：作为订阅 effect 的依赖，克隆出新仓库后据此重取。 */
	const [scanSeq, setScanSeq] = React.useState(0);
	/**
	 * 待认领的持久化选中 id。
	 *
	 * 持久化选中的可能是工作树或子模块，而浅层树里没有这些节点：首次发现只能回退成第一个仓库。
	 * 补齐完成后据此把选中改回原节点；用户在此期间手动选过则作废（见 selectNode）。
	 */
	const pendingSelectionRef = React.useRef<string | null>(null);
	/** 已应用过的发现代次：代次变化时才重算选中与展开。 */
	const revisionRef = React.useRef<number>(-1);

	React.useEffect(() => {
		if (!hasWorkspace) {
			setRepoNodes([]);
			setTreeStatus('empty');
			setTreeNote(null);
			revisionRef.current = -1;
			pendingSelectionRef.current = null;
			return undefined;
		}
		const root = cwd;
		revisionRef.current = -1;

		/**
		 * 应用一份快照。
		 *
		 * 发现代次变化时重算选中与展开（持久化选中的工作树在浅层树里找不到，只能先回退）；
		 * 代次未变（补齐或领先/落后更新）时保持选中，只认领补齐后才出现的持久化选中。
		 *
		 * @param snapshot - 工作区快照。
		 * @returns 无。
		 */
		const apply = (snapshot: WorkspaceSnapshot): void => {
			setRepoNodes(snapshot.nodes);
			setTreeStatus(treeStatusOf(snapshot, true));
			setTreeNote(noteOf(snapshot));
			setSyncById(new Map(snapshot.syncById));
			if (snapshot.discoveryRevision !== revisionRef.current) {
				revisionRef.current = snapshot.discoveryRevision;
				const plan = planSelection(snapshot.nodes, root, loadSelection(sessionId));
				pendingSelectionRef.current = plan.pendingId;
				const selected = findNode(snapshot.nodes, plan.selectedId);
				setSelectedId(selected === null ? null : selected.id);
				setExpandedIds((previous) => {
					const next = new Set(previous);
					if (selected !== null) for (const id of ancestryOf(snapshot.nodes, selected.id)) next.add(id);
					return next;
				});
				return;
			}
			const restored = claimPendingSelection(snapshot.nodes, pendingSelectionRef.current);
			if (restored === null) return;
			pendingSelectionRef.current = null;
			setSelectedId(restored.id);
			setExpandedIds((previous) => {
				const next = new Set(previous);
				for (const id of ancestryOf(snapshot.nodes, restored.id)) next.add(id);
				return next;
			});
		};

		/*
		 * 已有结果时后台重取一次；尚未开始时直接启动。
		 *
		 * 重取受预加载模块的冷却约束：同一工作区的多个会话面板各自挂载时不重复做全目录扫描，
		 * 也不会互相中止在途取数。
		 */
		preloadWorkspace(root, getWorkspaceSnapshot(root) === null ? {} : { force: true });
		const current = getWorkspaceSnapshot(root);
		if (current !== null) apply(current);
		return subscribeWorkspace(root, () => {
			const snapshot = getWorkspaceSnapshot(root);
			if (snapshot !== null) apply(snapshot);
		});
	}, [cwd, sessionId, hasWorkspace, scanSeq]);

	/**
	 * 重新扫描仓库树。
	 *
	 * 预加载状态一并丢弃：工作树与子模块可能已被增删，重新枚举才会反映变化。
	 */
	const rescan = React.useCallback(() => {
		if (cwd === undefined) return;
		dropWorkspace(cwd);
		setSyncById(new Map());
		revisionRef.current = -1;
		pendingSelectionRef.current = null;
		setScanSeq((previous) => previous + 1);
	}, [cwd]);

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
				const found = find(node.children);
				if (found !== null) return found;
			}
			return null;
		};
		return find(repoNodes);
	}, [repoNodes, selectedId]);

	return {
		repoNodes, treeStatus, treeNote, selectedId, expandedIds, visibleRows, syncById, selectedNode,
		selectNode, toggleNode, setSelectedId, setSyncById, rescan,
	};
}
