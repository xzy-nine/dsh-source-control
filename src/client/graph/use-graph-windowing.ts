/**
 * 提交图的滚动窗口化：可视区测量、起始行换算、触底续取与滚动期间的悬停推迟。
 *
 * 行偏移按 ROW_HEIGHT 累加，展开详情的那一行额外加上它的实测高度；未渲染部分由调用方用
 * 等高空占位撑起滚动条。
 */
import React from 'react';
import { ROW_HEIGHT, type LaneRow } from './lanes.ts';
import { topIndexOf, visibleRange } from './window-range.ts';
import { shouldLoadMore } from './auto-load.ts';

/** 可视区之外额外渲染的行数：滚动时留出缓冲，避免边缘出现空白。 */
const OVERSCAN_ROWS = 12;

/**
 * 滚动停止判定的静默时长。
 *
 * 悬浮卡片的改动统计与完整提交信息按哈希单独取回，滚动期间行在变、取了也多半用不上；
 * 因此滚动停止这段时间之后才真正发起请求。
 */
const SCROLL_SETTLE_MS = 160;

/** 取下一页后等待新数据的上限；超时未到则解除占用，允许重试。 */
const LOAD_MORE_SETTLE_MS = 10000;

/** 滚动窗口化的入参。 */
export interface UseGraphWindowingOptions {
	/** 泳道布局给出的行。 */
	readonly rows: readonly LaneRow[];
	/** 选中行下标；无选中为 -1。 */
	readonly selectedIndex: number;
	/** 提交列表，用于识别「确实取回了新数据」。 */
	readonly commits: readonly unknown[];
	/** 是否还有更早的提交可取。 */
	readonly moreCommitsAvailable: boolean;
	/** 取下一页。 */
	readonly onLoadMore: () => void;
	/** 悬停取数回调：进入传哈希，离开传 null。 */
	readonly onHoverCommit?: ((hash: string | null) => void) | undefined;
}

/** 滚动窗口化的返回值。 */
export interface UseGraphWindowingResult {
	/** 滚动容器。 */
	readonly graphRef: React.MutableRefObject<HTMLDivElement | null>;
	/** 行偏移表；`offsets[i]` 是第 i 行的顶部位置。 */
	readonly offsets: Float64Array;
	/** 应挂载的行区间，左闭右开。 */
	readonly range: { readonly first: number; readonly last: number };
	/** 是否正在等待下一页。 */
	readonly loadingMore: boolean;
	/** 滚动事件处理。 */
	readonly handleScroll: () => void;
	/** 展开详情块的 ref 回调：记录实测高度。 */
	readonly measureDetail: (node: HTMLDivElement | null) => void;
	/** 悬停回调：滚动期间只记住哈希，停止后补取。 */
	readonly hoverOrDefer: (hash: string | null) => void;
}

/**
 * 提交图的滚动与窗口化状态。
 *
 * @param options - 见 {@link UseGraphWindowingOptions}。
 * @returns 见 {@link UseGraphWindowingResult}。
 */
export function useGraphWindowing({
	rows, selectedIndex, commits, moreCommitsAvailable, onLoadMore, onHoverCommit,
}: UseGraphWindowingOptions): UseGraphWindowingResult {
	const graphRef = React.useRef<HTMLDivElement | null>(null);
	/** 可视区高度；窗口化渲染据此决定渲染哪一段。 */
	const [viewportHeight, setViewportHeight] = React.useState(0);
	/** 可视窗口的起始行下标；滚动按帧合并后才更新。 */
	const [topIndex, setTopIndex] = React.useState(0);
	/** 最近一次算出的行偏移表；滚动处理按它换算起始行。 */
	const offsetsRef = React.useRef(new Float64Array(0));
	/** 已排队但尚未执行的一帧；卸载时取消。 */
	const cancelFrameRef = React.useRef<(() => void) | null>(null);
	/** 展开详情的实测高度；没有展开时为 0。 */
	const [detailHeight, setDetailHeight] = React.useState(0);
	/** 详情块的尺寸观察者。 */
	const detailObserverRef = React.useRef<ResizeObserver | null>(null);
	/** 一次加载完成前不重复请求下一页。 */
	const loadPendingRef = React.useRef(false);
	/** 兜底解除占用的定时器：失败时提交列表不变，靠它恢复可重试。 */
	const settleTimerRef = React.useRef<number | null>(null);
	/** 上一次触发取数时的滚动位置：同一位置只触发一次，避免惯性滚动连锁取数。 */
	const lastLoadedAtRef = React.useRef<number | null>(null);
	/** 上次请求时的提交列表：引用变化说明确实取回了新数据。 */
	const requestedForRef = React.useRef<readonly unknown[]>(commits);
	const [loadingMore, setLoadingMore] = React.useState(false);
	// 回调与标志经 ref 读取：调用方每次渲染都会传新的函数，直接进依赖会让下方 effect 每帧重跑。
	const moreRef = React.useRef(moreCommitsAvailable);
	moreRef.current = moreCommitsAvailable;
	const onLoadMoreRef = React.useRef(onLoadMore);
	onLoadMoreRef.current = onLoadMore;
	/** 滚动期间最近一次悬停的哈希，静默后补取。 */
	const pendingHoverRef = React.useRef<string | null>(null);
	/** 滚动静默判定的定时器。 */
	const scrollSettleRef = React.useRef<number | null>(null);

	/** 悬停回调：滚动期间只记住哈希，停止后由 handleScroll 补取。 */
	const hoverOrDefer = React.useCallback((hash) => {
		pendingHoverRef.current = hash;
		if (scrollSettleRef.current !== null) return;
		onHoverCommit?.(hash);
	}, [onHoverCommit]);

	/**
	 * 解除占用，允许下一次滚动再取。
	 *
	 * @param allowRetry - 是否清掉「上次触发位置」。成功取回时不清：位置未变说明用户还停在原处，
	 * 惯性滚动的后续事件不该再触发一页。超时兜底时清，让同一位置在失败后仍能重试。
	 * @returns 无。
	 */
	const releasePending = React.useCallback((allowRetry) => {
		if (settleTimerRef.current !== null) {
			clearTimeout(settleTimerRef.current);
			settleTimerRef.current = null;
		}
		loadPendingRef.current = false;
		if (allowRetry) lastLoadedAtRef.current = null;
		setLoadingMore(false);
	}, []);

	/**
	 * 滚动到距底部 `AUTO_LOAD_THRESHOLD` 以内时取下一页。
	 *
	 * 判定见 `auto-load.ts` 的 `shouldLoadMore`。
	 *
	 * @param chain - 是否为「上一页刚取回」之后的自动续取。
	 * @returns 无。
	 */
	const maybeLoadMore = React.useCallback((chain) => {
		const element = graphRef.current;
		const metrics = element === null
			? null
			: { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, clientHeight: element.clientHeight };
		if (!shouldLoadMore({
			hasMore: moreRef.current, pending: loadPendingRef.current, metrics, chain,
			lastLoadedAt: lastLoadedAtRef.current,
		})) return;
		lastLoadedAtRef.current = metrics === null ? null : metrics.scrollTop;
		loadPendingRef.current = true;
		setLoadingMore(true);
		// 失败时提交列表不变，超时兜底解除，避免一次失败后自动加载永久停摆。
		settleTimerRef.current = setTimeout(() => { releasePending(true); }, LOAD_MORE_SETTLE_MS);
		onLoadMoreRef.current();
	}, [releasePending]);

	/** 记录展开详情的实测高度，供行偏移计算使用。 */
	const measureDetail = React.useCallback((node) => {
		if (detailObserverRef.current !== null) {
			detailObserverRef.current.disconnect();
			detailObserverRef.current = null;
		}
		if (node === null) { setDetailHeight(0); return; }
		setDetailHeight(node.clientHeight);
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => { setDetailHeight(node.clientHeight); });
		observer.observe(node);
		detailObserverRef.current = observer;
	}, []);

	React.useEffect(() => () => {
		if (detailObserverRef.current !== null) detailObserverRef.current.disconnect();
	}, []);

	/**
	 * 按当前滚动位置重算起始行。
	 *
	 * @returns 无。
	 */
	const syncTopIndex = React.useCallback(() => {
		const element = graphRef.current;
		const offsets = offsetsRef.current;
		const next = element === null ? 0 : topIndexOf(offsets, element.scrollTop, offsets.length - 1);
		setTopIndex((previous) => (previous === next ? previous : next));
	}, []);

	/** 把滚动引起的重算合并到下一帧；同一帧内只排队一次。 */
	const scheduleTopIndex = React.useCallback(() => {
		if (cancelFrameRef.current !== null) return;
		const run = (): void => {
			cancelFrameRef.current = null;
			syncTopIndex();
		};
		if (typeof requestAnimationFrame === 'function') {
			const handle = requestAnimationFrame(run);
			cancelFrameRef.current = () => { cancelAnimationFrame(handle); };
			return;
		}
		const timer = window.setTimeout(run, 0);
		cancelFrameRef.current = () => { clearTimeout(timer); };
	}, [syncTopIndex]);

	/** 记录滚动位置、触发窗口重算，并推迟滚动期间的悬停请求。 */
	const handleScroll = React.useCallback(() => {
		const element = graphRef.current;
		if (element === null) return;
		// 用户滚动：不限制续取，只要到了底部就取。
		maybeLoadMore(false);
		scheduleTopIndex();
		if (scrollSettleRef.current !== null) clearTimeout(scrollSettleRef.current);
		scrollSettleRef.current = window.setTimeout(() => {
			scrollSettleRef.current = null;
			const hash = pendingHoverRef.current;
			if (hash !== null) onHoverCommit?.(hash);
		}, SCROLL_SETTLE_MS);
	}, [maybeLoadMore, onHoverCommit, scheduleTopIndex]);

	React.useEffect(() => () => {
		if (scrollSettleRef.current !== null) clearTimeout(scrollSettleRef.current);
		if (cancelFrameRef.current !== null) cancelFrameRef.current();
	}, []);

	// 记录可视高度：窗口化渲染据此决定渲染哪一段；容器尺寸变化时重算。
	React.useEffect(() => {
		const element = graphRef.current;
		if (element === null) return undefined;
		const update = (): void => { setViewportHeight(element.clientHeight); };
		update();
		if (typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => { observer.disconnect(); };
	}, []);

	/*
	 * 取回新数据后解除占用，并在内容仍未填满容器时续取下一页。
	 *
	 * 续取只补「首屏填不满」这一种情形：容器已可滚动时不续取，等用户再滚动触发，
	 * 否则停在底部会一页接一页地连锁加载。
	 */
	React.useEffect(() => {
		if (commits === requestedForRef.current) return;
		requestedForRef.current = commits;
		// 成功取回：保留「上次触发位置」，让惯性滚动的后续事件不再触发一页。
		releasePending(false);
		maybeLoadMore(true);
	}, [commits, moreCommitsAvailable, releasePending, maybeLoadMore]);

	React.useEffect(() => () => { if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current); }, []);

	/*
	 * 行偏移按 ROW_HEIGHT 累加，展开详情的那一行额外加上它的实测高度，下方各行因此不会错位。
	 */
	const offsets = React.useMemo(() => {
		const out = new Float64Array(rows.length + 1);
		for (let index = 0; index < rows.length; index++) {
			out[index + 1] = out[index] + ROW_HEIGHT + (index === selectedIndex ? detailHeight : 0);
		}
		return out;
	}, [rows, selectedIndex, detailHeight]);
	offsetsRef.current = offsets;

	/*
	 * 可视区上下各多渲染 OVERSCAN_ROWS 行，滚动时不出现空白。
	 *
	 * 同一区间也作为「当前可见窗口」上报：图形区标题栏的批量翻译只译这一段内的提交。
	 */
	const range = React.useMemo(
		() => visibleRange(offsets, topIndex, viewportHeight, OVERSCAN_ROWS, rows.length),
		[offsets, topIndex, viewportHeight, rows.length],
	);

	/*
	 * 行偏移或可视高度变化后按当前滚动位置重算起始行：展开详情会改变行高，只靠滚动事件会对不上。
	 */
	React.useEffect(() => { syncTopIndex(); }, [offsets, viewportHeight, syncTopIndex]);

	return { graphRef, offsets, range, loadingMore, handleScroll, measureDetail, hoverOrDefer };
}
