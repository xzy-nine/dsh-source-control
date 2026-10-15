/**
 * 工作区仓库位置的持久化缓存。
 *
 * 仓库在工作区中的位置基本不变，而逐层扫描要访问成百上千个目录；把上次发现到的**顶层仓库路径**
 * 记进 localStorage，下次进入直接按这些路径取仓库信息。子模块与工作树依附于仓库、会随 checkout
 * 变化，因此不进缓存，仍由运行时的权威枚举给出。
 *
 * 命中缓存后仍会后台重扫一次（见 use-repos.ts），位置变化时以重扫结果纠正。
 */

/** 缓存键前缀；同一工作区共用一个键。 */
const CACHE_KEY = 'dsh-source-control-repos';

/** 缓存结构版本；结构变化时旧缓存自然失效。 */
const CACHE_VERSION = 1;

/** 缓存的仓库位置。 */
export interface CachedRepoLocation {
	/** 仓库绝对路径。 */
	readonly path: string;
	/** 末段目录名。 */
	readonly name: string;
}

/** 缓存的载荷。 */
interface CachePayload {
	readonly version: number;
	readonly repos: CachedRepoLocation[];
}

/**
 * 规范化工作区路径，作为缓存键的一部分。
 *
 * @param cwd - 工作区根路径。
 * @returns 规范化后的路径。
 */
function keyOf(cwd: string): string {
	return `${CACHE_KEY}:${String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`;
}

/**
 * 读取某个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @returns 缓存的仓库位置；无缓存或结构不符时为空数组。
 */
export function loadRepoLocations(cwd: string): CachedRepoLocation[] {
	try {
		const raw = localStorage.getItem(keyOf(cwd));
		if (raw === null || raw === '') return [];
		const parsed = JSON.parse(raw) as CachePayload;
		if (parsed === null || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION) return [];
		if (!Array.isArray(parsed.repos)) return [];
		return parsed.repos.filter((entry): entry is CachedRepoLocation =>
			entry !== null && typeof entry === 'object'
			&& typeof (entry as CachedRepoLocation).path === 'string'
			&& (entry as CachedRepoLocation).path !== ''
			&& typeof (entry as CachedRepoLocation).name === 'string');
	} catch {
		return [];
	}
}

/**
 * 写入某个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @param repos - 顶层仓库位置。
 * @returns 无。
 */
export function saveRepoLocations(cwd: string, repos: readonly CachedRepoLocation[]): void {
	try {
		const payload: CachePayload = { version: CACHE_VERSION, repos: repos.map((repo) => ({ path: repo.path, name: repo.name })) };
		localStorage.setItem(keyOf(cwd), JSON.stringify(payload));
	} catch {
		/* 持久化失败时下次仍走完整扫描 */
	}
}

/**
 * 清掉某个工作区的仓库位置缓存。
 *
 * @param cwd - 工作区根路径。
 * @returns 无。
 */
export function clearRepoLocations(cwd: string): void {
	try {
		localStorage.removeItem(keyOf(cwd));
	} catch {
		/* 忽略 */
	}
}
