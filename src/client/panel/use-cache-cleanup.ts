/**
 * 定时清理：按周期丢弃过了保留期的缓存，避免长会话把提交统计与完整提交信息一直留在内存里。
 *
 * 只清理过期的项；清理是幂等的，下一次悬停会重新按需拉取。
 */
import React from 'react';
import { CLEANUP_INTERVAL_MS, isCacheExpired } from './change-events.ts';

/** 缓存清理的入参。 */
export interface UseCacheCleanupOptions {
	/** 时间戳缓存：提交哈希 -> 写入时间。 */
	readonly stamps: React.MutableRefObject<ReadonlyMap<string, number>>;
	/** 丢弃一批哈希对应的缓存。 */
	readonly drop: (hashes: readonly string[]) => void;
}

/**
 * 按清理周期丢弃过期缓存。
 *
 * @param options - 见 {@link UseCacheCleanupOptions}。
 * @returns 无。
 */
export function useCacheCleanup({ stamps, drop }: UseCacheCleanupOptions): void {
	const dropRef = React.useRef(drop);
	dropRef.current = drop;

	React.useEffect(() => {
		const timer = window.setInterval(() => {
			const now = Date.now();
			const expired: string[] = [];
			for (const [hash, at] of stamps.current) {
				if (isCacheExpired(at, now)) expired.push(hash);
			}
			if (expired.length > 0) dropRef.current(expired);
		}, CLEANUP_INTERVAL_MS);
		return () => { window.clearInterval(timer); };
	}, [stamps]);
}
