/**
 * 工作区仓库位置的持久化缓存。
 *
 * 仓库在工作区中的位置基本不变，而逐层扫描要访问成百上千个目录；把上次发现到的**顶层仓库路径**
 * 记到宿主（`$DSH_HOME/dsh-source-control/`），下次进入直接按这些路径取仓库信息。子模块与工作树
 * 依附于仓库、会随 checkout 变化，因此不进缓存，仍由运行时的权威枚举给出。
 *
 * 命中缓存后仍会后台重扫一次（见 use-repos.ts），位置变化时以重扫结果纠正。
 */
import { readRepoLocations, writeRepoLocations } from '../api/index.ts';

/** 缓存的仓库位置。 */
export interface CachedRepoLocation {
	/** 仓库绝对路径。 */
	readonly path: string;
	/** 末段目录名。 */
	readonly name: string;
}

/** 内存缓存：仓库位置随发现流程同步读写，避免每次进入都往返宿主。 */
const cache = new Map<string, CachedRepoLocation[]>();

/**
 * 读取某个工作区的仓库位置缓存。
 *
 * 只读内存缓存：调用方在挂载时先经 {@link primeRepoLocations} 预取。
 *
 * @param cwd - 工作区根路径。
 * @returns 缓存的仓库位置；无缓存时为空数组。
 */
export function loadRepoLocations(cwd: string): CachedRepoLocation[] {
	return cache.get(cwd) ?? [];
}

/**
 * 预取某个工作区的仓库位置缓存到内存。
 *
 * @param cwd - 工作区根路径。
 * @returns 无。
 */
export async function primeRepoLocations(cwd: string): Promise<void> {
	try {
		cache.set(cwd, await readRepoLocations(cwd));
	} catch {
		/* 预取失败时按无缓存处理，走完整扫描 */
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
	const value = repos.map((repo) => ({ path: repo.path, name: repo.name }));
	cache.set(cwd, value);
	void writeRepoLocations(cwd, value).catch(() => { /* 落盘失败时保留内存态 */ });
}

/**
 * 把宿主本次返回的仓库位置收进内存缓存。
 *
 * 首屏直接采用宿主按持久化位置取回的树，位置已由宿主持有，因此只更新内存镜像、不再落盘一次。
 *
 * @param cwd - 工作区根路径。
 * @param repos - 顶层仓库位置。
 * @returns 无。
 */
export function rememberRepoLocations(cwd: string, repos: readonly CachedRepoLocation[]): void {
	cache.set(cwd, repos.map((repo) => ({ path: repo.path, name: repo.name })));
}
