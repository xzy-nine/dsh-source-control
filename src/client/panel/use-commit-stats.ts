/**
 * 提交改动统计与完整提交信息：悬停某行时按需拉取并缓存；提交浮窗的译文同样按提交缓存。
 */
import React from 'react';
import { loadCommitFiles, loadCommitMessage, translateText } from '../api/index.ts';
import { useCacheCleanup } from './use-cache-cleanup.ts';
import { interfaceLanguage, translateCommitMessage } from './language.ts';
import type { CommitStats } from '../shared/types.ts';

/** 提交改动统计 hook 的入参。 */
export interface UseCommitStatsOptions {
	/** 当前工作树路径；未选中时为 null。 */
	readonly workingTreePath: string | null;
	/** 翻译服务是否可用；不可用时浮窗不给翻译入口。 */
	readonly translateReady: boolean;
	/** 翻译失败时的提示出口。 */
	readonly onTranslateError: (message: string) => void;
}

/** 提交改动统计 hook 的返回值。 */
export interface UseCommitStatsResult {
	/** 提交哈希 -> 改动统计。 */
	readonly statsByHash: ReadonlyMap<string, CommitStats>;
	/** 提交哈希 -> 完整提交信息；未取到时缺省。 */
	readonly messageByHash: ReadonlyMap<string, string>;
	/** 提交哈希 -> 译文；未翻译过时缺省。 */
	readonly translatedByHash: ReadonlyMap<string, string>;
	/** 提交哈希 -> 已翻译的原文；与当前信息相同表示无需再译。 */
	readonly translatedFromByHash: ReadonlyMap<string, string>;
	/** 正在翻译的提交哈希；空闲时为 null。 */
	readonly translatingHash: string | null;
	/** 悬停某行：延时预取统计与完整信息；离开时传 null。 */
	readonly hoverCommit: (hash: string | null) => void;
	/** 翻译一个提交的提交信息并缓存译文。 */
	readonly translateCommit: (hash: string, text: string) => void;
}

/**
 * 拉取并缓存提交的改动统计、完整提交信息与译文。
 *
 * @param options - 见 {@link UseCommitStatsOptions}。
 * @returns 三份缓存、悬停回调与翻译回调。
 */
export function useCommitStats({ workingTreePath, translateReady, onTranslateError }: UseCommitStatsOptions): UseCommitStatsResult {
	// 悬停卡片的改动统计与完整信息：按提交哈希缓存，悬停时按需拉取。
	const [statsByHash, setStatsByHash] = React.useState<Map<string, CommitStats>>(() => new Map());
	const [messageByHash, setMessageByHash] = React.useState<Map<string, string>>(() => new Map());
	// 译文与译文对应的原文：后者用于判断当前信息是否已经翻译过。
	const [translatedByHash, setTranslatedByHash] = React.useState<Map<string, string>>(() => new Map());
	const [translatedFromByHash, setTranslatedFromByHash] = React.useState<Map<string, string>>(() => new Map());
	const [translatingHash, setTranslatingHash] = React.useState<string | null>(null);
	const statsInFlight = React.useRef<Map<string, AbortController>>(new Map());
	const messageInFlight = React.useRef<Map<string, AbortController>>(new Map());
	const hoverTimer = React.useRef<number | null>(null);
	// 缓存写入时间：定时清理据此丢弃过期项。
	const statsStamps = React.useRef<ReadonlyMap<string, number>>(new Map());
	const messageStamps = React.useRef<ReadonlyMap<string, number>>(new Map());
	const translationStamps = React.useRef<ReadonlyMap<string, number>>(new Map());
	// 翻译回调经 ref 读取：调用方每次渲染都传新函数，直接进依赖会让回调重建。
	const onTranslateErrorRef = React.useRef(onTranslateError);
	onTranslateErrorRef.current = onTranslateError;

	// 换仓库后旧的统计、信息与译文都不再适用。
	React.useEffect(() => {
		setStatsByHash(new Map());
		setMessageByHash(new Map());
		setTranslatedByHash(new Map());
		setTranslatedFromByHash(new Map());
		setTranslatingHash(null);
		statsStamps.current = new Map();
		messageStamps.current = new Map();
		translationStamps.current = new Map();
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
	useCacheCleanup({
		stamps: translationStamps,
		drop: (hashes) => {
			setTranslatedByHash((previous) => {
				const next = new Map(previous);
				for (const hash of hashes) next.delete(hash);
				return next;
			});
			setTranslatedFromByHash((previous) => {
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

	/**
	 * 翻译一个提交的提交信息并缓存译文。
	 *
	 * 与提交信息框同一套逐行翻译：空行保留，git 惯例前缀原样保留，只译正文。
	 *
	 * @param hash - 提交哈希。
	 * @param text - 该提交的完整提交信息。
	 * @returns 无。
	 */
	const translateCommit = React.useCallback((hash: string, text: string) => {
		if (workingTreePath === null || !translateReady || translatingHash !== null || text.trim() === '') return;
		const source = text;
		const locale = interfaceLanguage();
		setTranslatingHash(hash);
		void (async () => {
			try {
				const translated = await translateCommitMessage(source, (body) => translateText(workingTreePath, body, locale));
				translationStamps.current = new Map(translationStamps.current).set(hash, Date.now());
				setTranslatedByHash((previous) => new Map(previous).set(hash, translated));
				setTranslatedFromByHash((previous) => new Map(previous).set(hash, source));
			} catch (error) {
				onTranslateErrorRef.current(error instanceof Error ? error.message : String(error));
			} finally {
				setTranslatingHash(null);
			}
		})();
	}, [workingTreePath, translateReady, translatingHash]);

	return {
		statsByHash, messageByHash, translatedByHash, translatedFromByHash, translatingHash,
		hoverCommit, translateCommit,
	};
}
