/**
 * 提交图的泳道布局：把提交序列算成每行的泳道占用与连线。
 *
 * 与移植版的 graph.ts 分开：后者直接操作 SVG DOM，这里只输出纯数据，
 * 由 React 渲染，因此可以在不触碰 DOM 的情况下单测。
 *
 * 类型见 lanes.d.ts。
 */

/** 泳道几何参数，与 CSS 保持一致。 */
export const LANE_WIDTH = 14;
/** 单行像素高度。 */
export const ROW_HEIGHT = 24;
/** 节点半径。 */
export const NODE_RADIUS = 3.5;

/**
 * 计算提交序列的泳道布局。
 *
 * 算法为自顶向下的「活动泳道」扫描：每个提交占用一条当前空闲的泳道，
 * 其第一个父提交继承该泳道继续向下，其余父提交各自汇入对应泳道，
 * 由此得到与 Git Graph 一致的分支走向。
 *
 * @param commits - 提交序列，按图上的从上到下顺序。
 * @returns 每行布局与泳道总数。
 */
export function layoutCommits(commits) {
	/** 行号 -> 提交哈希。 */
	const rowOf = new Map();
	commits.forEach((commit, index) => rowOf.set(commit.hash, index));

	/** 当前每条泳道等待的提交哈希；null 表示空闲。 */
	const lanes = [];
	/** 提交哈希 -> 分配到的泳道。 */
	const laneOf = new Map();
	/** 提交哈希 -> 颜色下标（继承自父提交，使一条分支同色）。 */
	const colourOf = new Map();
	const rows = [];
	let nextColour = 0;
	let laneCount = 0;

	/** 找一条空闲泳道；没有则新开一条。 */
	const takeLane = () => {
		for (let index = 0; index < lanes.length; index++) {
			if (lanes[index] === null) return index;
		}
		lanes.push(null);
		return lanes.length - 1;
	};

	for (let row = 0; row < commits.length; row++) {
		const commit = commits[row];
		// 该提交可能已被某个父提交「预约」了泳道（它作为父出现在上面）。
		let lane = laneOf.get(commit.hash);
		if (lane === undefined) {
			lane = takeLane();
			laneOf.set(commit.hash, lane);
		}
		let colour = colourOf.get(commit.hash);
		if (colour === undefined) {
			colour = nextColour++;
			colourOf.set(commit.hash, colour);
		}

		const segments = [];
		// 本行结束时，该泳道交给第一个父提交；没有父提交则释放。
		const [firstParent, ...otherParents] = commit.parents;

		if (firstParent !== undefined && rowOf.has(firstParent)) {
			laneOf.set(firstParent, lane);
			colourOf.set(firstParent, colour);
			lanes[lane] = firstParent;
			segments.push({
				from: { row, lane },
				to: { row: row + 1, lane },
				straight: true,
				colour,
			});
		} else {
			lanes[lane] = null;
		}

		for (const parent of otherParents) {
			if (!rowOf.has(parent)) continue;
			let parentLane = laneOf.get(parent);
			if (parentLane === undefined) {
				parentLane = takeLane();
				laneOf.set(parent, parentLane);
			}
			let parentColour = colourOf.get(parent);
			if (parentColour === undefined) {
				parentColour = nextColour++;
				colourOf.set(parent, parentColour);
			}
			// 从本行汇入父提交所在泳道：先横移，再向下。
			segments.push({
				from: { row, lane },
				to: { row: row + 1, lane: parentLane },
				straight: false,
				colour: parentColour,
			});
			lanes[parentLane] = parent;
		}

		// 本行需要的宽度：本行泳道、所有连线端点、以及仍被占用的最右泳道。
		let width = lane + 1;
		for (const segment of segments) {
			width = Math.max(width, segment.from.lane + 1, segment.to.lane + 1);
		}
		for (let index = 0; index < lanes.length; index++) {
			if (lanes[index] !== null) width = Math.max(width, index + 1);
		}
		laneCount = Math.max(laneCount, width);
		rows.push({ lane, colour, segments, width });
	}

	return { rows, laneCount };
}

/** 12 色调色板，取自 DSH 主题变量。 */
export const LANE_COLOURS = [
	'var(--dsw-alias-lane-0, #4f8ff7)',
	'var(--dsw-alias-lane-1, #d4629a)',
	'var(--dsw-alias-lane-2, #5cb85c)',
	'var(--dsw-alias-lane-3, #e0a63c)',
	'var(--dsw-alias-lane-4, #9b7bf6)',
	'var(--dsw-alias-lane-5, #ef7a6d)',
	'var(--dsw-alias-lane-6, #39c5c5)',
	'var(--dsw-alias-lane-7, #c98ad4)',
	'var(--dsw-alias-lane-8, #a8c93a)',
	'var(--dsw-alias-lane-9, #f0954a)',
	'var(--dsw-alias-lane-10, #8f7ff0)',
	'var(--dsw-alias-lane-11, #d9c04a)',
];

/**
 * 取泳道颜色。
 *
 * @param colour - 颜色下标。
 * @returns CSS 颜色值。
 */
export function laneColour(colour) {
	return LANE_COLOURS[colour % LANE_COLOURS.length];
}
