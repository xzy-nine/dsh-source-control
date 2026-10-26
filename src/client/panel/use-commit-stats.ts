/**
 * 提交改动统计与完整提交信息：悬停某行时按需拉取并缓存；提交译文按提交缓存。
 *
 * 译文有两处来源：悬停浮窗的单条翻译（译整条提交信息）与图形区标题栏的批量翻译
 * （只译当前可见窗口内的标题）。两者写入同一份译文缓存，取消批量翻译时只回退该批次。
 */
import React from 'react';
import { loadCommitStatsAndMessage, translateText } from '../api/index.ts';
import { trimOldest } from '../shared/cache.ts';
import { useCacheCleanup } from './use-cache-cleanup.ts';
import { interfaceLanguage, translateCommitMessage } from './language.ts';
import type { CommitStats } from '../shared/types.ts';

/** 改动统计缓存的条目上限。 */
const STATS_CACHE_LIMIT = 1200;

/** 完整提交信息缓存的条目上限。 */
const MESSAGE_CACHE_LIMIT = 1200;

/** 译文缓存的条目上限。 */
const TRANSLATION_CACHE_LIMIT = 1200;

/** 译文原文缓存的条目上限；与译文缓存同步写入，各自按插入序淘汰。 */
const TRANSLATION_SOURCE_CACHE_LIMIT = 1200;

/** 提交改动统计 hook 的入参。 */
export interface UseCommitStatsOptions {
	/** 当前工作树路径；未选中时为 null。 */
	readonly workingTreePath: string | null;
	/** 翻译服务是否可用；不可用时不给翻译入口。 */
	readonly translateReady: boolean;
	/** 翻译失败时的提示出口。 */
	readonly onTranslateError: (message: string) => void;
	/** 缓存的清理周期（秒）。 */
	readonly cleanupSeconds: number;
}

/** 一条待翻译的提交：哈希与文本。 */
export interface TranslateItem {
	/** 提交哈希。 */
	readonly hash: string;
	/** 待翻译文本。 */
	readonly text: string;
}

/**
 * 从一份按哈希索引的缓存中丢弃给定条目。
 *
 * @param previous - 现有缓存。
 * @param hashes - 要丢弃的哈希。
 * @returns 新缓存。
 */
function dropHashes<T>(previous: Map<string, T>, hashes: Iterable<string>): Map<string, T> {
	const next = new Map(previous);
	for (const hash of hashes) next.delete(hash);
	return next;
}

/**
 * 从一份按哈希索引的缓存中丢弃单个条目。
 *
 * @param previous - 现有缓存。
 * @param hash - 要丢弃的哈希。
 * @returns 新缓存；原本就没有该条目时返回原引用。
 */
function dropHash<T>(previous: Map<string, T>, hash: string): Map<string, T> {
	if (!previous.has(hash)) return previous;
	return dropHashes(previous, [hash]);
}

/** 提交改动统计 hook 的返回值。 */
export interface UseCommitStatsResult {
	/** 提交哈希 -> 改动统计。 */
	readonly statsByHash: ReadonlyMap<string, CommitStats>;
	/** 提交哈希 -> 完整提交信息；未取到时缺省。 */
	readonly messageByHash: ReadonlyMap<string, string>;
	/** 提交哈希 -> 译文；未翻译过时缺省。 */
	readonly translatedByHash: ReadonlyMap<string, string>;
	/** 提交哈希 -> 译文对应的原文；与当前文本相同才可用该译文。 */
	readonly translatedFromByHash: ReadonlyMap<string, string>;
	/** 正在单条翻译的提交哈希；空闲时为 null。 */
	readonly translatingHash: string | null;
	/** 图形区标题栏的批量翻译是否已生效：入口据此显示反色图标与取消。 */
	readonly graphTranslated: boolean;
	/** 图形区批量翻译的进度；未进行时为 null。 */
	readonly graphTranslating: { done: number; total: number } | null;
	/** 悬停某行：延时预取统计与完整信息；离开时传 null。 */
	readonly hoverCommit: (hash: string | null) => void;
	/** 翻译一个提交的提交信息并缓存译文。 */
	readonly translateCommit: (hash: string, text: string) => void;
	/** 取消一个提交的翻译：丢弃该提交的译文。 */
	readonly cancelTranslateCommit: (hash: string) => void;
	/** 批量翻译一批提交的标题（图形区标题栏入口）。 */
	readonly translateCommits: (items: readonly TranslateItem[]) => void;
	/** 取消图形区的批量翻译：中止进行中的批次并回退该批译文。 */
	readonly cancelTranslateCommits: () => void;
}

/**
 * 拉取并缓存提交的改动统计、完整提交信息与译文。
 *
 * @param options - 见 {@link UseCommitStatsOptions}。
 * @returns 三份缓存、批量翻译状态、悬停回调与翻译回调。
 */
export function useCommitStats({ workingTreePath, translateReady, onTranslateError, cleanupSeconds }: UseCommitStatsOptions): UseCommitStatsResult {
	// 悬停卡片的改动统计与完整信息：按提交哈希缓存，悬停时按需拉取。
	const [statsByHash, setStatsByHash] = React.useState<Map<string, CommitStats>>(() => new Map());
	const [messageByHash, setMessageByHash] = React.useState<Map<string, string>>(() => new Map());
	// 译文与译文对应的原文：后者用于判断当前文本是否就是被翻译的那一份。
	const [translatedByHash, setTranslatedByHash] = React.useState<Map<string, string>>(() => new Map());
	const [translatedFromByHash, setTranslatedFromByHash] = React.useState<Map<string, string>>(() => new Map());
	const [translatingHash, setTranslatingHash] = React.useState<string | null>(null);
	// 图形区批量翻译：是否已生效与进行进度。
	const [graphTranslated, setGraphTranslated] = React.useState(false);
	const [graphTranslating, setGraphTranslating] = React.useState<{ done: number; total: number } | null>(null);
	// 改动统计与完整信息同属一次 `commitDetails`，共用一份在途登记：两者都已在缓存时不必再取。
	const statsInFlight = React.useRef<Map<string, AbortController>>(new Map());
	const hoverTimer = React.useRef<number | null>(null);
	// 批量翻译的哈希与取消信号：取消时据此只回退这一批。
	const graphBatchRef = React.useRef<string[]>([]);
	const graphAbortRef = React.useRef<AbortController | null>(null);
	// 单条翻译的取消信号。
	const singleAbortRef = React.useRef<AbortController | null>(null);
	// 当前单条翻译的提交哈希：与 translatingHash 同步，取消时据此判断是否为同一条。
	const translatingHashRef = React.useRef<string | null>(translatingHash);
	translatingHashRef.current = translatingHash;
	// 缓存写入时间：定时清理据此丢弃过期项。
	const statsStamps = React.useRef<ReadonlyMap<string, number>>(new Map());
	const messageStamps = React.useRef<ReadonlyMap<string, number>>(new Map());
	const translationStamps = React.useRef<ReadonlyMap<string, number>>(new Map());
	// 翻译回调经 ref 读取：调用方每次渲染都传新函数，直接进依赖会让回调重建。
	const onTranslateErrorRef = React.useRef(onTranslateError);
	onTranslateErrorRef.current = onTranslateError;

	/**
	 * 报告一次翻译失败；被取消的请求不报告（取消是调用方的意图）。
	 *
	 * @param controller - 该次翻译的取消信号。
	 * @param error - 抛出的错误。
	 * @returns 无。
	 */
	const reportTranslateFailure = (controller: AbortController, error: unknown): void => {
		if (controller.signal.aborted) return;
		onTranslateErrorRef.current(error instanceof Error ? error.message : String(error));
	};

	// 换仓库后旧的统计、信息与译文都不再适用。
	React.useEffect(() => {
		setStatsByHash(new Map());
		setMessageByHash(new Map());
		setTranslatedByHash(new Map());
		setTranslatedFromByHash(new Map());
		setTranslatingHash(null);
		setGraphTranslated(false);
		setGraphTranslating(null);
		graphAbortRef.current?.abort();
		graphAbortRef.current = null;
		graphBatchRef.current = [];
		singleAbortRef.current?.abort();
		singleAbortRef.current = null;
		statsStamps.current = new Map();
		messageStamps.current = new Map();
		translationStamps.current = new Map();
	}, [workingTreePath]);

	useCacheCleanup({
		stamps: statsStamps,
		drop: (hashes) => { setStatsByHash((previous) => dropHashes(previous, hashes)); },
		periodSeconds: cleanupSeconds,
	});
	useCacheCleanup({
		stamps: messageStamps,
		drop: (hashes) => { setMessageByHash((previous) => dropHashes(previous, hashes)); },
		periodSeconds: cleanupSeconds,
	});
	useCacheCleanup({
		stamps: translationStamps,
		drop: (hashes) => {
			setTranslatedByHash((previous) => dropHashes(previous, hashes));
			setTranslatedFromByHash((previous) => dropHashes(previous, hashes));
		},
		periodSeconds: cleanupSeconds,
	});

	// 卸载时取消未完成的请求与悬停计时。
	React.useEffect(() => () => {
		if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
		for (const controller of statsInFlight.current.values()) controller.abort();
		statsInFlight.current.clear();
	}, []);

	/**
	 * 拉取某个提交的改动统计与完整提交信息并缓存；两者都已在缓存或请求中时跳过。
	 *
	 * 统计与信息取自同一次 `commitDetails`，一趟往返同时填两份缓存。
	 *
	 * @param hash - 提交哈希，`*` 表示工作区未提交变更。
	 * @returns 无。
	 */
	const requestCommitDetails = React.useCallback((hash: string) => {
		if (workingTreePath === null || statsInFlight.current.has(hash)) return;
		// 两份缓存都在时不必再取：缓存清理可能只丢掉其中一份，此时仍需补齐。
		if (statsByHash.has(hash) && messageByHash.has(hash)) return;
		const controller = new AbortController();
		statsInFlight.current.set(hash, controller);
		loadCommitStatsAndMessage(workingTreePath, hash, controller.signal).then(({ files, message }) => {
			statsInFlight.current.delete(hash);
			if (controller.signal.aborted) return;
			let additions = 0;
			let deletions = 0;
			for (const file of files) {
				additions += typeof file.additions === 'number' ? file.additions : 0;
				deletions += typeof file.deletions === 'number' ? file.deletions : 0;
			}
			const now = Date.now();
			statsStamps.current = trimOldest(new Map(statsStamps.current).set(hash, now), STATS_CACHE_LIMIT);
			setStatsByHash((previous) => trimOldest(
				new Map(previous).set(hash, { files: files.length, additions, deletions }),
				STATS_CACHE_LIMIT,
			));
			// 取不到完整信息时卡片继续显示列表里的标题，不再提示。
			if (message !== null) {
				messageStamps.current = trimOldest(new Map(messageStamps.current).set(hash, now), MESSAGE_CACHE_LIMIT);
				setMessageByHash((previous) => trimOldest(new Map(previous).set(hash, message), MESSAGE_CACHE_LIMIT));
			}
		}).catch(() => {
			// 统计失败只影响卡片上的那一行，不再提示。
			statsInFlight.current.delete(hash);
		});
	}, [workingTreePath, statsByHash, messageByHash]);

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
			requestCommitDetails(hash);
		}, 220);
	}, [requestCommitDetails]);

	/**
	 * 写入一条译文；原文随译文一起记下，供调用方判断译文是否仍适用于当前文本。
	 *
	 * @param hash - 提交哈希。
	 * @param source - 被翻译的原文。
	 * @param translated - 译文。
	 * @returns 无。
	 */
	const storeTranslation = React.useCallback((hash: string, source: string, translated: string) => {
		translationStamps.current = trimOldest(
			new Map(translationStamps.current).set(hash, Date.now()),
			TRANSLATION_CACHE_LIMIT,
		);
		setTranslatedByHash((previous) => trimOldest(
			new Map(previous).set(hash, translated),
			TRANSLATION_CACHE_LIMIT,
		));
		setTranslatedFromByHash((previous) => trimOldest(
			new Map(previous).set(hash, source),
			TRANSLATION_SOURCE_CACHE_LIMIT,
		));
	}, []);

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
		// 单条翻译也可取消：取消时中止请求，避免迟到的译文写回。
		const controller = new AbortController();
		singleAbortRef.current = controller;
		setTranslatingHash(hash);
		void (async () => {
			try {
				const translated = await translateCommitMessage(
					source,
					(body) => translateText(workingTreePath, body, locale, controller.signal),
				);
				if (controller.signal.aborted) return;
				storeTranslation(hash, source, translated);
			} catch (error) {
				reportTranslateFailure(controller, error);
			} finally {
				if (singleAbortRef.current === controller) singleAbortRef.current = null;
				if (!controller.signal.aborted) setTranslatingHash(null);
			}
		})();
	}, [workingTreePath, translateReady, translatingHash, storeTranslation]);

	/**
	 * 批量翻译一批提交的标题，供图形区标题栏入口使用。
	 *
	 * 逐条串行：翻译服务按次计费与限流，并发下发既无收益也更容易失败。
	 *
	 * @param items - 待翻译的提交：哈希与标题文本。
	 * @returns 无。
	 */
	const translateCommits = React.useCallback((items: readonly TranslateItem[]) => {
		const targets = items.filter((item) => item.text.trim() !== '');
		if (workingTreePath === null || !translateReady || graphTranslating !== null || targets.length === 0) return;
		const controller = new AbortController();
		graphAbortRef.current = controller;
		graphBatchRef.current = targets.map((item) => item.hash);
		const locale = interfaceLanguage();
		setGraphTranslating({ done: 0, total: targets.length });
		void (async () => {
			let done = 0;
			try {
				for (const item of targets) {
					const translated = await translateCommitMessage(
						item.text,
						(body) => translateText(workingTreePath, body, locale, controller.signal),
					);
					// 取消后不再写回：这一批要整体回退，写一半会留下半译状态。
					if (controller.signal.aborted) return;
					storeTranslation(item.hash, item.text, translated);
					done++;
					setGraphTranslating({ done, total: targets.length });
				}
				setGraphTranslated(true);
			} catch (error) {
				reportTranslateFailure(controller, error);
			} finally {
				if (graphAbortRef.current === controller) graphAbortRef.current = null;
				if (!controller.signal.aborted) setGraphTranslating(null);
			}
		})();
	}, [workingTreePath, translateReady, graphTranslating, storeTranslation]);

	/**
	 * 取消图形区的批量翻译：中止进行中的批次，并回退该批已写入的译文。
	 *
	 * 只回退本批次涉及的哈希：悬停浮窗单条翻译得到的译文不属该批，保留。
	 *
	 * @returns 无。
	 */
	const cancelTranslateCommits = React.useCallback(() => {
		graphAbortRef.current?.abort();
		graphAbortRef.current = null;
		const batch = graphBatchRef.current;
		graphBatchRef.current = [];
		setGraphTranslating(null);
		setGraphTranslated(false);
		if (batch.length === 0) return;
		const dropped = new Set(batch);
		setTranslatedByHash((previous) => dropHashes(previous, dropped));
		setTranslatedFromByHash((previous) => dropHashes(previous, dropped));
	}, []);

	/**
	 * 取消一个提交的翻译：丢弃该提交的译文，回到原文。
	 *
	 * 该提交属于图形区批量翻译的那一批时一并从批次里移除，避免随后的取消再次处理它。
	 *
	 * @param hash - 提交哈希。
	 * @returns 无。
	 */
	const cancelTranslateCommit = React.useCallback((hash: string) => {
		// 仅当该条正是当前在译的一条时中止请求并清空状态；取消别的提交不影响它。
		if (translatingHashRef.current === hash && singleAbortRef.current !== null) {
			singleAbortRef.current.abort();
			singleAbortRef.current = null;
			setTranslatingHash(null);
		}
		graphBatchRef.current = graphBatchRef.current.filter((item) => item !== hash);
		setTranslatedByHash((previous) => dropHash(previous, hash));
		setTranslatedFromByHash((previous) => dropHash(previous, hash));
	}, []);

	return {
		statsByHash, messageByHash, translatedByHash, translatedFromByHash, translatingHash,
		graphTranslated, graphTranslating,
		hoverCommit, translateCommit, cancelTranslateCommit, translateCommits, cancelTranslateCommits,
	};
}
