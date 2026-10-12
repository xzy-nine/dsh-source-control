/**
 * 存储库树的纯函数：路径规范化、可见节点展开、选中持久化。
 *
 * 不依赖 React，便于直接单测；渲染与请求留在 panel.js。
 */

/** localStorage 键前缀。 */
const SELECTION_KEY = 'dsh-git-graph-selection';
const EXPANDED_KEY = 'dsh-git-graph-expanded';

/** 运行环境是否按大小写不敏感比较路径。 */
const CASE_INSENSITIVE = typeof navigator !== 'undefined'
	&& (/Windows/i.test(navigator.userAgent ?? ''));

/**
 * 把路径规范化为与宿主节点 id 一致的形式。
 *
 * @param {string} path - 任意路径。
 * @returns `/` 分隔、去掉尾斜杠的路径；大小写不敏感环境下统一小写。
 */
export function normalizePath(path) {
	const normalized = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
	const insensitive = CASE_INSENSITIVE || /^[a-zA-Z]:\//.test(normalized);
	return insensitive ? normalized.toLowerCase() : normalized;
}

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
	const walk = (list, level) => {
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
	try {
		return localStorage.getItem(`${prefix}:${sessionId ?? ''}`);
	} catch {
		return null;
	}
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
	try {
		const key = `${prefix}:${sessionId ?? ''}`;
		if (value === null || value === undefined) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		/* 持久化失败时退回内存态 */
	}
}
