/**
 * 定时清理：按周期丢弃过了保留期的缓存，避免长会话把提交统计与完整提交信息一直留在内存里。
 *
 * 只清理过期的项；清理是幂等的，下一次悬停会重新按需拉取。清理周期由设置给出，
 * 越界值已在设置层收拢，这里只做毫秒换算。
 */
import React from 'react';
import { clampSeconds, isCacheExpired, CLEANUP_PERIOD_SECONDS_DEFAULT, CLEANUP_PERIOD_SECONDS_MAX, CLEANUP_PERIOD_SECONDS_MIN } from './change-events.ts';

/** 缓存清理的入参。 */
export interface UseCacheCleanupOptions {
	/** 时间戳缓存：提交哈希 -> 写入时间。 */
	readonly stamps: React.MutableRefObject<ReadonlyMap<string, number>>;
	/** 丢弃一批哈希对应的缓存。 */
	readonly drop: (hashes: readonly string[]) => void;
	/** 清理周期（秒）。 */
	readonly periodSeconds: number;
}

/**
 * 按清理周期丢弃过期缓存。
 *
 * @param options - 见 {@link UseCacheCleanupOptions}。
 * @returns 无。
 */
export function useCacheCleanup({ stamps, drop, periodSeconds }: UseCacheCleanupOptions): void {
	const dropRef = React.useRef(drop);
	dropRef.current = drop;
	const periodMs = clampSeconds(periodSeconds, CLEANUP_PERIOD_SECONDS_MIN, CLEANUP_PERIOD_SECONDS_MAX, CLEANUP_PERIOD_SECONDS_DEFAULT) * 1000;

	React.useEffect(() => {
		const timer = window.setInterval(() => {
			const now = Date.now();
			const expired: string[] = [];
			for (const [hash, at] of stamps.current) {
				if (isCacheExpired(at, now)) expired.push(hash);
			}
			if (expired.length > 0) dropRef.current(expired);
		}, periodMs);
		return () => { window.clearInterval(timer); };
	}, [stamps, periodMs]);
}
