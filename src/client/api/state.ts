/**
 * 宿主侧状态读写，以及浏览器旧数据的一次性迁移。
 *
 * 持久化统一落在宿主（见 source-control/state-store.ts）；本模块是客户端入口，并在首次
 * 连接时把浏览器 localStorage / sessionStorage 里的旧数据搬到宿主类型化分区，搬完清掉浏览器
 * 旧键即幂等。提交信息草稿是会话级数据，不经本模块迁移。
 */
import { callApi } from './http.ts';

/** 面板布局快照。 */
export interface PanelLayoutSnapshot {
	readonly repoOpen: boolean;
	readonly graphOpen: boolean;
	readonly graphHeight: number;
	readonly repoHeight: number;
}

/** 一个工作区的聚合状态快照。 */
export interface WorkspaceSnapshotState {
	readonly selectedRepo: string | null;
	readonly expandedRepos: readonly string[];
	readonly repos: ReadonlyArray<{ readonly path: string; readonly name: string }>;
	readonly updatedAt: number;
}

/** 宿主状态快照：设置、布局、引用筛选与工作区。 */
export interface StateSnapshot {
	readonly settings: Record<string, unknown> | null;
	readonly layout: PanelLayoutSnapshot | null;
	readonly refFilters: Record<string, 'all' | string[]>;
	readonly workspaces: Record<string, WorkspaceSnapshotState>;
}

/** 空快照。 */
const EMPTY_SNAPSHOT: StateSnapshot = { settings: null, layout: null, refFilters: {}, workspaces: {} };

/**
 * 读取宿主状态快照。
 *
 * @param cwd - 会话工作区路径。
 * @param signal - 取消信号。
 * @returns 快照。
 */
export async function readState(cwd: string, signal?: AbortSignal): Promise<StateSnapshot> {
	const payload = await callApi(cwd, { command: 'readState' }, signal);
	if (typeof payload !== 'object') return EMPTY_SNAPSHOT;
	return {
		settings: payload.settings !== null && typeof payload.settings === 'object' ? payload.settings as Record<string, unknown> : null,
		layout: payload.layout !== null && typeof payload.layout === 'object' ? payload.layout as PanelLayoutSnapshot : null,
		refFilters: payload.refFilters !== null && typeof payload.refFilters === 'object' ? payload.refFilters as Record<string, 'all' | string[]> : {},
		workspaces: payload.workspaces !== null && typeof payload.workspaces === 'object' ? payload.workspaces as Record<string, WorkspaceSnapshotState> : {},
	};
}

/**
 * 写入设置。
 *
 * @param cwd - 会话工作区路径。
 * @param settings - 设置对象；null 清除。
 * @returns 无。
 */
export async function writeSettings(cwd: string, settings: Record<string, unknown> | null): Promise<void> {
	await callApi(cwd, { command: 'writeSettings', settings });
}

/**
 * 写入布局。
 *
 * @param cwd - 会话工作区路径。
 * @param layout - 布局对象；null 清除。
 * @returns 无。
 */
export async function writeLayout(cwd: string, layout: PanelLayoutSnapshot | null): Promise<void> {
	await callApi(cwd, { command: 'writeLayout', layout });
}

/**
 * 写入引用筛选表。
 *
 * @param cwd - 会话工作区路径。
 * @param refFilters - 筛选表。
 * @returns 无。
 */
export async function writeRefFilters(cwd: string, refFilters: Record<string, 'all' | string[]>): Promise<void> {
	await callApi(cwd, { command: 'writeRefFilters', refFilters });
}

/**
 * 写入一个工作区的选中与展开状态。
 *
 * @param cwd - 会话工作区路径，仅作请求的 repo 传参。
 * @param workspaceCwd - 目标工作区根路径；持久化以此分键。
 * @param partial - 待合并的部分状态。
 * @returns 无。
 */
export async function writeWorkspace(cwd: string, workspaceCwd: string, partial: { selectedRepo?: string | null; expandedRepos?: string[] }): Promise<void> {
	const msg: Record<string, unknown> = { command: 'writeWorkspace', cwd: workspaceCwd };
	if (partial.selectedRepo !== undefined) msg.selectedRepo = partial.selectedRepo;
	if (partial.expandedRepos !== undefined) msg.expandedRepos = partial.expandedRepos;
	await callApi(cwd, msg);
}

/**
 * 取回一次此前落在宿主的提交信息草稿。
 *
 * 草稿改为会话级后不再写入宿主，但旧版本可能已把草稿持久化在宿主；调用方在首次挂载时用本函数
 * 取回一次。本函数只读宿主，不删除；调用方在草稿落到会话存储后调用 {@link clearPersistedDraft}
 * 删除旧键，删除失败不影响已取回的文本。
 *
 * @param cwd - 会话工作区路径。
 * @param repoPath - 仓库路径。
 * @returns 取回的草稿文本；无草稿时返回 null。
 */
export async function takePersistedDraft(cwd: string, repoPath: string): Promise<string | null> {
	const payload = await callApi(cwd, { command: 'readDraft', repoPath });
	const draft = (payload as { draft?: unknown }).draft;
	return typeof draft === 'string' && draft !== '' ? draft : null;
}

/**
 * 删除宿主持久化里的一个遗留草稿。
 *
 * @param cwd - 会话工作区路径。
 * @param repoPath - 仓库路径。
 * @returns 无。
 */
export async function clearPersistedDraft(cwd: string, repoPath: string): Promise<void> {
	await callApi(cwd, { command: 'clearDraft', repoPath });
}

/**
 * 读取某个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @returns 仓库位置。
 */
export async function readRepoLocations(cwd: string): Promise<Array<{ path: string; name: string }>> {
	const payload = await callApi(cwd, { command: 'readRepoLocations' });
	const repos = Array.isArray((payload as { repos?: unknown }).repos) ? (payload as { repos: unknown[] }).repos : [];
	return repos.filter((item): item is { path: string; name: string } =>
		item !== null && typeof item === 'object'
		&& typeof (item as { path?: unknown }).path === 'string'
		&& typeof (item as { name?: unknown }).name === 'string');
}

/**
 * 写入某个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @param repos - 顶层仓库位置。
 * @returns 无。
 */
export async function writeRepoLocations(cwd: string, repos: ReadonlyArray<{ path: string; name: string }>): Promise<void> {
	await callApi(cwd, { command: 'writeRepoLocations', repos });
}

/**
 * 旧版浏览器键前缀，需搬到宿主。
 *
 * 这两个常量与下面的迁移循环是本仓库**唯一**允许直接访问 `localStorage` / `sessionStorage`
 * 的位置：旧版把数据存在浏览器里，迁移必须先把它们读出来。迁移完成后浏览器不再是数据源，
 * 新数据一律走宿主持久化（见 `source-control/state-store.ts`）。
 */
const LEGACY_PREFIX = 'dsh-source-control-';
const LEGACY_MIGRATED_KEY = 'dsh-source-control-migrated';

/**
 * 把浏览器里的旧持久化数据搬到宿主。
 *
 * 旧版本把设置、布局与引用筛选存在 localStorage / sessionStorage；迁移后统一由宿主落盘。
 * 客户端只负责收集旧键原样发给宿主，分类与合并由宿主 `mergeLegacyEntries` 统一完成——浏览器不
 * 持久化，也不承担格式转换。提交信息草稿是会话级数据，由 `panel/storage.ts` 的
 * migrateLegacyDrafts 转入会话存储，不进宿主。搬完清掉浏览器旧键即幂等。
 *
 * 浏览器存储只在这一个函数里被读取，且只为搬迁旧键；迁移完成后不再有其它访问点。
 *
 * @param cwd - 会话工作区路径。
 * @returns 无。
 */
export async function migrateLegacyState(cwd: string): Promise<void> {
	if (typeof localStorage === 'undefined') return;
	try {
		const entries: Record<string, unknown> = {};
		const keys: string[] = [];
		for (const store of [localStorage, sessionStorage]) {
			for (let at = 0; at < store.length; at += 1) {
				const key = store.key(at);
				if (key === null) continue;
				if (!key.startsWith(LEGACY_PREFIX)) continue;
				if (key === LEGACY_MIGRATED_KEY) continue;
				if (key in entries) continue;
				const raw = store.getItem(key);
				if (raw === null) continue;
				try { entries[key] = JSON.parse(raw) as unknown; } catch { entries[key] = raw; }
				keys.push(key);
			}
		}
		if (keys.length === 0) return;
		await callApi(cwd, { command: 'mergeLegacyEntries', entries });
		// 搬完清掉浏览器里的旧键：此后宿主是唯一数据源。
		for (const key of keys) {
			try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch { /* 忽略 */ }
		}
	} catch {
		/* 迁移失败不打断面板；下次进入重试 */
	}
}
