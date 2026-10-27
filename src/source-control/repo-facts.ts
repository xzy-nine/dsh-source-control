/**
 * 仓库事实层：git 目录布局与打包引用的进程级缓存。
 *
 * 一次取数会多次解析同一个仓库的 git 目录与公共目录，打包引用也可能被整读多遍，读到的都是
 * 同一份事实。两项的变化都很慢（仓库被换成工作树或子模块、`pack-refs` 重写），因此按进程
 * 缓存：布局按有效期与写操作失效，打包引用按 `stat` 的修改时刻与大小守卫。
 *
 * `HEAD` 不缓存：它是各缓存的失效判据，读的是当前值。布局缓存存的是待决结果，同一仓库的
 * 并发请求因此共享一次解析。
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getCached, putCached } from './host-cache.js';
import type { CacheEntry } from './host-cache.js';
import { onRepositoryWrite } from './working-tree.js';
import { gitCommonDirOf, parseHeadRef, readLooseRef, resolveGitDir } from './worktree-branches.js';
import type { HeadRef } from './worktree-branches.js';

/** 一个仓库的 git 目录布局。 */
export interface RepoLayout {
	/** 该工作树自己的 git 目录。 */
	readonly gitDir: string;
	/** 各工作树共用的公共目录。 */
	readonly commonDir: string;
}

/** 布局缓存的默认有效期（毫秒）。 */
const LAYOUT_TTL_MS = 10_000;

/** 布局缓存的容量上限。 */
const LAYOUT_LIMIT = 64;

/** 打包引用缓存的容量上限。 */
const PACKED_REFS_LIMIT = 8;

/** 布局缓存的有效期；0 表示关闭缓存。 */
let layoutTtlMs = LAYOUT_TTL_MS;

/** 布局缓存：键为规范化仓库路径，值为待决的解析结果。 */
const layouts = new Map<string, CacheEntry<Promise<RepoLayout | null>>>();

/** 打包引用表的快照与守卫。 */
interface PackedRefsSnapshot {
	/** 引用全名到哈希。 */
	readonly refs: ReadonlyMap<string, string>;
	/** 读取时 `packed-refs` 的修改时刻。 */
	readonly mtimeMs: number;
	/** 读取时 `packed-refs` 的大小。 */
	readonly size: number;
}

/** 打包引用缓存：键为规范化公共目录。 */
const packedRefs = new Map<string, CacheEntry<PackedRefsSnapshot>>();

/**
 * 归一化仓库路径，作为缓存键。
 *
 * 大小写与结尾分隔符在 Windows 上等价，不归一会被当成两个仓库，各占一份缓存；分隔符统一成
 * `/`，失效时才能按前缀比较祖先与后代。
 *
 * @param repo - 仓库路径。
 * @returns 规范化的绝对路径。
 */
function repoKeyOf(repo: string): string {
	return resolve(repo).split('\\').join('/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 读一个目录的 `stat` 守卫；不存在或不是常规文件时为 null。
 *
 * @param path - 文件路径。
 * @returns 修改时刻与大小。
 */
async function stampOf(path: string): Promise<{ mtimeMs: number; size: number } | null> {
	try {
		const info = await stat(path);
		return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null;
	} catch {
		return null;
	}
}

/**
 * 解析 `packed-refs` 的正文。
 *
 * 每行形如 `<哈希> <引用名>`；首字符为 `#` 的行是注释，`^` 开头的行是附注标签的剥离目标，
 * 一并跳过。
 *
 * @param source - 文件正文。
 * @returns 引用全名到哈希。
 */
export function parsePackedRefs(source: string): Map<string, string> {
	const refs = new Map<string, string>();
	for (const line of source.split('\n')) {
		if (line === '' || line.startsWith('#') || line.startsWith('^')) continue;
		const space = line.indexOf(' ');
		if (space === -1) continue;
		refs.set(line.slice(space + 1).trim(), line.slice(0, space));
	}
	return refs;
}

/**
 * 解析一个仓库的 git 目录与公共目录。
 *
 * @param repo - 仓库路径。
 * @returns 布局；路径不是仓库时为 null。
 */
async function readLayout(repo: string): Promise<RepoLayout | null> {
	const gitDir = await resolveGitDir(repo);
	if (gitDir === null) return null;
	return { gitDir, commonDir: await gitCommonDirOf(gitDir) };
}

/**
 * 取一个仓库的 git 目录布局。
 *
 * 同一仓库的并发读取共享一次解析：布局涉及逐级 `stat`，一次取数里有六处要它。
 *
 * @param repo - 仓库路径。
 * @returns 布局；路径不是仓库时为 null。
 */
export function repoLayout(repo: string): Promise<RepoLayout | null> {
	if (layoutTtlMs <= 0) return readLayout(repo);
	const key = repoKeyOf(repo);
	const cached = getCached(layouts, key);
	if (cached !== undefined) return cached;
	const pending = readLayout(repo);
	putCached(layouts, LAYOUT_LIMIT, key, pending, layoutTtlMs);
	return pending;
}

/**
 * 取 `packed-refs` 的解析结果。
 *
 * 守卫是文件的修改时刻与大小：`pack-refs`、`gc` 与 `fetch` 都会改这两项，守卫不通过即重读。
 *
 * @param commonDir - git 公共目录。
 * @returns 打包引用表；没有该文件时为 null。
 */
async function packedRefsOf(commonDir: string): Promise<PackedRefsSnapshot | null> {
	const path = join(commonDir, 'packed-refs');
	const key = repoKeyOf(commonDir);
	const cached = layoutTtlMs > 0 ? getCached(packedRefs, key) : undefined;
	const stamp = await stampOf(path);
	if (stamp === null) return null;
	if (cached !== undefined && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) return cached;
	let source: string;
	try {
		source = await readFile(path, 'utf8');
	} catch {
		return null;
	}
	const snapshot: PackedRefsSnapshot = { refs: parsePackedRefs(source), ...stamp };
	if (layoutTtlMs > 0) putCached(packedRefs, PACKED_REFS_LIMIT, key, snapshot, Number.POSITIVE_INFINITY);
	return snapshot;
}

/**
 * 从打包引用里取一个引用的哈希。
 *
 * @param commonDir - git 公共目录。
 * @param refName - 完整引用名，如 `refs/heads/main`。
 * @returns 提交哈希；引用不在打包引用里时为 null。
 */
export async function readPackedRef(commonDir: string, refName: string): Promise<string | null> {
	const snapshot = await packedRefsOf(commonDir);
	return snapshot?.refs.get(refName) ?? null;
}

/**
 * 读一个 git 目录下的 `HEAD` 文件。
 *
 * @param gitDir - git 目录。
 * @returns 解析结果；文件不存在或格式不可识别时为 null。
 */
async function readHeadFile(gitDir: string): Promise<HeadRef | null> {
	try {
		return parseHeadRef(await readFile(resolve(gitDir, 'HEAD'), 'utf8'));
	} catch {
		return null;
	}
}

/**
 * 读一个引用的提交哈希：先找松散引用，再查打包引用。
 *
 * @param commonDir - git 公共目录。
 * @param refName - 完整引用名。
 * @returns 提交哈希；引用不存在时为 null。
 */
async function readRefHash(commonDir: string, refName: string): Promise<string | null> {
	return (await readLooseRef(commonDir, refName)) ?? await readPackedRef(commonDir, refName);
}

/**
 * 读仓库当前的 `HEAD`：指向的提交哈希与分支名。
 *
 * `HEAD` 文件本身每次都重读，它是缓存键的失效判据。
 *
 * @param repo - 仓库路径。
 * @returns HEAD 的解析结果；路径不是仓库或读不到时为 null。
 */
export async function repoHead(repo: string): Promise<HeadRef | null> {
	const layout = await repoLayout(repo);
	if (layout === null) return null;
	const head = await readHeadFile(layout.gitDir);
	if (head === null || head.hash !== null || head.branch === null) return head;
	return { branch: head.branch, hash: await readRefHash(layout.commonDir, `refs/heads/${head.branch}`) };
}

/**
 * 读仓库当前 `HEAD` 指向的提交哈希。
 *
 * @param repo - 仓库路径。
 * @returns 提交哈希；尚无提交或路径不是仓库时为 null。
 */
export async function repoHeadHash(repo: string): Promise<string | null> {
	return (await repoHead(repo))?.hash ?? null;
}

/**
 * 作废一个仓库及其祖先与后代的布局缓存。
 *
 * 祖先与后代一并作废：子模块的写会改变父仓库可见的事实，链接工作树与主工作树路径不同但共用
 * 同一份布局来源。
 *
 * @param repo - 仓库路径。
 * @returns 无。
 */
export function invalidateRepoFacts(repo: string): void {
	const key = repoKeyOf(repo);
	for (const cached of layouts.keys()) {
		if (cached === key || cached.startsWith(`${key}/`) || key.startsWith(`${cached}/`)) layouts.delete(cached);
	}
}

/**
 * 清空全部仓库事实缓存。
 *
 * @returns 无。
 */
export function clearRepoFacts(): void {
	layouts.clear();
	packedRefs.clear();
}

/**
 * 设置布局缓存的有效期；0 表示关闭缓存。
 *
 * @param ms - 有效期毫秒数。
 * @returns 无。
 */
export function setRepoFactsTtlForTest(ms: number): void {
	layoutTtlMs = ms;
	clearRepoFacts();
}

/* 写命令结束后作废目标仓库的布局：仓库可能被换成工作树、被移除或重新初始化。 */
onRepositoryWrite(invalidateRepoFacts);
