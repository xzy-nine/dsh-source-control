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
/** 普通提交的节点半径。 */
export const NODE_RADIUS = 4;
/** 当前分支节点的外环半径。 */
export const HEAD_NODE_RADIUS = 5;
/** 合并提交节点的外环半径。 */
export const MERGE_NODE_RADIUS = 4;
/** 合并提交节点的内点半径。 */
export const MERGE_CORE_RADIUS = 2.2;
/** 环节点的线宽。 */
export const RING_STROKE = 2;
/** 泳道线宽。 */
export const LANE_STROKE = 2;
/** 线段与节点外沿之间的留白。 */
export const NODE_GAP = 1;

/**
 * 节点外沿半径：线段在此断开，节点内部不画线。
 *
 * @param kind - 节点种类：'head'、'merge' 或 'plain'。
 * @returns 外沿半径（像素），含线宽与留白。
 */
export function nodeOuterRadius(kind) {
	if (kind === 'head') return HEAD_NODE_RADIUS + RING_STROKE / 2 + NODE_GAP;
	if (kind === 'merge') return MERGE_NODE_RADIUS + RING_STROKE / 2 + NODE_GAP;
	return NODE_RADIUS + NODE_GAP;
}

/**
 * 计算提交序列的泳道布局。
 *
 * 每条泳道持有一个「正在等待的提交」与它所属分支的颜色。扫描分四步：
 *
 * 1. 收集所有正在等待本行提交的泳道；最左的一条是它的落点，其余是本行汇入的
 *    分支（画曲线并入后立即释放，否则会永久占用一条泳道）。
 * 2. 仍在等待其它提交的泳道，整行画贯穿线——漏掉这一步分支线会在行间断开。
 * 3. 本行提交若来自上方（被某条泳道等待），画入线；否则它是分支的头。
 * 4. 第一个父提交继承本泳道与颜色；其余父提交是在本行分出的分支，各占一条泳道。
 *
 * @param commits - 提交序列，按图上的从上到下顺序。
 * @returns 每行布局与泳道总数。
 */
export function layoutCommits(commits) {
	/** 行号 -> 提交哈希。 */
	const rowOf = new Map();
	commits.forEach((commit, index) => rowOf.set(commit.hash, index));

	/** 泳道 -> 正在等待的提交及颜色；null 表示空闲。 */
	const lanes = [];
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
		/** 进入本行时各泳道在等谁：贯穿线按这份快照画。 */
		const awaited = lanes.slice();

		/** 正在等待本行提交的泳道，从左到右。 */
		const waiting = [];
		for (let index = 0; index < lanes.length; index++) {
			if (lanes[index] !== null && lanes[index].hash === commit.hash) waiting.push(index);
		}

		// 落点：最左的等待泳道，或新开一条（本行是分支的头）。
		const lane = waiting.length > 0 ? waiting[0] : takeLane();
		const colour = waiting.length > 0 ? lanes[lane].colour : nextColour++;

		const segments = [];

		// 1) 其它泳道：仍在等别的提交的整行贯穿；也在等本提交的弯入节点后释放。
		for (let index = 0; index < awaited.length; index++) {
			const entry = awaited[index];
			if (entry === null || index === lane) continue;
			if (entry.hash === commit.hash) {
				// 汇入本行提交：上半行曲线落到节点，该泳道随即空闲。
				segments.push({ lane: index, toLane: lane, fromTop: true, toBottom: false, colour: entry.colour, curved: true });
				lanes[index] = null;
			} else {
				segments.push({ lane: index, toLane: index, fromTop: true, toBottom: true, colour: entry.colour, curved: false });
			}
		}

		// 2) 本行提交的入线：被上方等待时从行顶画到节点。
		const awaitedAtLane = awaited[lane] ?? null;
		const inbound = awaitedAtLane !== null && awaitedAtLane.hash === commit.hash;

		const [firstParent, ...otherParents] = commit.parents ?? [];
		const hasFirstParent = firstParent !== undefined && rowOf.has(firstParent);

		if (inbound) {
			segments.push({ lane, toLane: lane, fromTop: true, toBottom: hasFirstParent, colour, curved: false });
		}

		// 3) 第一个父提交：继承本泳道与颜色。
		if (hasFirstParent) {
			lanes[lane] = { hash: firstParent, colour };
			if (!inbound) {
				// 分支的头：从节点画到行底。
				segments.push({ lane, toLane: lane, fromTop: false, toBottom: true, colour, curved: false });
			}
		} else {
			lanes[lane] = null;
		}

		// 4) 其余父提交：本行分出的分支，各占一条泳道（已在等待则并入）。
		for (const parent of otherParents) {
			if (!rowOf.has(parent)) continue;
			let parentLane = -1;
			for (let index = 0; index < lanes.length; index++) {
				if (lanes[index] !== null && lanes[index].hash === parent) { parentLane = index; break; }
			}
			if (parentLane === -1) {
				parentLane = takeLane();
				lanes[parentLane] = { hash: parent, colour: nextColour++ };
			}
			segments.push({
				lane, toLane: parentLane, fromTop: false, toBottom: true,
				colour: lanes[parentLane].colour, curved: true,
			});
		}

		// 本行需要的宽度：线段端点与仍被占用的最右泳道。
		let width = lane + 1;
		for (const segment of segments) {
			width = Math.max(width, segment.lane + 1, segment.toLane + 1);
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

/** 泳道中心线在行内的横向像素位置。 */
export function laneCentre(lane) {
	return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/**
 * 把一条线段转成 SVG 路径描述。
 *
 * 竖直段是直线；横移段是「先竖直到行中、再横移、再竖直」的两段折线；
 * 弯曲段是三次贝塞尔，两端保持竖直切向，控制点各取纵向跨度的一半——
 * 这保证入线从行顶、出线到行底都能接上相邻行的线。
 *
 * 给出 node 时，落到节点上的端点停在节点外沿，贯穿节点的整行线拆成上下两段
 * （kind 为 'gap'），节点内部因此不出现线。
 *
 * @param segment - 布局给出的线段。
 * @param isLast - 是否是最后一行（末行的出线终止于节点高度）。
 * @param node - 本行节点：{ x, radius }；不给时线段画到节点中心。
 * @returns 路径描述；线段无长度时返回 null。
 */
export function segmentGeometry(segment, isLast = false, node = null) {
	const x1 = laneCentre(segment.lane);
	const x2 = laneCentre(segment.toLane);
	const half = ROW_HEIGHT / 2;
	const y1 = segment.fromTop ? 0 : half;
	const y2 = segment.toBottom ? (isLast ? half : ROW_HEIGHT) : half;
	if (y1 === y2) return null;
	const gap = node === null ? 0 : node.radius;
	// 贯穿节点的整行线：拆成上下两段，节点内部留空。
	if (gap > 0 && x1 === node.x && x2 === node.x && y1 < half && y2 > half) {
		return {
			kind: 'gap',
			upper: { x1, y1, x2: x1, y2: half - gap },
			lower: { x1, y1: half + gap, x2: x1, y2 },
		};
	}
	const start = gap > 0 && x1 === node.x && y1 === half ? half + gap : y1;
	const end = gap > 0 && x2 === node.x && y2 === half ? half - gap : y2;
	if (segment.curved && x1 !== x2) {
		const bend = (end - start) / 2;
		return { kind: 'path', d: `M ${x1} ${start} C ${x1} ${start + bend}, ${x2} ${end - bend}, ${x2} ${end}` };
	}
	if (x1 !== x2) {
		return {
			kind: 'bend',
			horizontal: { x1, y1: start, x2: x1, y2: half },
			vertical: { x1: x2, y1: half, x2, y2: end },
		};
	}
	return { kind: 'line', x1, y1: start, x2, y2: end };
}
