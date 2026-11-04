/**
 * 客户端存储：宿主侧类型化持久化 + 内存缓存，以及会话级存储。
 *
 * 两级存储：
 * - 宿主持久化：数据落在宿主（`$DSH_HOME/dsh-source-control/`），按类型分区。本模块只在首屏预取
 *   一次快照，之后读走内存缓存；写更新缓存并异步落盘。类型化读写用 getSettings/setSettings、
 *   getLayout/setLayout、getRefFilters/setRefFilters、getWorkspace/setWorkspace。
 * - 会话级：提交草稿落在浏览器 sessionStorage，直读直写，不经宿主也不进内存缓存。读写用
 *   {@link loadSessionValue} / {@link saveSessionValue} / {@link clearSessionValue}。
 *
 * 会话级存储是「浏览器不持久化」这条规则**唯一**的例外：草稿随标签页消失正是期望行为，搬进
 * 宿主会让关掉的标签页在下次启动时冒出半截提交信息。除本模块与 `api/state.ts` 的旧键迁移外，
 * 其它模块不直接访问浏览器存储。
 *
 * 预取是异步的，而 `useState(() => get…())` 在挂载时同步执行，因此首次渲染读到的是回退值，
 * 且 useState 的初始值不会随预取完成而重算。调用方须在预取完成后把状态重新按真实值初始化。
 *
 * 本模块是客户端唯一的存储出口，其它模块不直接访问 sessionStorage。
 */
import { normalizePath } from '../shared/path-key.ts';
import {
	readState, writeLayout, writeRefFilters, writeWorkspace, writeSettings,
	type PanelLayoutSnapshot, type StateSnapshot,
} from '../api/index.ts';

/** 内存缓存：宿主状态快照的镜像。 */
let cache: StateSnapshot = { settings: null, layout: null, refFilters: {}, workspaces: {} };

/** 是否已完成首次预取。 */
let primed = false;

/** 预取进行中的 Promise；并发调用共享一次往返。 */
let priming: Promise<void> | null = null;

/** 当前工作区路径；写盘时作为 repo 参数。 */
let currentCwd: string | null = null;
/** 预取完成时的订阅者；预取完成后一次性! 一次性通知。 */
const readyListeners = new Set<() => void>();

/**
 * 路径未确定时暂存的类型化写入。
 *
 * 挂载早期（预取尚未开始）可能先发生写入，此时拿不到 cwd 参数；直接丢弃会让那次改动永久丢失，
 * 因此先记下来，路径确定后一并补写。
 */
const pendingWrites: Array<() => void> = [];

/**
 * 首次预取宿主状态快照到内存缓存。
 *
 * @param cwd - 会话工作区路径。
 * @returns 无。
 */
export async function primeStorage(cwd: string): Promise<void> {
	currentCwd = cwd;
	if (primed) return;
	if (priming !== null) return priming;
	priming = (async () => {
		try {
			cache = await readState(cwd);
			// 补写路径未定期间暂存的改动：预取刚读回的值以后写为准。
			for (const flush of pendingWrites) flush();
			pendingWrites.length = 0;
			primed = true;
			for (const listener of readyListeners) listener();
			readyListeners.clear();
		} catch {
			/* 预取失败时保持空缓存，读写退化为内存态 */
		} finally {
			priming = null;
		}
	})();
	return priming;
}

/**
 * 是否已完成预取。
 *
 * @returns 完成时为 true。
 */
export function storageReady(): boolean {
	return primed;
}

/**
 * 订阅预取完成。
 *
 * 已就绪时立即调用；否则等预取完成后调用一次。
 *
 * @param listener - 预取完成时调用。
 * @returns 取消订阅。
 */
export function subscribeStorage(listener: () => void): () => void {
	if (primed) { listener(); return () => { /* 已就绪，无需取消 */ }; }
	readyListeners.add(listener);
	return () => { readyListeners.delete(listener); };
}

/**
 * 调度一次类型化写入：更新缓存并异步落盘，路径未定时暂存。
 *
 * @param mutateCache - 对缓存的就地更新。
 * @param flush - 落盘写入（cwd 已定时调用）。
 * @returns 无。
 */
function dispatch(mutateCache: () => void, flush: (cwd: string) => Promise<void>): void {
	mutateCache();
	const cwd = currentCwd;
	if (cwd === null) {
		pendingWrites.push(() => { const c = currentCwd; if (c !== null) void flush(c).catch(() => { /* 落盘失败时保留内存态 */ }); });
		return;
	}
	void flush(cwd).catch(() => { /* 落盘失败时保留内存态 */ });
}

/**
 * 读取设置。
 *
 * @returns 设置对象；无时为 null。
 */
export function getSettings(): Record<string, unknown> | null {
	return cache.settings;
}

/**
 * 写入设置。
 *
 * @param settings - 设置对象；null 清除。
 * @returns 无。
 */
export function setSettings(settings: Record<string, unknown> | null): void {
	dispatch(() => { cache = { ...cache, settings }; }, (cwd) => writeSettings(cwd, settings));
}

/**
 * 读取布局。
 *
 * @returns 布局；无时为 null。
 */
export function getLayout(): PanelLayoutSnapshot | null {
	return cache.layout;
}

/**
 * 写入布局。
 *
 * @param layout - 布局对象；null 清除。
 * @returns 无。
 */
export function setLayout(layout: PanelLayoutSnapshot | null): void {
	dispatch(() => { cache = { ...cache, layout }; }, (cwd) => writeLayout(cwd, layout));
}

/**
 * 读取引用筛选表。
 *
 * @returns 筛选表。
 */
export function getRefFilters(): Record<string, 'all' | string[]> {
	return cache.refFilters;
}

/**
 * 写入引用筛选表。
 *
 * @param refFilters - 筛选表。
 * @returns 无。
 */
export function setRefFilters(refFilters: Record<string, 'all' | string[]>): void {
	dispatch(() => { cache = { ...cache, refFilters: { ...refFilters } }; }, (cwd) => writeRefFilters(cwd, refFilters));
}

/**
 * 读取一个工作区的树状态。
 *
 * @param workspaceCwd - 工作区根路径。
 * @returns 选择与展开；无记录时 selectedRepo 为 null、expandedRepos 为空。
 */
export function getWorkspace(workspaceCwd: string): { selectedRepo: string | null; expandedRepos: readonly string[] } {
	const key = normalizePath(workspaceCwd);
	const ws = Object.prototype.hasOwnProperty.call(cache.workspaces, key) ? cache.workspaces[key] : undefined;
	return ws === undefined ? { selectedRepo: null, expandedRepos: [] } : ws;
}

/**
 * 写入一个工作区的部分树状态；合并到缓存中的工作区。
 *
 * @param workspaceCwd - 工作区根路径。
 * @param partial - 待合并的部分状态。
 * @returns 无。
 */
export function setWorkspace(workspaceCwd: string, partial: { selectedRepo?: string | null; expandedRepos?: string[] }): void {
	const key = normalizePath(workspaceCwd);
	if (key === '') return;
	dispatch(() => {
		const prev = Object.prototype.hasOwnProperty.call(cache.workspaces, key) ? cache.workspaces[key] : undefined;
		const selectedRepo = partial.selectedRepo !== undefined ? partial.selectedRepo : prev?.selectedRepo ?? null;
		const expandedRepos = partial.expandedRepos !== undefined ? partial.expandedRepos : prev?.expandedRepos ?? [];
		const repos = prev?.repos ?? [];
		const workspaces = { ...cache.workspaces };
		if (selectedRepo === null && expandedRepos.length === 0 && repos.length === 0) Reflect.deleteProperty(workspaces, key);
		else workspaces[key] = { selectedRepo, expandedRepos, repos, updatedAt: Date.now() };
		cache = { ...cache, workspaces };
	}, (cwd) => writeWorkspace(cwd, workspaceCwd, partial));
}

/**
 * 清掉缓存，使下次预取重新读取。
 *
 * 只涉及宿主持久化的内存镜像，不影响会话级存储。
 *
 * @returns 无。
 */
export function resetStorageCache(): void {
	cache = { settings: null, layout: null, refFilters: {}, workspaces: {} };
	primed = false;
	priming = null;
}

/** 提交信息草稿的键前缀。 */
const DRAFT_KEY_PREFIX = 'ggg-commit-msg:';

/**
 * 按仓库根路径构造提交信息草稿的会话键。
 *
 * @param repoPath - 仓库根绝对路径。
 * @returns 键 `ggg-commit-msg:<repoPath>`。
 */
export function draftKeyOf(repoPath: string): string {
	return `${DRAFT_KEY_PREFIX}${repoPath}`;
}

/**
 * 判断一个键是否为提交信息草稿的会话键。
 *
 * @param key - 存储键。
 * @returns 是草稿键时为 true。
 */
function isDraftKey(key: string): boolean {
	return key.startsWith(DRAFT_KEY_PREFIX);
}

/**
 * 枚举一个 store 里的全部键。
 *
 * 优先用 `key(index)` 按下标遍历；store 未提供该方法时退回 `Object.keys`。
 *
 * @param store - localStorage 或 sessionStorage。
 * @returns 键列表。
 */
function storeKeys(store: Storage): string[] {
	const keys: string[] = [];
	try {
		if (typeof store.key === 'function') {
			for (let at = 0; at < store.length; at += 1) {
				const key = store.key(at);
				if (key !== null) keys.push(key);
			}
			return keys;
		}
		return Object.keys(store);
	} catch {
		return [];
	}
}

/**
 * 把 localStorage / sessionStorage 里的提交信息草稿转入会话存储。
 *
 * 草稿键为 `ggg-commit-msg:<仓库根绝对路径>`，转入目标即 sessionStorage 的同名键：
 * 来源已是 sessionStorage 时等同保留。会话键是转入目标，不删除；只在会话键有值后清掉
 * localStorage 里的同名残留。不写宿主。sessionStorage 不可用时草稿留在原处，下次进入重试。
 *
 * @returns 无。
 */
export function migrateLegacyDrafts(): void {
	const store = sessionStore();
	if (store === null) return;
	const local = typeof localStorage === 'undefined' ? null : localStorage;
	const drafts: Array<[string, string]> = [];
	try {
		for (const source of local === null ? [store] : [local, store]) {
			for (const key of storeKeys(source)) {
				if (!isDraftKey(key)) continue;
				const raw = source.getItem(key);
				if (raw === null) continue;
				drafts.push([key, raw]);
			}
		}
	} catch {
		/* 枚举失败时保留原键，下次进入重试 */
	}
	for (const [key, raw] of drafts) {
		try {
			if (store.getItem(key) === null) store.setItem(key, raw);
		} catch {
			/* 转入失败时保留原键，下次进入重试 */
		}
	}
	try {
		for (const [key] of drafts) {
			// 会话键已有值才清 localStorage 拆留；会话键本身是转入目标，不删除。
			if (store.getItem(key) !== null) local?.removeItem(key);
		}
	} catch {
		/* 清理失败时保留旧键，下次进入! 进入重试 */
	}
}

/**
 * 取 sessionStorage；不存在时返回 null。
 *
 * @returns sessionStorage 或 null。
 */
function sessionStore(): Storage | null {
	return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

/**
 * 读取会话级存储的一个键。
 *
 * sessionStorage 不存在、访问抛错或值不是合法 JSON 时一律给回退值。
 *
 * 只接受解析结果为字符串的值：会话级状态只有草稿，非字符串值（如数字）一律回退。
 *
 * @param key - 键。
 * @param fallback - 回退值。
 * @returns 值或回退值。
 */
export function loadSessionValue<T>(key: string, fallback: T): T {
	try {
		const store = sessionStore();
		if (store === null) return fallback;
		const raw = store.getItem(key);
		if (raw === null) return fallback;
		const parsed = JSON.parse(raw) as unknown;
		return typeof parsed === 'string' ? parsed as T : fallback;
	} catch {
		return fallback;
	}
}

/**
 * 写入会话级存储的一个键。
 *
 * 值为 null / undefined 时删除该键；sessionStorage 不存在或访问抛错时静默。
 *
 * @param key - 键。
 * @param value - 值。
 * @returns 无。
 */
export function saveSessionValue(key: string, value: unknown): void {
	try {
		const store = sessionStore();
		if (store === null) return;
		if (value === null || value === undefined) store.removeItem(key);
		else store.setItem(key, JSON.stringify(value));
	} catch {
		/* 会话存储不可用时静默 */
	}
}

/**
 * 删除会话级存储的一个键。
 *
 * sessionStorage 不存在或访问抛错时静默。
 *
 * @param key - 键。
 * @returns 无。
 */
export function clearSessionValue(key: string): void {
	try {
		sessionStore()?.removeItem(key);
	} catch {
		/* 会话存储不可用时静默 */
	}
}
