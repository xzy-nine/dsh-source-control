/**
 * 提交改动统计与完整提交信息：悬停某行时按需拉取并缓存。
 */
import React from 'react';
import { loadCommitFiles, loadCommitMessage } from '../api.ts';
import { useCacheCleanup } from './use-cache-cleanup.ts';
import type { CommitStats } from '../types.ts';

/** 提交改动统计 hook 的入参。 */
export interface UseCommitStatsOptions {
	/** 当前工作树路径；未选中时为 null。 */
	readonly workingTreePath: string | null;
}

/** 提交改动统计 hook 的返回值。 */
export interface UseCommitStatsResult {
	/** 提交哈希 -> 改动统计。 */
	readonly statsByHash: ReadonlyMap<string, CommitStats>;
	/** 提交哈希 -> 完整提交信息；未取到时缺省。 */
	readonly messageByHash: ReadonlyMap<string, string>;
	/** 悬停某行：延时预取统计与完整信息；离开时传 null。 */
	readonly hoverCommit: (hash: string | null) => void;
}

/**
 * 拉取并缓存提交的改动统计与完整提交信息。
 *
 * @param options - 见 {@link UseCommitStatsOptions}。
 * @returns 统计缓存、完整信息缓存与悬停回调。
 */
export function useCommitStats({ workingTreePath }: UseCommitStatsOptions): UseCommitStatsResult {
	// 悬停卡片的改动统计与完整信息：按提交哈希缓存，悬停时按需拉取。
	const [statsByHash, setStatsByHash] = React.useState<Map<string, CommitStats>>(() => new Map());
	const [messageByHash, setMessageByHash] = React.useState<Map<string, string>>(() => new Map());
	const statsInFlight = React.useRef<Map<string, AbortController>>(new Map());
	const messageInFlight = React.useRef<Map<string, AbortController>>(new Map());
	const hoverTimer = React.useRef<number | null>(null);
	// 缓存写入时间：定时清理据此丢弃过期项。
	const statsStamps = React.useRef<ReadonlyMap<string, number>>(new Map());
	const messageStamps = React.useRef<ReadonlyMap<string, number>>(new Map());

	// 换仓库后旧的统计与信息不再适用。
	React.useEffect(() => {
		setStatsByHash(new Map());
		setMessageByHash(new Map());
		statsStamps.current = new Map();
		messageStamps.current = new Map();
	}, [workingTreePath]);

	useCacheCleanup({
		stamps: statsStamps,
		drop: (hashes) => {
			setStatsByHash((previous) => {
				const next = new Map(previous);
				for (const hash of hashes) next.delete(hash);
				return next;
			});
		},
	});
	useCacheCleanup({
		stamps: messageStamps,
		drop: (hashes) => {
			setMessageByHash((previous) => {
				const next = new Map(previous);
				for (const hash of hashes) next.delete(hash);
				return next;
			});
		},
	});

	// 卸载时取消未完成的请求与悬停计时。
	React.useEffect(() => () => {
		if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
		for (const controller of statsInFlight.current.values()) controller.abort();
		for (const controller of messageInFlight.current.values()) controller.abort();
		statsInFlight.current.clear();
		messageInFlight.current.clear();
	}, []);

	/**
	 * 拉取某个提交的改动统计并缓存；已在缓存或请求中的跳过。
	 *
	 * @param hash - 提交哈希，`*` 表示工作区未提交变更。
	 * @returns 无。
	 */
	const requestCommitStats = React.useCallback((hash: string) => {
		if (workingTreePath === null || statsByHash.has(hash) || statsInFlight.current.has(hash)) return;
		const controller = new AbortController();
		statsInFlight.current.set(hash, controller);
		loadCommitFiles(workingTreePath, hash, controller.signal).then((files) => {
			statsInFlight.current.delete(hash);
			if (controller.signal.aborted) return;
			let additions = 0;
			let deletions = 0;
			for (const file of files) {
				additions += typeof file.additions === 'number' ? file.additions : 0;
				deletions += typeof file.deletions === 'number' ? file.deletions : 0;
			}
			statsStamps.current = new Map(statsStamps.current).set(hash, Date.now());
			setStatsByHash((previous) => new Map(previous).set(hash, { files: files.length, additions, deletions }));
		}).catch(() => {
			// 统计失败只影响卡片上的那一行，不再提示。
			statsInFlight.current.delete(hash);
		});
	}, [workingTreePath, statsByHash]);

	/**
	 * 拉取某个提交的完整提交信息并缓存；已在缓存或请求中的跳过。
	 *
	 * @param hash - 提交哈希，`*` 表示工作区未提交变更。
	 * @returns 无。
	 */
	const requestCommitMessage = React.useCallback((hash: string) => {
		if (workingTreePath === null || messageByHash.has(hash) || messageInFlight.current.has(hash)) return;
		const controller = new AbortController();
		messageInFlight.current.set(hash, controller);
		loadCommitMessage(workingTreePath, hash, controller.signal).then((message) => {
			messageInFlight.current.delete(hash);
			if (controller.signal.aborted || message === null) return;
			messageStamps.current = new Map(messageStamps.current).set(hash, Date.now());
			setMessageByHash((previous) => new Map(previous).set(hash, message));
		}).catch(() => {
			// 取不到完整信息时卡片继续显示列表里的标题，不再提示。
			messageInFlight.current.delete(hash);
		});
	}, [workingTreePath, messageByHash]);

	/**
	 * 悬停提交行：延时预取统计与完整信息，避免指针扫过时连发请求。
	 *
	 * @param hash - 进入的提交哈希；离开时为 null。
	 * @returns 无。
	 */
	const hoverCommit = React.useCallback((hash: string | null) => {
		if (hoverTimer.current !== null) {
			clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
		if (hash === null) return;
		hoverTimer.current = window.setTimeout(() => {
			hoverTimer.current = null;
			requestCommitStats(hash);
			requestCommitMessage(hash);
		}, 220);
	}, [requestCommitStats, requestCommitMessage]);

	return { statsByHash, messageByHash, hoverCommit };
}
