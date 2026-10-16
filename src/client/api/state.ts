/**
 * 宿主侧状态读写，以及浏览器旧数据的一次性迁移。
 *
 * 持久化统一落在宿主（见 source-control/state-store.ts）；本模块是客户端入口，并在首次
 * 连接时把浏览器 localStorage / sessionStorage 里的旧数据搬到宿主，搬完打标记不再重复。
 * 提交信息草稿是会话级数据，不经本模块迁移。
 */
import { callApi } from './http.ts';

/** 迁移完成标记：记在宿主，换浏览器不会重复迁移。 */
const MIGRATED_KEY = 'dsh-source-control-migrated';

/**
 * 需要从浏览器搬到宿主的 localStorage 键前缀。
 *
 * 提交信息草稿（`ggg-commit-msg:`）不在其中：草稿是会话级数据，由调用方按仓库键经
 * `panel/storage.ts` 的会话级读写自行取回，不迁往宿主。
 */
const LEGACY_LOCAL_PREFIXES = ['dsh-source-control-', 'dsh-source-control-ref-filter:'];

/**
 * 读取宿主的全部状态键值。
 *
 * @param cwd - 会话工作区路径。
 * @param signal - 取消信号。
 * @returns 键值表。
 */
export async function readState(cwd: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const payload = await callApi(cwd, { command: 'readState' }, signal);
	const entries = payload.entries;
	return entries !== null && typeof entries === 'object' ? entries as Record<string, unknown> : {};
}

/**
 * 写入宿主的一个状态键值。
 *
 * @param cwd - 会话工作区路径。
 * @param key - 键。
 * @param value - 值；null 表示删除。
 * @returns 无。
 */
export async function writeState(cwd: string, key: string, value: unknown): Promise<void> {
	await callApi(cwd, { command: 'writeState', key, value });
}

/**
 * 取回一次此前落在宿主的提交信息草稿。
 *
 * 草稿改为会话级后不再写入宿主，但旧版本可能已把草稿持久化在宿主；调用方在首次挂载时用本函数
 * 取回一次：键值为非空字符串时返回该文本。本函数只读宿主键，不删除；调用方在草稿落到会话存储
 * 后调用 {@link clearPersistedDraft} 删除旧键，删除失败不影响已取回的文本。
 *
 * @param cwd - 会话工作区路径。
 * @param key - 宿主状态键。
 * @returns 取回的草稿文本；无草稿时返回 null。
 */
export async function takePersistedDraft(cwd: string, key: string): Promise<string | null> {
	const entries = await readState(cwd);
	const value = entries[key];
	if (typeof value !== 'string' || value === '') return null;
	return value;
}

/**
 * 删除宿主持久化里的一个键。
 *
 * 草稿落到会话存储后由调用方用它清掉旧版本遗留在宿主的草稿键，避免旧键长期滞留。
 *
 * @param cwd - 会话工作区路径。
 * @param key - 宿主状态键。
 * @returns 无。
 */
export async function clearPersistedDraft(cwd: string, key: string): Promise<void> {
	await writeState(cwd, key, null);
}

/**
 * 读取某个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @returns 仓库位置。
 */
export async function readRepoLocations(cwd: string): Promise<Array<{ path: string; name: string }>> {
	const payload = await callApi(cwd, { command: 'readRepoLocations' });
	const repos = Array.isArray(payload.repos) ? payload.repos : [];
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
 * 把浏览器里的旧持久化数据搬到宿主，只做一次。
 *
 * 旧版本把设置、布局与引用筛选存在 localStorage / sessionStorage；迁移后统一由宿主落盘。
 * 提交信息草稿是会话级数据，不在 {@link LEGACY_LOCAL_PREFIXES} 内，由调用方经
 * `panel/storage.ts` 的 migrateLegacyDrafts 转入会话存储，不进宿主。已在宿主标记过则跳过；
 * 搬完清掉浏览器里的旧键，避免下次重复读取。
 *
 * @param cwd - 会话工作区路径。
 * @returns 无。
 */
export async function migrateLegacyState(cwd: string): Promise<void> {
	if (typeof localStorage === 'undefined') return;
	try {
		const entries = await readState(cwd);
		if (entries[MIGRATED_KEY] === true) return;
		const pending: Array<[string, unknown]> = [];
		for (const store of [localStorage, sessionStorage]) {
			for (let at = 0; at < store.length; at += 1) {
				const key = store.key(at);
				if (key === null) continue;
				if (!LEGACY_LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
				if (key === MIGRATED_KEY) continue;
				const raw = store.getItem(key);
				if (raw === null) continue;
				try {
					pending.push([key, JSON.parse(raw) as unknown]);
				} catch {
					pending.push([key, raw]);
				}
			}
		}
		for (const [key, value] of pending) await writeState(cwd, key, value);
		await writeState(cwd, MIGRATED_KEY, true);
		// 迁移成功后清掉浏览器里的旧键：此后宿主是唯一数据源。
		for (const [key] of pending) {
			try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch { /* 忽略 */ }
		}
	} catch {
		/* 迁移失败不打断面板；下次进入重试 */
	}
}
