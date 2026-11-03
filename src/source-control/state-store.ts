/**
 * 宿主侧持久化：插件状态文档落在 \`$DSH_HOME/dsh-source-control/\` 下。
 *
 * 文档按类型分区（设置、布局、引用筛选、工作区、草稿），单一 schemaVersion 驱动迁移。
 * 持久化的归属维度是**工作区与仓库**，不是对话：\`workspaces[normCwd]\` 一个键承载该工作区根的
 * 选中仓库、展开集合、已知仓库位置与更新时刻，同一工作区下的多个会话共享同一份树状态。
 * 浏览器端不承担持久化：换浏览器、换标签页、清缓存都不会丢。写入用 tmp + rename 原子替换，
 * 避免半截文件；所有访问器经 load()/save() 单一调度。
 *
 * home 解析与 DSH 的 \`dsh-home-paths\` 同序：\`DSH_SOURCE_CONTROL_HOME\`（单测隔离）
 * → \`DSH_HOME\` → \`~/.dsh\`。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { logWarn } from './logger.js';
import { readSessionCwd } from './dsh-session-cwd.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 状态文档文件名。 */
const STATE_FILE = 'state.json';

/** 一个工作区的仓库位置缓存条目。 */
export interface CachedRepoLocation {
	readonly path: string;
	readonly name: string;
}

/** 面板布局：分区展开态与高度。 */
export interface PanelLayout {
	readonly repoOpen: boolean;
	readonly graphOpen: boolean;
	readonly graphHeight: number;
	readonly repoHeight: number;
}

/** 一个工作区根的聚合状态：选中仓库、展开集合、已知仓库位置与更新时刻。 */
export interface WorkspaceState {
	readonly selectedRepo: string | null;
	readonly expandedRepos: readonly string[];
	readonly repos: readonly CachedRepoLocation[];
	readonly updatedAt: number;
}

/** 引用筛选持久化表：仓库键到「全部」或手选 id 列表；自动模式不落盘。 */
export type RefFilterMap = Record<string, 'all' | string[]>;

/** 文档的各分区内容；schemaVersion 由 {@link makeDocument} 单点补上。 */
interface DocumentParts {
	readonly settings: Record<string, unknown> | null;
	readonly layout: PanelLayout | null;
	readonly refFilters: RefFilterMap;
	readonly workspaces: Record<string, WorkspaceState>;
	readonly drafts: { readonly commitMessages: Record<string, string> } | null;
}

/** 持久化的文档形状（schemaVersion 3）。 */
interface StateDocument extends DocumentParts {
	readonly schemaVersion: 3;
}

/** 当前结构版本。 */
const SCHEMA_VERSION = 3 as const;

/** 工作区清理：超过该毫秒数未更新的工作区视为过期。 */
const WORKSPACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 工作区清理：保留的条数上限，超出按 updatedAt 升序删最旧。 */
const WORKSPACE_CAP = 200;

/** 布局缺省值，与客户端 use-panel-layout.ts 对齐。 */
const DEFAULT_LAYOUT: PanelLayout = { repoOpen: true, graphOpen: true, graphHeight: 320, repoHeight: 200 };

/** 内存态文档；首次读取时从磁盘载入。 */
let stateDoc: StateDocument | null = null;

/** 状态文档的绝对路径；home 不可用时为 null。 */
let statePath: string | null = null;

/**
 * 路径键归一化：统一 \`/\` 分隔、去尾斜杠、盘符路径小写。
 *
 * 与客户端 \`src/client/shared/path-key.ts\` 的 normalizePath 等价，使同一仓库在不同来源下的
 * 写法（\`E:\\x\` / \`e:/x/\`）落到同一个键。Node 无 navigator，按平台与盘符前缀判定大小写。
 *
 * @param path - 任意路径。
 * @returns 规范化键。
 */
export function normalizePath(path: string | null | undefined): string {
	const normalized = (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
	const insensitive = process.platform === 'win32' || /^[a-zA-Z]:\//.test(normalized);
	return insensitive ? normalized.toLowerCase() : normalized;
}

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

/** 空文档。 */
function emptyDoc(): StateDocument {
	return { schemaVersion: SCHEMA_VERSION, settings: null, layout: null, refFilters: {}, workspaces: {}, drafts: null };
}

/**
 * 从磁盘载入文档；旧版文档自动迁移到当前结构并落盘，结构不符或读取失败时给空文档。
 *
 * @returns 文档。
 */
function load(): StateDocument {
	if (stateDoc !== null) return stateDoc;
	const path = pathOf();
	if (path === null) { stateDoc = emptyDoc(); return stateDoc; }
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		if (raw.schemaVersion === SCHEMA_VERSION) {
			stateDoc = coerceV3(raw);
		} else if (raw.schemaVersion === 2) {
			stateDoc = migrateV2ToV3(raw);
			save(stateDoc);
		} else if (raw.version === 1 || raw.schemaVersion === undefined) {
			const mtime = existsSync(path) ? statSync(path).mtimeMs : Date.now();
			stateDoc = migrateV1ToV3(raw, mtime, readSessionCwd);
			save(stateDoc);
		} else {
			stateDoc = emptyDoc();
			logWarn('state', `状态文档结构版本不符（期望 ${String(SCHEMA_VERSION)}，读到 ${String(raw.schemaVersion ?? raw.version)}），已按空文档处理：${path}`);
		}
	} catch (error) {
		stateDoc = emptyDoc();
		// 首次运行没有该文件属正常，只有确实存在却读不出来时才记。
		if (existsSync(path)) logWarn('state', `状态文档读取失败，已按空文档处理：${path}：${error instanceof Error ? error.message : String(error)}`);
	}
	return stateDoc;
}

/**
 * 把已是当前形状的原始对象收敛成 StateDocument，补缺字段。
 *
 * @param raw - 已带 schemaVersion===3 的对象。
 * @returns 文档。
 */
function coerceV3(raw: Record<string, unknown>): StateDocument {
	return {
		schemaVersion: SCHEMA_VERSION,
		settings: raw.settings !== null && typeof raw.settings === 'object' ? raw.settings as Record<string, unknown> : null,
		layout: coerceLayout(raw.layout),
		refFilters: coerceRefFilters(raw.refFilters),
		workspaces: coerceWorkspaces(raw.workspaces),
		drafts: coerceDrafts(raw.drafts),
	};
}

function coerceLayout(value: unknown): PanelLayout | null {
	if (value === null || typeof value !== 'object') return null;
	const v = value as Record<string, unknown>;
	return {
		repoOpen: typeof v.repoOpen === 'boolean' ? v.repoOpen : DEFAULT_LAYOUT.repoOpen,
		graphOpen: typeof v.graphOpen === 'boolean' ? v.graphOpen : DEFAULT_LAYOUT.graphOpen,
		graphHeight: typeof v.graphHeight === 'number' ? v.graphHeight : DEFAULT_LAYOUT.graphHeight,
		repoHeight: typeof v.repoHeight === 'number' ? v.repoHeight : DEFAULT_LAYOUT.repoHeight,
	};
}

export function coerceRefFilters(value: unknown): RefFilterMap {
	if (value === null || typeof value !== 'object') return {};
	const out: RefFilterMap = {};
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (v === 'all') out[key] = 'all';
		else if (Array.isArray(v) && v.every((id) => typeof id === 'string')) out[key] = v;
	}
	return out;
}

/**
 * 把一个工作区的原始对象收敛成 WorkspaceState。
 *
 * @param value - 工作区原始值。
 * @returns 工作区状态；形状不可用时为 null。
 */
function coerceWorkspace(value: unknown): WorkspaceState | null {
	if (value === null || typeof value !== 'object') return null;
	const w = value as Record<string, unknown>;
	const expanded = Array.isArray(w.expandedRepos) ? w.expandedRepos.filter((x): x is string => typeof x === 'string') : [];
	return {
		selectedRepo: typeof w.selectedRepo === 'string' ? w.selectedRepo : null,
		expandedRepos: expanded,
		repos: coerceRepoLocations(w.repos),
		updatedAt: typeof w.updatedAt === 'number' ? w.updatedAt : Date.now(),
	};
}

function coerceWorkspaces(value: unknown): Record<string, WorkspaceState> {
	if (value === null || typeof value !== 'object') return {};
	const out: Record<string, WorkspaceState> = {};
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		const ws = coerceWorkspace(v);
		if (ws !== null) out[key] = ws;
	}
	return out;
}

/**
 * 把一组仓库位置收敛成条目列表。
 *
 * @param value - 原始数组。
 * @returns 条目列表；非法项丢弃。
 */
function coerceRepoLocations(value: unknown): CachedRepoLocation[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
		.filter((item) => typeof item.path === 'string' && typeof item.name === 'string')
		.map((item) => ({ path: item.path as string, name: item.name as string }));
}

function coerceDrafts(value: unknown): { readonly commitMessages: Record<string, string> } | null {
	if (value === null || typeof value !== 'object') return null;
	const cm = (value as Record<string, unknown>).commitMessages;
	if (cm === null || typeof cm !== 'object') return null;
	const out: Record<string, string> = {};
	for (const [key, v] of Object.entries(cm as Record<string, unknown>)) {
		if (typeof v === 'string' && v !== '') out[key] = v;
	}
	return Object.keys(out).length > 0 ? { commitMessages: out } : null;
}

/**
 * 把字符串列表收敛成非空字符串数组。
 *
 * @param value - 待收敛的值。
 * @returns 非空字符串组成的数组。
 */
function idsOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((id): id is string => typeof id === 'string' && id !== '');
}

/**
 * 取一个引用短名在旧版按名字保存下的完整 id。
 *
 * 与客户端 refs.ts 的 refIdOf 一致：含 \`/\` 推断为远程分支，否则本地分支。旧版不区分标签，
 * 迁移后由手选校验丢弃或回退。
 *
 * @param name - 引用短名。
 * @returns 完整引用名。
 */
function refIdOf(name: string): string {
	if (name.startsWith('refs/')) return name;
	if (name.includes('/')) return `refs/remotes/${name}`;
	return `refs/heads/${name}`;
}

/**
 * 把旧版按仓库键的 \`{ mode, selected }\` 折合成持久化形态。
 *
 * @param value - 旧版持久化值。
 * @returns \`'all'\` 或手选 id 列表；自动模式或不可识别时为 null（不落盘）。
 */
function legacyRefFilterStored(value: unknown): 'all' | string[] | null {
	if (value === null || typeof value !== 'object') return null;
	const v = value as Record<string, unknown>;
	if (v.mode === 'all') return 'all';
	if (v.mode === 'auto') return null;
	if (v.mode !== 'manual') return null;
	const names = idsOf(v.selected);
	if (names.length === 0) return null;
	return names.map(refIdOf);
}

/**
 * 把 expanded 的两种历史形态统一成 string[]。
 *
 * @param value - 数组或字符串化的 JSON 数组。
 * @returns 节点 id 列表。
 */
function normalizeExpanded(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
		} catch {
			return [];
		}
	}
	return [];
}

/**
 * 解析 sessionId 到工作区根路径。
 *
 * @param sessionId - 会话 id。
 * @returns 工作区根路径；无法还原时为 null。
 */
export type SessionCwdResolver = (sessionId: string) => string | null;

/** 按会话键的选中与展开；迁移的中间形态。 */
interface SessionFold {
	readonly selectedRepo: string | null;
	readonly expandedRepos: readonly string[];
	readonly updatedAt: number;
}

/** 一个工作区的树状态；迁移与合并的中间形态，不含仓库位置。 */
interface WorkspaceTree {
	readonly selectedRepo: string | null;
	readonly expandedRepos: readonly string[];
	readonly updatedAt: number;
}

/**
 * 把按会话分区的选中/展开折合进按工作区键的树状态表。
 *
 * 一个会话只能还原出一个工作区；多个会话落到同一工作区时按 updatedAt 取最新一条——选中与展开
 * 是「上次离开这个地方时的样子」，取最近一次才符合预期，求并集会把用户从未在此展开过的节点带进来。
 *
 * @param trees - 就地合并的树状态表。
 * @param sessions - 按 sessionId 的选中与展开。
 * @param resolveCwd - sessionId 到工作区根路径的解析器。
 * @returns 无。
 */
function foldSessionsIntoWorkspaces(
	trees: Map<string, WorkspaceTree>,
	sessions: Record<string, SessionFold>,
	resolveCwd: SessionCwdResolver,
): void {
	for (const [sessionId, state] of Object.entries(sessions)) {
		if (state.selectedRepo === null && state.expandedRepos.length === 0) continue;
		const cwd = resolveCwd(sessionId);
		if (cwd === null) continue;
		const key = normalizePath(cwd);
		if (key === '') continue;
		const prev = trees.get(key);
		if (prev !== undefined && prev.updatedAt > state.updatedAt) continue;
		trees.set(key, { selectedRepo: state.selectedRepo, expandedRepos: state.expandedRepos, updatedAt: state.updatedAt });
	}
}

/**
 * 把树状态与仓库位置合成为工作区表。
 *
 * 两者是不同字段、不同来源，合并时不互相覆盖也不互相阻碍：仓库位置只有一个来源，树状态在会话之间
 * 按 updatedAt 竞争。updatedAt 取各来源的最大值；只有仓库位置、没有树状态的工作区用 stampedAt
 * （迁移时刻）作时间戳，否则该工作区会被立即判为过期。
 *
 * @param trees - 按工作区键的树状态。
 * @param reposByKey - 按工作区键的仓库位置。
 * @param existing - 现有工作区表；合并浏览器旧键时保留其中未被覆盖的字段与时间戳。
 * @param stampedAt - 仅仓库位置、无其它时间来源时的兜底时间戳。
 * @returns 工作区表。
 */
function assembleWorkspaces(
	trees: ReadonlyMap<string, WorkspaceTree>,
	reposByKey: Readonly<Record<string, readonly CachedRepoLocation[]>>,
	existing: Readonly<Record<string, WorkspaceState>>,
	stampedAt: number,
): Record<string, WorkspaceState> {
	const keys = new Set<string>([...trees.keys(), ...Object.keys(reposByKey), ...Object.keys(existing)]);
	const out: Record<string, WorkspaceState> = {};
	for (const key of keys) {
		const tree = trees.get(key);
		const prev = Object.prototype.hasOwnProperty.call(existing, key) ? existing[key] : undefined;
		const incoming = Object.prototype.hasOwnProperty.call(reposByKey, key) ? reposByKey[key] : undefined;
		const repos = incoming ?? prev?.repos ?? [];
		if (tree === undefined && repos.length === 0 && prev === undefined) continue;
		out[key] = {
			selectedRepo: tree !== undefined ? tree.selectedRepo : prev?.selectedRepo ?? null,
			expandedRepos: tree !== undefined ? tree.expandedRepos : prev?.expandedRepos ?? [],
			repos: [...repos],
			updatedAt: Math.max(prev?.updatedAt ?? 0, tree?.updatedAt ?? 0) || stampedAt,
		};
	}
	return out;
}

/** 旧版 entries 里的键前缀。 */
const V1_SELECTION_PREFIX = 'dsh-source-control-selection:';
const V1_EXPANDED_PREFIX = 'dsh-source-control-expanded:';
const V1_REF_FILTER_KEY = 'dsh-source-control-ref-filter';
const V1_REF_FILTER_PREFIX = 'dsh-source-control-ref-filter:';
const V1_SETTINGS_KEY = 'dsh-source-control-settings';
const V1_REPO_OPEN_KEY = 'dsh-source-control-repo-open';
const V1_GRAPH_OPEN_KEY = 'dsh-source-control-graph-open';
const V1_GRAPH_HEIGHT_KEY = 'dsh-source-control-graph-height';
const V1_REPO_HEIGHT_KEY = 'dsh-source-control-repo-height';
const V1_DRAFT_PREFIX = 'ggg-commit-msg:';

/** 基线与迁移共用的分类结果。 */
interface ClassifiedEntries {
	readonly settings: Record<string, unknown> | null;
	readonly layout: PanelLayout | null;
	readonly refFilters: RefFilterMap;
	readonly sessions: Record<string, SessionFold>;
	readonly drafts: { readonly commitMessages: Record<string, string> } | null;
}

/**
 * 把平铺 entries 按类型分类。
 *
 * 纯函数，供文档迁移与浏览器旧键合并共用。expanded 统一成 string[]（数组直接用、字符串
 * JSON.parse 失败给空）；ref-filter 全局表与旧按仓库键合并（全局表优先）；路径键过 normalizePath；
 * 草稿只留非空。layout 在 entries 无任何布局键时为 null。
 *
 * @param entries - 平铺 entries。
 * @param fallbackUpdatedAt - 会话 updatedAt 缺省时刻。
 * @returns 分类结果。
 */
function classifyEntries(entries: Record<string, unknown>, fallbackUpdatedAt: number): ClassifiedEntries {
	const settings = entries[V1_SETTINGS_KEY];
	const hasLayoutKey = V1_REPO_OPEN_KEY in entries || V1_GRAPH_OPEN_KEY in entries || V1_GRAPH_HEIGHT_KEY in entries || V1_REPO_HEIGHT_KEY in entries;
	const layout: PanelLayout | null = hasLayoutKey ? {
		repoOpen: typeof entries[V1_REPO_OPEN_KEY] === 'boolean' ? entries[V1_REPO_OPEN_KEY] : DEFAULT_LAYOUT.repoOpen,
		graphOpen: typeof entries[V1_GRAPH_OPEN_KEY] === 'boolean' ? entries[V1_GRAPH_OPEN_KEY] : DEFAULT_LAYOUT.graphOpen,
		graphHeight: typeof entries[V1_GRAPH_HEIGHT_KEY] === 'number' ? entries[V1_GRAPH_HEIGHT_KEY] : DEFAULT_LAYOUT.graphHeight,
		repoHeight: typeof entries[V1_REPO_HEIGHT_KEY] === 'number' ? entries[V1_REPO_HEIGHT_KEY] : DEFAULT_LAYOUT.repoHeight,
	} : null;

	// ref-filter：先折合旧按仓库键，再叠加全局表（全局表优先）。
	const refFilters: RefFilterMap = {};
	for (const [key, value] of Object.entries(entries)) {
		if (!key.startsWith(V1_REF_FILTER_PREFIX)) continue;
		const stored = legacyRefFilterStored(value);
		if (stored === null) continue;
		refFilters[normalizePath(key.slice(V1_REF_FILTER_PREFIX.length))] = stored;
	}
	const globalMap = entries[V1_REF_FILTER_KEY];
	if (globalMap !== null && typeof globalMap === 'object') {
		for (const [key, value] of Object.entries(globalMap as Record<string, unknown>)) {
			if (value === 'all') refFilters[normalizePath(key)] = 'all';
			else if (Array.isArray(value) && value.every((id) => typeof id === 'string')) refFilters[normalizePath(key)] = value;
		}
	}

	// 会话：selection 与 expanded 按 sessionId 配对。
	const selections = new Map<string, string>();
	const expandeds = new Map<string, string[]>();
	for (const [key, value] of Object.entries(entries)) {
		if (key.startsWith(V1_SELECTION_PREFIX)) {
			if (typeof value === 'string') selections.set(key.slice(V1_SELECTION_PREFIX.length), value);
		} else if (key.startsWith(V1_EXPANDED_PREFIX)) {
			expandeds.set(key.slice(V1_EXPANDED_PREFIX.length), normalizeExpanded(value));
		}
	}
	const sessions: Record<string, SessionFold> = {};
	const sessionIds = new Set<string>([...selections.keys(), ...expandeds.keys()]);
	for (const id of sessionIds) {
		const selected = selections.get(id) ?? null;
		const expanded = expandeds.get(id) ?? [];
		if (selected === null && expanded.length === 0) continue;
		sessions[id] = {
			selectedRepo: selected === null ? null : normalizePath(selected),
			expandedRepos: expanded.map(normalizePath),
			updatedAt: fallbackUpdatedAt,
		};
	}

	// 草稿：非空 ggg-commit-msg: 键。
	const commitMessages: Record<string, string> = {};
	for (const [key, value] of Object.entries(entries)) {
		if (!key.startsWith(V1_DRAFT_PREFIX)) continue;
		if (typeof value === 'string' && value !== '') commitMessages[normalizePath(key.slice(V1_DRAFT_PREFIX.length))] = value;
	}
	const drafts = Object.keys(commitMessages).length > 0 ? { commitMessages } : null;

	return {
		settings: settings !== null && typeof settings === 'object' ? settings as Record<string, unknown> : null,
		layout,
		refFilters,
		sessions,
		drafts,
	};
}

/**
 * 把顶层 repos 表折成按工作区键的仓库位置。
 *
 * @param repos - 顶层 repos 原始对象。
 * @returns 工作区键到仓库位置。
 */
function classifyRepos(repos: Record<string, unknown>): Record<string, CachedRepoLocation[]> {
	const out: Record<string, CachedRepoLocation[]> = {};
	for (const [key, value] of Object.entries(repos)) {
		const list = coerceRepoLocations(value);
		if (list.length > 0) out[normalizePath(key)] = list;
	}
	return out;
}

/**
 * 按当前结构组装文档。
 *
 * schemaVersion 单点给出，各迁移与合并路径只提供分区内容。
 *
 * @param parts - 各分区内容。
 * @returns 文档。
 */
function makeDocument(parts: DocumentParts): StateDocument {
	return { schemaVersion: SCHEMA_VERSION, ...parts };
}

/**
 * 把 v1 文档（平铺 entries + 顶层 repos）迁移到当前结构。
 *
 * 纯函数，单独可测。entries 分类复用 {@link classifyEntries}；仓库位置按工作区键归一；会话的
 * 选中与展开经 resolveCwd 折进工作区。同一工作区的多条会话按 updatedAt 取最新一条。
 *
 * @param raw - v1 原始对象。
 * @param fallbackUpdatedAt - 会话 updatedAt 缺省时刻（磁盘 mtime）。
 * @param resolveCwd - sessionId 到工作区根路径的解析器。
 * @returns 文档。
 */
export function migrateV1ToV3(raw: Record<string, unknown>, fallbackUpdatedAt: number, resolveCwd: SessionCwdResolver): StateDocument {
	const entries = (raw.entries !== null && typeof raw.entries === 'object' ? raw.entries : {}) as Record<string, unknown>;
	const repos = (raw.repos !== null && typeof raw.repos === 'object' ? raw.repos : {}) as Record<string, unknown>;
	const classified = classifyEntries(entries, fallbackUpdatedAt);

	const trees = new Map<string, WorkspaceTree>();
	foldSessionsIntoWorkspaces(trees, classified.sessions, resolveCwd);
	const workspaces = assembleWorkspaces(trees, classifyRepos(repos), {}, fallbackUpdatedAt);

	return makeDocument({
		settings: classified.settings,
		layout: classified.layout,
		refFilters: classified.refFilters,
		workspaces,
		drafts: classified.drafts,
	});
}

/**
 * 把 v2 文档（按会话分区的 sessions + 独立的 repoLocations）迁移到当前结构。
 *
 * 纯函数，单独可测。会话的选中与展开经 resolveCwd 折进工作区；同一工作区的多条会话按
 * updatedAt 取最新一条。仓库位置按工作区键并入同一表。
 *
 * @param raw - v2 原始对象。
 * @param resolveCwd - sessionId 到工作区根路径的解析器。
 * @returns 文档。
 */
export function migrateV2ToV3(raw: Record<string, unknown>, resolveCwd: SessionCwdResolver = readSessionCwd): StateDocument {
	const locations = raw.repoLocations !== null && typeof raw.repoLocations === 'object' ? raw.repoLocations as Record<string, unknown> : {};
	const reposByKey: Record<string, CachedRepoLocation[]> = {};
	for (const [key, value] of Object.entries(locations)) {
		const list = coerceRepoLocations(value);
		if (list.length > 0) reposByKey[normalizePath(key)] = list;
	}

	const sessionsRaw = raw.sessions !== null && typeof raw.sessions === 'object' ? raw.sessions as Record<string, unknown> : {};
	const sessions: Record<string, SessionFold> = {};
	for (const [id, value] of Object.entries(sessionsRaw)) {
		const ws = coerceWorkspace(value);
		if (ws === null) continue;
		sessions[id] = { selectedRepo: ws.selectedRepo, expandedRepos: ws.expandedRepos, updatedAt: ws.updatedAt };
	}
	const trees = new Map<string, WorkspaceTree>();
	foldSessionsIntoWorkspaces(trees, sessions, resolveCwd);
	const workspaces = assembleWorkspaces(trees, reposByKey, {}, Date.now());

	return makeDocument({
		settings: raw.settings !== null && typeof raw.settings === 'object' ? raw.settings as Record<string, unknown> : null,
		layout: coerceLayout(raw.layout),
		refFilters: coerceRefFilters(raw.refFilters),
		workspaces,
		drafts: coerceDrafts(raw.drafts),
	});
}

/**
 * 把一组平铺 entries 合并到当前文档。
 *
 * 浏览器旧键迁移用：客户端把 localStorage / sessionStorage 里的旧键原样收集后一次性发给宿主，
 * 由宿主分类并合并到对应分区。已有值保留，旧键分类出的值覆盖（浏览器是更近的数据源）。旧键里
 * 按会话的选中与展开经 resolveCwd 折进工作区；无法还原工作区的条目丢弃。
 *
 * @param entries - 平铺 entries。
 * @param resolveCwd - sessionId 到工作区根路径的解析器。
 * @returns 无。
 */
export function mergeLegacyEntries(entries: Record<string, unknown>, resolveCwd: SessionCwdResolver = readSessionCwd): void {
	const current = load();
	const classified = classifyEntries(entries, Date.now());
	const trees = new Map<string, WorkspaceTree>();
	foldSessionsIntoWorkspaces(trees, classified.sessions, resolveCwd);
	const workspaces = assembleWorkspaces(trees, {}, current.workspaces, Date.now());
	const drafts = mergeDrafts(current.drafts, classified.drafts);
	save({
		...current,
		settings: classified.settings ?? current.settings,
		layout: classified.layout ?? current.layout,
		refFilters: { ...current.refFilters, ...classified.refFilters },
		workspaces,
		drafts,
	});
}

/**
 * 合并两份草稿，后者覆盖前者。
 *
 * @param base - 基线草稿。
 * @param patch - 待合并草稿。
 * @returns 合并结果；都为 null 时为 null。
 */
function mergeDrafts(base: { readonly commitMessages: Record<string, string> } | null, patch: { readonly commitMessages: Record<string, string> } | null): { readonly commitMessages: Record<string, string> } | null {
	if (patch === null) return base;
	if (base === null) return patch;
	return { commitMessages: { ...base.commitMessages, ...patch.commitMessages } };
}

/**
 * 原子写回文档。
 *
 * @param next - 新文档。
 * @returns 无。
 */
function save(next: StateDocument): void {
	stateDoc = next;
	const path = pathOf();
	if (path === null) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = path + '.tmp';
		writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
		renameSync(tmp, path);
	} catch (error) {
		// 写盘失败时保留内存态，不打断面板；但设置与布局改动会因此丢失，需要留下记录。
		logWarn('state', `插件状态写盘失败，本次改动只留在内存里：${path}：${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * 读取设置。
 *
 * @returns 设置对象；无时为 null。
 */
export function readSettings(): Record<string, unknown> | null {
	return load().settings;
}

/**
 * 写入设置。
 *
 * @param settings - 设置对象；null 清除。
 * @returns 无。
 */
export function writeSettings(settings: Record<string, unknown> | null): void {
	save({ ...load(), settings });
}

/**
 * 读取布局。
 *
 * @returns 布局；无时为 null。
 */
export function readLayout(): PanelLayout | null {
	return load().layout;
}

/**
 * 写入布局。
 *
 * @param layout - 布局对象；null 清除。
 * @returns 无。
 */
export function writeLayout(layout: PanelLayout | null): void {
	save({ ...load(), layout });
}

/**
 * 读取引用筛选表。
 *
 * @returns 筛选表。
 */
export function readRefFilters(): RefFilterMap {
	return { ...load().refFilters };
}

/**
 * 写入引用筛选表。
 *
 * @param refFilters - 筛选表。
 * @returns 无。
 */
export function writeRefFilters(refFilters: RefFilterMap): void {
	save({ ...load(), refFilters: coerceRefFilters(refFilters) });
}

/**
 * 读取一个工作区的聚合状态。
 *
 * @param cwd - 工作区根路径。
 * @returns 工作区状态；无时为 null。
 */
export function readWorkspace(cwd: string): WorkspaceState | null {
	const key = normalizePath(cwd);
	if (key === '') return null;
	return Object.prototype.hasOwnProperty.call(load().workspaces, key) ? load().workspaces[key] : null;
}

/**
 * 写入一个工作区的选中与展开；合并到既有条目并刷 updatedAt。
 *
 * selectedRepo 或 expandedRepos 未给时保留原值；仓库位置一并保留。两者都空且已有仓库位置时
 * 保留该工作区（位置缓存仍有效），否则删除。
 *
 * @param cwd - 工作区根路径。
 * @param partial - 待合并的部分状态。
 * @returns 无。
 */
export function writeWorkspace(cwd: string, partial: Partial<Pick<WorkspaceState, 'selectedRepo' | 'expandedRepos'>> & { readonly repos?: readonly CachedRepoLocation[] }): void {
	const key = normalizePath(cwd);
	if (key === '') return;
	const current = load();
	const prev = Object.prototype.hasOwnProperty.call(current.workspaces, key) ? current.workspaces[key] : undefined;
	const selectedRepo = partial.selectedRepo !== undefined ? (partial.selectedRepo === null ? null : normalizePath(partial.selectedRepo)) : prev?.selectedRepo ?? null;
	const expandedRepos = partial.expandedRepos !== undefined ? partial.expandedRepos.map(normalizePath) : prev?.expandedRepos ?? [];
	const repos = partial.repos !== undefined ? partial.repos.map((repo) => ({ path: repo.path, name: repo.name })) : prev?.repos ?? [];
	const workspaces = { ...current.workspaces };
	if (selectedRepo === null && expandedRepos.length === 0 && repos.length === 0) {
		Reflect.deleteProperty(workspaces, key);
	} else {
		workspaces[key] = { selectedRepo, expandedRepos, repos, updatedAt: Date.now() };
	}
	save({ ...current, workspaces });
}

/**
 * 列出全部工作区键。
 *
 * @returns 归一化工作区键列表。
 */
export function listWorkspaces(): string[] {
	return Object.keys(load().workspaces);
}

/**
 * 清理过期与超量工作区。
 *
 * 删 updatedAt 早于 maxAgeMs 的工作区；剩余超过 cap 时按 updatedAt 升序删最旧至 cap。
 *
 * @param maxAgeMs - 工作区最大存活毫秒数。
 * @param cap - 保留条数上限。
 * @returns 无。
 */
export function pruneWorkspaces(maxAgeMs: number = WORKSPACE_MAX_AGE_MS, cap: number = WORKSPACE_CAP): void {
	const current = load();
	const cutoff = Date.now() - maxAgeMs;
	const entries = Object.entries(current.workspaces)
		.filter(([, ws]) => ws.updatedAt >= cutoff);
	if (entries.length > cap) {
		entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
		entries.splice(0, entries.length - cap);
	}
	const workspaces: Record<string, WorkspaceState> = {};
	for (const [key, ws] of entries) workspaces[key] = ws;
	if (Object.keys(workspaces).length === Object.keys(current.workspaces).length) return;
	save({ ...current, workspaces });
}

/**
 * 读取一个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @returns 缓存的仓库位置；无缓存时为空数组。
 */
export function readRepoLocations(cwd: string): CachedRepoLocation[] {
	const ws = readWorkspace(cwd);
	return ws === null ? [] : [...ws.repos];
}

/**
 * 写入一个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @param repos - 顶层仓库位置。
 * @returns 无。
 */
export function writeRepoLocations(cwd: string, repos: readonly CachedRepoLocation[]): void {
	writeWorkspace(cwd, { repos });
}

/**
 * 列出已缓存仓库位置的工作区根路径。
 *
 * @returns 归一化工作区键；无缓存时为空数组。
 */
export function listRepoLocationWorkspaces(): string[] {
	const out: string[] = [];
	for (const [key, ws] of Object.entries(load().workspaces)) {
		if (ws.repos.length > 0) out.push(key);
	}
	return out;
}

/**
 * 读取一个仓库的遗留提交信息草稿。
 *
 * @param repoPath - 仓库路径。
 * @returns 草稿文本；无时为 null。
 */
export function readDraft(repoPath: string): string | null {
	const drafts = load().drafts;
	if (drafts === null) return null;
	const value = drafts.commitMessages[normalizePath(repoPath)];
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 删除一个仓库的遗留提交信息草稿。
 *
 * @param repoPath - 仓库路径。
 * @returns 无。
 */
export function clearDraft(repoPath: string): void {
	const current = load();
	if (current.drafts === null) return;
	const commitMessages = { ...current.drafts.commitMessages };
	Reflect.deleteProperty(commitMessages, normalizePath(repoPath));
	const drafts = Object.keys(commitMessages).length > 0 ? { commitMessages } : null;
	save({ ...current, drafts });
}

/**
 * 读取完整状态快照供面板首屏一次取回。
 *
 * 含设置、布局、引用筛选与工作区；草稿按需经专用命令取回。
 *
 * @returns 快照。
 */
export function readSnapshot(): {
	readonly settings: Record<string, unknown> | null;
	readonly layout: PanelLayout | null;
	readonly refFilters: RefFilterMap;
	readonly workspaces: Record<string, WorkspaceState>;
} {
	const doc = load();
	return {
		settings: doc.settings,
		layout: doc.layout,
		refFilters: { ...doc.refFilters },
		workspaces: { ...doc.workspaces },
	};
}

/**
 * 清掉内存态，使下次读取重新落盘载入。
 *
 * @returns 无。
 */
export function resetStateCache(): void {
	stateDoc = null;
	statePath = null;
}
