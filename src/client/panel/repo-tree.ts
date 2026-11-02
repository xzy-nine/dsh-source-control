import { loadValue, saveValue } from './storage.ts';
import { normalizePath } from '../shared/path-key.ts';

/**
 * 存储库树的纯函数：可见节点展开、选中持久化。
 *
 * 不依赖 React，便于直接单测；渲染与请求留在 panel.js。路径归一化见 `shared/path-key.ts`。
 */

/** 存储键前缀。 */
const SELECTION_KEY = 'dsh-source-control-selection';
const EXPANDED_KEY = 'dsh-source-control-expanded';

/**
 * 按 id 查找节点。
 *
 * @param {object[]} nodes - 仓库节点列表。
 * @param {string|null} id - 节点 id。
 * @returns {object|null} 命中的节点。
 */
export function findNode(nodes, id) {
	if (id === null || id === undefined) return null;
	for (const node of nodes ?? []) {
		if (node.id === id) return node;
		const found = findNode(node.children ?? [], id);
		if (found !== null) return found;
	}
	return null;
}

/**
 * 展开为可见行：仅父节点已展开时才带出子节点。
 *
 * 缩进按树的嵌套层级计算，顶层仓库一律对齐，与发现深度无关。
 *
 * @param {object[]} nodes - 仓库节点列表。
 * @param {Set<string>} expandedIds - 已展开的节点 id。
 * @returns {Array<object>} { node, depth } 行序列。
 */
export function flattenVisible(nodes, expandedIds) {
	const rows = [];
	const walk = (list, level: number) => {
		for (const node of list ?? []) {
			rows.push({ node, depth: level });
			if ((node.children ?? []).length > 0 && expandedIds?.has(node.id)) walk(node.children, level + 1);
		}
	};
	walk(nodes, 0);
	return rows;
}

/**
 * 取节点自身与其祖先的 id。
 *
 * @param {object[]} nodes - 仓库节点列表。
 * @param {string} id - 目标节点 id。
 * @returns {string[]} 从根到目标的 id 序列；未命中时为空。
 */
export function ancestryOf(nodes, id) {
	const path = [];
	const walk = (list) => {
		for (const node of list ?? []) {
			if (node.id === id) {
				path.push(node.id);
				return true;
			}
			if (walk(node.children ?? [])) {
				path.push(node.id);
				return true;
			}
		}
		return false;
	};
	walk(nodes);
	return path.reverse();
}

/**
 * 把已补齐的工作树与子模块挂回浅层节点。
 *
 * 浅层发现只产出顶层仓库节点；补齐结果按仓库路径另行保存，两者在此合流。按路径而不是按
 * 上一轮节点取用，因此：
 * - 后台纠正用新的浅层节点整棵替换时，已补齐的 children 不会丢；
 * - 重新扫描时清掉保存的补齐结果即可让 children 变空，已删除的工作树不会残留。
 *
 * 没有保存记录的仓库按浅层节点原样返回（children 为空）；已带 children 的节点原样采用。
 *
 * @param {object[]} nodes - 本次发现得到的节点。
 * @param {Map<string, object[]>} childrenByPath - 仓库路径 -> 已补齐的 children。
 * @returns {object[]} 挂好 children 的节点。
 */
export function attachChildren(nodes, childrenByPath) {
	return (nodes ?? []).map((node) => {
		if ((node.children ?? []).length > 0) return node;
		const children = childrenByPath?.get(node.path);
		return children === undefined ? node : { ...node, children };
	});
}

/**
 * 在树里按路径查找节点。
 *
 * @param {object[]} nodes - 仓库节点列表。
 * @param {string|null} path - 目标路径。
 * @returns {object|null} 命中的节点；不存在时为 null。
 */
export function findNodeByPath(nodes, path) {
	const target = normalizePath(path);
	if (target === '') return null;
	const walk = (list) => {
		for (const node of list ?? []) {
			if (normalizePath(node.path) === target) return node;
			const found = walk(node.children ?? []);
			if (found !== null) return found;
		}
		return null;
	};
	return walk(nodes);
}
/**
 * 选出初始选中节点：持久化命中优先，其次是工作区根自身，最后取第一个仓库。
 *
 * @param {object[]} nodes - 仓库节点列表。
 * @param {string|null} cwd - 会话工作区路径。
 * @param {string|null} restoredId - 持久化的节点 id。
 * @returns {object|null} 选中节点。
 */
export function selectInitial(nodes, cwd, restoredId) {
	const restored = findNode(nodes, restoredId);
	if (restored !== null) return restored;
	const target = normalizePath(cwd);
	if (target !== '') {
		for (const node of nodes ?? []) {
			if (normalizePath(node.path) === target) return node;
		}
	}
	return (nodes ?? [])[0] ?? null;
}

/**
 * 规划一次发现结果落地后的选中。
 *
 * 持久化选中的可能是工作树或子模块，而浅层树里没有这些节点，`selectInitial` 只能回退成第一个
 * 仓库。此时把原 id 作为「待认领」一并返回，等补齐出该节点后再改回选中。
 *
 * @param {object[]} nodes - 挂好 children 的节点列表。
 * @param {string|null} cwd - 会话工作区路径。
 * @param {string|null} restoredId - 持久化的节点 id。
 * @returns {{ selectedId: string|null, pendingId: string|null }} 选中 id 与待认领 id。
 */
export function planSelection(nodes, cwd, restoredId) {
	const initial = selectInitial(nodes, cwd, restoredId);
	const selectedId = initial === null ? null : initial.id;
	const pendingId = restoredId !== null && restoredId !== undefined && selectedId !== restoredId ? restoredId : null;
	return { selectedId, pendingId };
}

/**
 * 在补齐后的树里认领待认领的选中节点。
 *
 * @param {object[]} nodes - 挂好 children 的节点列表。
 * @param {string|null} pendingId - 待认领的节点 id。
 * @returns {object|null} 命中的节点；仍不存在时为 null。
 */
export function claimPendingSelection(nodes, pendingId) {
	if (pendingId === null || pendingId === undefined) return null;
	return findNode(nodes, pendingId);
}

/**
 * 读取持久化的选中节点。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {string|null} 节点 id。
 */
export function loadSelection(sessionId) {
	return readStored(SELECTION_KEY, sessionId);
}

/**
 * 写入选中的节点 id。
 *
 * @param {string} sessionId - 会话 id。
 * @param {string|null} id - 节点 id。
 * @returns {void}
 */
export function saveSelection(sessionId, id) {
	writeStored(SELECTION_KEY, sessionId, id);
}

/**
 * 读取持久化的展开集合。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {Set<string>} 节点 id 集合。
 */
export function loadExpanded(sessionId) {
	const raw = readStored(EXPANDED_KEY, sessionId);
	if (raw === null || raw === '') return new Set();
	try {
		const parsed = JSON.parse(raw);
		return new Set(Array.isArray(parsed) ? parsed : []);
	} catch {
		return new Set();
	}
}

/**
 * 写入展开集合。
 *
 * @param {string} sessionId - 会话 id。
 * @param {Set<string>} ids - 节点 id 集合。
 * @returns {void}
 */
export function saveExpanded(sessionId, ids) {
	writeStored(EXPANDED_KEY, sessionId, JSON.stringify([...ids]));
}

/**
 * 读取一个会话维度下的存储值。
 *
 * @param {string} prefix - 键前缀。
 * @param {string} sessionId - 会话 id。
 * @returns {string|null} 存储值。
 */
function readStored(prefix, sessionId) {
	const value = loadValue<string | null>(`${prefix}:${sessionId ?? ''}`, null);
	return typeof value === 'string' ? value : null;
}

/**
 * 写入一个会话维度下的存储值。
 *
 * @param {string} prefix - 键前缀。
 * @param {string} sessionId - 会话 id。
 * @param {string|null} value - 存储值；null 表示删除。
 * @returns {void}
 */
function writeStored(prefix, sessionId, value) {
	saveValue(`${prefix}:${sessionId ?? ''}`, value ?? null);
}
