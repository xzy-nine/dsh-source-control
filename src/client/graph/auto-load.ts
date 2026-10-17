/**
 * 图形区自动加载更多的判定：纯函数，可直接单测。
 *
 * 判据与 React 无关，只有「容器度量 + 是否续取 + 上次触发位置」三项输入，
 * 因此从组件里抽出来单独覆盖，不必挂载 jsdom。
 */

/** 距底部多近才触发取数（像素）。 */
export const AUTO_LOAD_THRESHOLD = 120;

/** 触发取数前所需的容器度量。 */
export interface ScrollMetrics {
	/** 内容总高。 */
	readonly scrollHeight: number;
	/** 当前滚动位置。 */
	readonly scrollTop: number;
	/** 可视区高度。 */
	readonly clientHeight: number;
}

/** 判定输入。 */
export interface ShouldLoadInput {
	/** 是否还有更多提交。 */
	readonly hasMore: boolean;
	/** 是否已有一次取数在途。 */
	readonly pending: boolean;
	/** 容器度量；容器未挂载时为 null。 */
	readonly metrics: ScrollMetrics | null;
	/**
	 * 是否为「上一页刚取回」之后的自动续取。
	 *
	 * 续取只在内容仍未填满视口时允许；容器已可滚动时不续取，等用户再滚动触发。
	 */
	readonly chain: boolean;
	/** 上一次触发取数时的滚动位置；从未触发过为 null。 */
	readonly lastLoadedAt: number | null;
}

/**
 * 是否应当取下一页。
 *
 * 三道闸门：还有更多且无在途请求、距底部不超过阈值、以及滚动位置未与上次触发重复。
 * 位置闸门只作用于用户滚动（`chain` 为 false）：惯性滚动在取数期间持续产生 `scroll` 事件，
 * 取回后位置未变时这些事件会立刻再触发一次，形成一页接一页的连锁加载。
 *
 * @param input - 见 {@link ShouldLoadInput}。
 * @returns 应当取数时为 true。
 */
export function shouldLoadMore(input: ShouldLoadInput): boolean {
	const { hasMore, pending, metrics, chain, lastLoadedAt } = input;
	if (!hasMore || pending) return false;
	if (metrics === null) return false;
	// 续取只补「首屏填不满」：容器已可滚动时交给用户滚动触发。
	if (chain && metrics.scrollHeight - metrics.clientHeight > AUTO_LOAD_THRESHOLD) return false;
	const remaining = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
	if (remaining > AUTO_LOAD_THRESHOLD) return false;
	if (!chain && metrics.scrollTop === lastLoadedAt) return false;
	return true;
}
