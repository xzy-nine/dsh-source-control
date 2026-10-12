/**
 * 提交改动统计：悬停某行时按需拉取并缓存。
 */
import React from 'react';
import { loadCommitFiles } from '../api.ts';
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
	/** 悬停某行：延时预取统计；离开时传 null。 */
	readonly hoverCommit: (hash: string | null) => void;
}

/**
 * 拉取并缓存提交的改动统计。
 *
 * @param options - 见 {@link UseCommitStatsOptions}。
 * @returns 统计缓存与悬停回调。
 */
export function useCommitStats({ workingTreePath }: UseCommitStatsOptions): UseCommitStatsResult {
	// 悬停卡片的改动统计：按提交哈希缓存，悬停时按需拉取。
	const [statsByHash, setStatsByHash] = React.useState<Map<string, CommitStats>>(() => new Map());
	const statsInFlight = React.useRef<Map<string, AbortController>>(new Map());
	const hoverTimer = React.useRef<number | null>(null);

	// 换仓库后旧的统计不再适用。
	React.useEffect(() => { setStatsByHash(new Map()); }, [workingTreePath]);

	// 卸载时取消未完成的统计请求与悬停计时。
	React.useEffect(() => () => {
		if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
		for (const controller of statsInFlight.current.values()) controller.abort();
		statsInFlight.current.clear();
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
			setStatsByHash((previous) => new Map(previous).set(hash, { files: files.length, additions, deletions }));
		}).catch(() => {
			// 统计失败只影响卡片上的那一行，不再提示。
			statsInFlight.current.delete(hash);
		});
	}, [workingTreePath, statsByHash]);

	/**
	 * 悬停提交行：延时预取统计，避免指针扫过时连发请求。
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
		}, 220);
	}, [requestCommitStats]);

	return { statsByHash, hoverCommit };
}
