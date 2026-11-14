/**
 * 评论浮窗的落位：在视口坐标系里挑一侧、并把浮窗钳进视口内。
 *
 * 浮窗按 `fixed` 定位，因此不受滚动视口与文件段的裁切；代价是位置必须自己算——既要
 * 避开刚选过的代码（落在指针的反侧），又要在那一侧放不下时翻到另一侧，最后把上边
 * 与高度同时钳进视口，保证整块可见。
 */

/** 浮窗与选区之间留出的间隙。 */
const GAP = 8;

/** 浮窗距视口边缘的最小留白。 */
const EDGE = 8;

/** 浮窗的最小可用高度：再小就没有输入框可用了。 */
const MIN_USABLE = 120;

/** 一次落位的结果；坐标与尺寸都是 `fixed` 定位用的视口像素。 */
export interface ComposerBox {
	/** 浮窗上边到视口上边的距离。 */
	readonly top: number;
	/** 浮窗左边到视口左边的距离。 */
	readonly left: number;
	/** 浮窗宽度。 */
	readonly width: number;
	/** 高度上限：内容更高时浮窗内部滚动，而不是溢出视口。 */
	readonly maxHeight: number;
	/** 实际落在选区的哪一侧。 */
	readonly side: 'above' | 'below';
}

/** 需要落位的输入。 */
export interface ComposerPlacement {
	/** 差异视图的外层：决定水平对齐。 */
	readonly host: Element;
	/** 可选中的行，按显示顺序。 */
	readonly rows: readonly Element[];
	/** 已选区间，`low`/`high` 是 `rows` 的下标。 */
	readonly range: { readonly low: number; readonly high: number };
	/** 期望的一侧：`true` 表示浮在选区上方（向下拖时指针在下方）。 */
	readonly forward: boolean;
	/** 浮窗当前高度；首次落位时可能为 0。 */
	readonly height: number;
	/** 视口尺寸；默认取 `window.innerWidth`/`innerHeight`。 */
	readonly viewport?: { readonly width: number; readonly height: number };
}

/**
 * 两次落位是否等价。
 *
 * 浮窗尺寸会随落位结果变化，而落位又要读浮窗高度，因此必须能判断「这次算出来的和上次
 * 一样」，否则重排会自己触发自己。
 *
 * @param left - 上一次的落位，可能还没有。
 * @param right - 这一次的落位。
 * @returns 等价时为 true。
 */
export function sameBox(left: ComposerBox | null, right: ComposerBox | null): boolean {
	if (left === null || right === null) return left === right;
	// 取整比较：亚像素抖动不该触发重排。
	return Math.round(left.top) === Math.round(right.top)
		&& Math.round(left.left) === Math.round(right.left)
		&& Math.round(left.width) === Math.round(right.width)
		&& Math.round(left.maxHeight) === Math.round(right.maxHeight)
		&& left.side === right.side;
}

/**
 * 把浮窗放进视口。
 *
 * @param placement - 选区与视口尺寸。
 * @returns 落位结果；区间末端不在渲染结果里时返回 null（此时不显示浮窗）。
 */
export function placeComposer(placement: ComposerPlacement): ComposerBox | null {
	const { host, rows, range, forward, height } = placement;
	if (range.high >= rows.length) return null;
	const viewport = placement.viewport ?? { width: window.innerWidth, height: window.innerHeight };
	const hostBox = host.getBoundingClientRect();
	const width = Math.max(0, hostBox.width - EDGE * 2);
	const left = hostBox.left + EDGE;
	// 选区的两条边：上缘取区间首行、下缘取末行；翻转时按最终侧重新取行。
	const topEdgeRow = () => rows[range.low].getBoundingClientRect();
	const bottomEdgeRow = () => rows[range.high].getBoundingClientRect();
	const estimated = height > 0 ? height : MIN_USABLE;
	// 期望侧：向下拖时指针停在选区下方，浮窗应贴在选区上缘；向上拖则相反。
	const preferred: 'above' | 'below' = forward ? 'above' : 'below';
	const topIf = (side: 'above' | 'below'): number => side === 'above'
		? topEdgeRow().top - GAP - estimated
		: bottomEdgeRow().bottom + GAP;
	/** 某一侧的原始可用高度，未做钳制。 */
	const roomFor = (side: 'above' | 'below'): number => side === 'above'
		? topEdgeRow().top - GAP - EDGE
		: viewport.height - EDGE - (bottomEdgeRow().bottom + GAP);
	const other: 'above' | 'below' = preferred === 'above' ? 'below' : 'above';
	// 期望侧连最小可用高度都没有、而另一侧更宽裕时才翻侧：用户已用拖动方向表达了意图，
	// 只是空间紧张时应当压缩高度让它内部滚动，而不是翻到会挡住选区的那一侧。
	const side: 'above' | 'below' = roomFor(preferred) >= MIN_USABLE || roomFor(other) <= roomFor(preferred)
		? preferred
		: other;
	const desired = topIf(side);
	// 钳进视口：上边不小于留白，下边不超出视口；高度不够时让浮窗内部滚动。
	const top = Math.max(EDGE, Math.min(desired, viewport.height - EDGE - MIN_USABLE));
	const maxHeight = Math.max(MIN_USABLE, viewport.height - EDGE - top);
	return { top, left, width, maxHeight, side };
}
