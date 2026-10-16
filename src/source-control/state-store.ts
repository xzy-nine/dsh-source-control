/**
 * 宿主侧持久化：插件状态文档落在 `$DSH_HOME/dsh-source-control/` 下。
 *
 * 浏览器端不再承担持久化：面板的设置、布局、引用筛选、仓库位置缓存与提交信息草稿都经
 * 本模块读写，因此换浏览器、换标签页、清缓存都不会丢。写入用 tmp + rename 原子替换，
 * 避免半截文件。
 *
 * home 解析与 DSH 的 `dsh-home-paths` 同序：`DSH_SOURCE_CONTROL_HOME`（单测隔离）
 * → `DSH_HOME` → `~/.dsh`。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 状态文档文件名。 */
const STATE_FILE = 'state.json';

/** 一个工作区的仓库位置缓存条目。 */
export interface CachedRepoLocation {
	readonly path: string;
	readonly name: string;
}

/** 持久化的文档形状：所有键值对与仓库位置缓存。 */
interface StateDocument {
	/** 结构版本；不符时按空文档处理，避免读到旧结构。 */
	readonly version: number;
	/** 键值对：设置、布局、引用筛选、提交信息草稿等。 */
	readonly entries: Record<string, unknown>;
	/** 工作区路径 -> 顶层仓库位置。 */
	readonly repos: Record<string, CachedRepoLocation[]>;
}

/** 当前结构版本。 */
const STATE_VERSION = 1;

/** 内存态文档；首次读取时从磁盘载入。 */
let document: StateDocument | null = null;

/** 状态文档的绝对路径；home 不可用时为 null。 */
let statePath: string | null = null;

/**
 * 解析插件状态目录。
 *
 * @returns 状态文档路径；无法定位 home 时为 null。
 */
function resolveStatePath(): string | null {
	const override = process.env.DSH_SOURCE_CONTROL_HOME;
	if (override !== undefined && override.trim().length > 0) return join(override.trim(), STATE_FILE);
	const envHome = process.env.DSH_HOME;
	if (envHome !== undefined && envHome.trim().length > 0) return join(envHome.trim(), 'dsh-source-control', STATE_FILE);
	return join(homedir(), '.dsh', 'dsh-source-control', STATE_FILE);
}

/**
 * 取状态文档路径。
 *
 * @returns 路径；无法定位时为 null。
 */
function pathOf(): string | null {
	if (statePath === null) statePath = resolveStatePath();
	return statePath;
}

/**
 * 从磁盘载入文档；结构不符或读取失败时给空文档。
 *
 * @returns 文档。
 */
function load(): StateDocument {
	if (document !== null) return document;
	const path = pathOf();
	if (path === null) { document = { version: STATE_VERSION, entries: {}, repos: {} }; return document; }
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StateDocument>;
		document = parsed.version === STATE_VERSION && parsed.entries !== undefined && parsed.repos !== undefined
			? { version: STATE_VERSION, entries: parsed.entries, repos: parsed.repos }
			: { version: STATE_VERSION, entries: {}, repos: {} };
	} catch {
		document = { version: STATE_VERSION, entries: {}, repos: {} };
	}
	return document;
}

/**
 * 原子写回文档。
 *
 * @param next - 新文档。
 * @returns 无。
 */
function save(next: StateDocument): void {
	document = next;
	const path = pathOf();
	if (path === null) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = path + '.tmp';
		writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
		renameSync(tmp, path);
	} catch {
		/* 写盘失败时保留内存态，不打断面板 */
	}
}

/**
 * 读取一个键值。
 *
 * @param key - 键。
 * @returns 值；不存在时为 null。
 */
export function readEntry(key: string): unknown {
	const value = load().entries[key];
	return value === undefined ? null : value;
}

/**
 * 写入一个键值；值为 null 时删除该键。
 *
 * @param key - 键。
 * @param value - 值。
 * @returns 无。
 */
export function writeEntry(key: string, value: unknown): void {
	const current = load();
	const entries = { ...current.entries };
	if (value === null || value === undefined) Reflect.deleteProperty(entries, key);
	else entries[key] = value;
	save({ ...current, entries });
}

/**
 * 读取全部键值；面板首屏一次取回，避免逐个往返。
 *
 * @returns 键值表。
 */
export function readEntries(): Record<string, unknown> {
	return { ...load().entries };
}

/**
 * 读取某个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @returns 缓存的仓库位置；无缓存时为空数组。
 */
export function readRepoLocations(cwd: string): CachedRepoLocation[] {
	const cached = load().repos[cwd];
	return Array.isArray(cached) ? cached : [];
}

/**
 * 写入某个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @param repos - 顶层仓库位置。
 * @returns 无。
 */
export function writeRepoLocations(cwd: string, repos: readonly CachedRepoLocation[]): void {
	const current = load();
	save({ ...current, repos: { ...current.repos, [cwd]: repos.map((repo) => ({ path: repo.path, name: repo.name })) } });
}

/**
 * 列出已缓存仓库位置的工作区根路径。
 *
 * @returns 工作区根路径；无缓存时为空数组。
 */
export function listRepoLocationWorkspaces(): string[] {
	return Object.keys(load().repos);
}

/**
 * 清掉内存态，使下次读取重新落盘载入。
 *
 * @returns 无。
 */
export function resetStateCache(): void {
	document = null;
	statePath = null;
}
