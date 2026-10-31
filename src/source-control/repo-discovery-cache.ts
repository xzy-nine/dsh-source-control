/**
 * 仓库发现结果缓存：60 秒 TTL、容量 16、按工作区根与写命令作废。
 */
import { nodeId } from './repo-node.js';
import type { DiscoveryOptions, DiscoveryResult } from './repo-node.js';
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_DIRECTORIES } from './repo-node.js';
import { onRepositoryWrite } from './working-tree.js';

/** 发现结果缓存的存活毫秒数。 */
const DISCOVERY_CACHE_TTL_MS = 60_000;

/** 发现结果缓存的容量上限；超出按插入序淘汰最旧。 */
const DISCOVERY_CACHE_LIMIT = 16;

/** 一条发现结果缓存：键、结果与写入时刻。 */
interface DiscoveryCacheEntry {
	readonly result: DiscoveryResult;
	readonly at: number;
}

/** 发现结果缓存。 */
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/**
 * 生成发现结果缓存的键。
 *
 * @param root - 工作区根目录。
 * @param options - 发现选项。
 * @returns 缓存键。
 */
export function discoveryCacheKey(root: string, options: DiscoveryOptions): string {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
	const known = options.knownRepos === undefined ? '' : options.knownRepos.join('\0');
	const shallow = options.shallow === true ? '1' : '0';
	return `${root}\0${maxDepth}\0${maxDirectories}\0${shallow}\0${known}`;
}

/**
 * 取未过期的缓存发现结果。
 *
 * @param key - 缓存键。
 * @returns 缓存结果；未命中或已过期时为 null。
 */
export function readDiscoveryCache(key: string): DiscoveryResult | null {
	const entry = discoveryCache.get(key);
	if (entry === undefined) return null;
	if (Date.now() - entry.at >= DISCOVERY_CACHE_TTL_MS) {
		discoveryCache.delete(key);
		return null;
	}
	return entry.result;
}

/**
 * 写入发现结果缓存，并按插入序淘汰超出容量的最旧项。
 *
 * @param key - 缓存键。
 * @param result - 发现结果。
 * @returns 无。
 */
export function writeDiscoveryCache(key: string, result: DiscoveryResult): void {
	discoveryCache.delete(key);
	discoveryCache.set(key, { result, at: Date.now() });
	while (discoveryCache.size > DISCOVERY_CACHE_LIMIT) {
		const oldest = discoveryCache.keys().next();
		if (oldest.done === true) break;
		discoveryCache.delete(oldest.value);
	}
}

/**
 * 作废全部发现结果缓存。
 *
 * @returns 无。
 */
export function clearDiscoveryCache(): void {
	discoveryCache.clear();
}

/**
 * 作废受某个仓库影响的发现结果缓存。
 *
 * 缓存键以工作区根开头，因此「工作区根是目标路径的祖先」或「目标路径是工作区根的祖先」时
 * 该项才受影响：前者是该仓库所在的工作区，后者表示工作区根本身位于该仓库内。别的目录下的
 * 工作区与本次改动无关，全量清空会让它们下次各自重新扫描。
 *
 * @param repo - 发生写操作的仓库或工作树路径。
 * @returns 无。
 */
export function invalidateDiscoveryCacheFor(repo: string): void {
	const target = nodeId(repo);
	if (target === '') return;
	for (const key of [...discoveryCache.keys()]) {
		const separator = key.indexOf('\0');
		const root = separator === -1 ? key : key.slice(0, separator);
		/*
		 * 键里的工作区根是调用方传入的原样写法，与目标路径的写法未必一致（尾分隔符、盘符大小写、
		 * 分隔符方向），比较前按同一规则归一。
		 */
		const normalized = nodeId(root);
		if (normalized === target || normalized.startsWith(`${target}/`) || target.startsWith(`${normalized}/`)) {
			discoveryCache.delete(key);
		}
	}
}

/* 仓库写命令会改变目录与仓库位置，命令结束后作废受影响的发现缓存。 */
onRepositoryWrite((repo) => { invalidateDiscoveryCacheFor(repo); });
