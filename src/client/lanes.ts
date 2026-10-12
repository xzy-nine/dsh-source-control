/**
 * 提交图的泳道布局：把提交序列算成每行的泳道占用与连线。
 *
 * 与移植版的 graph.ts 分开：后者直接操作 SVG DOM，这里只输出纯数据，
 * 由 React 渲染，因此可以在不触碰 DOM 的情况下单测。
 *
 * 几何取自 Trae CN 提交图：行高 22px、泳道宽 11px、平移圆弧半径 5px、
 * 节点基础半径 4px，曲线一律由 M / A / H / V 命令组成。
 */

/** 泳道宽度：相邻泳道中心线的水平间距。 */
export const LANE_WIDTH = 11;
/** 单行像素高度。 */
export const ROW_HEIGHT = 22;
/** 泳道平移 S 曲线的圆弧半径。 */
export const S_CURVE_RADIUS = 5;
/** 普通提交的节点半径。 */
export const NODE_RADIUS = 5;
/** 当前分支节点的外环半径。 */
export const HEAD_NODE_RADIUS = 7;
/** 当前分支节点的内点半径。 */
export const HEAD_CORE_RADIUS = 4;
/** 合并提交节点的外环半径。 */
export const MERGE_NODE_RADIUS = 6;
/** 合并提交节点的内点半径。 */
export const MERGE_CORE_RADIUS = 3;
/** 环节点的线宽。 */
export const RING_STROKE = 1.5;
/** 泳道线宽。 */
export const LANE_STROKE = 1.5;
/** 线段与节点外沿之间的留白。 */
export const NODE_GAP = 0.5;
/** 行边界的重叠量：相邻两行的线段各越界一点，消除亚像素舍入留下的接缝。 */
export const ROW_OVERLAP = 0.1;

/** 节点种类。 */
export type NodeKind = 'head' | 'merge' | 'plain';

/**
 * 节点外沿半径：线段在此断开，节点内部不画线。
 *
 * @param kind - 节点种类。
 * @returns 外沿半径（像素），含线宽与留白。
 */
export function nodeOuterRadius(kind: NodeKind): number {
	if (kind === 'head') return HEAD_NODE_RADIUS + RING_STROKE / 2 + NODE_GAP;
	if (kind === 'merge') return MERGE_NODE_RADIUS + RING_STROKE / 2 + NODE_GAP;
	return NODE_RADIUS + NODE_GAP;
}

/** 布局所需的提交形状。 */
export interface LayoutCommit {
	/** 提交哈希。 */
	readonly hash: string;
	/** 父提交哈希。 */
	readonly parents?: readonly string[];
}

/** 一条泳道线段。 */
export interface LaneSegment {
	/** 行顶的泳道。 */
	readonly lane: number;
	/** 行底的泳道。 */
	readonly toLane: number;
	/** 是否从行顶进入。 */
	readonly fromTop: boolean;
	/** 是否画到行底。 */
	readonly toBottom: boolean;
	/** 颜色下标。 */
	readonly colour: number;
}

/** 一行的布局。 */
export interface LaneRow {
	/** 本行提交所在泳道。 */
	readonly lane: number;
	/** 颜色下标。 */
	readonly colour: number;
	/** 本行的线段。 */
	readonly segments: readonly LaneSegment[];
	/** 本行需要的泳道数。 */
	readonly width: number;
}

/** 布局结果。 */
export interface LaneLayout {
	/** 每行布局。 */
	readonly rows: LaneRow[];
	/** 泳道总数。 */
	readonly laneCount: number;
}

/**
 * 计算提交序列的泳道布局。
 *
 * 每条泳道持有一个「正在等待的提交」与它所属分支的颜色。扫描分五步：
 *
 * 1. 收集所有正在等待本行提交的泳道；最左的一条是它的落点，其余是本行汇入的
 *    分支（画曲线并入后立即释放，否则会永久占用一条泳道）。
 * 2. 仍在等待其它提交的泳道，整行画贯穿线——漏掉这一步分支线会在行间断开。
 * 3. 本行提交若来自上方（被某条泳道等待），画入线；否则它是分支的头。
 * 4. 第一个父提交继承本泳道与颜色；其余父提交是在本行分出的分支，各占一条泳道。
 * 5. 压实：行内释放出的空洞由其右侧泳道左移填补，这些泳道因此画 S 形平移曲线。
 *
 * 分页加载只给出窗口内的提交：父提交落在窗口外时仍算有父提交，泳道继续被占住、
 * 线画到行底，下一次加载由同一泳道接续。压实只依赖本行之前的输入，因此窗口变长时
 * 已加载部分的行不变。
 *
 * @param commits - 提交序列，按图上的从上到下顺序。
 * @returns 每行布局与泳道总数。
 */
export function layoutCommits(commits: readonly LayoutCommit[]): LaneLayout {
	/** 泳道 -> 正在等待的提交及颜色；null 表示空闲。 */
	const lanes: Array<{ hash: string; colour: number } | null> = [];
	const rows: LaneRow[] = [];
	let nextColour = 0;
	let laneCount = 0;

	/** 找一条空闲泳道；没有则新开一条。 */
	const takeLane = (): number => {
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
		const waiting: number[] = [];
		for (let index = 0; index < lanes.length; index++) {
			const entry = lanes[index];
			if (entry !== null && entry !== undefined && entry.hash === commit.hash) waiting.push(index);
		}

		// 落点：最左的等待泳道，或新开一条（本行是分支的头）。
		const lane = waiting.length > 0 ? waiting[0] : takeLane();
		const awaitedLane = awaited[lane] ?? null;
		const inbound = awaitedLane !== null && awaitedLane.hash === commit.hash;
		const colour = inbound && awaitedLane !== null ? awaitedLane.colour : nextColour++;

		const [firstParent, ...otherParents] = commit.parents ?? [];
		// 父提交可能尚未加载：仍算有父提交，泳道继续等它。
		const hasFirstParent = firstParent !== undefined;

		// 1) 更新泳道占用：汇入本行提交的泳道释放，落点接管第一个父提交。
		for (let index = 0; index < awaited.length; index++) {
			const entry = awaited[index];
			if (entry === null || entry === undefined || index === lane) continue;
			if (entry.hash === commit.hash) lanes[index] = null;
		}
		lanes[lane] = hasFirstParent ? { hash: firstParent, colour } : null;

		// 2) 其余父提交：已在等待则并入，否则各占一条泳道。
		const parentLanes: Array<{ lane: number; colour: number }> = [];
		for (const parent of otherParents) {
			let parentLane = -1;
			for (let index = 0; index < lanes.length; index++) {
				const entry = lanes[index];
				if (entry !== null && entry !== undefined && entry.hash === parent) { parentLane = index; break; }
			}
			if (parentLane === -1) {
				parentLane = takeLane();
				lanes[parentLane] = { hash: parent, colour: nextColour++ };
			}
			// 颜色必须在压实前取：压实后泳道下标已移位。
			const entry = lanes[parentLane];
			parentLanes.push({ lane: parentLane, colour: entry === null || entry === undefined ? 0 : entry.colour });
		}

		// 3) 压实：空洞右侧的泳道左移填补，记下输入索引到输出索引的映射。
		const outIndex = new Map<number, number>();
		let write = 0;
		for (let read = 0; read < lanes.length; read++) {
			const entry = lanes[read];
			if (entry === null || entry === undefined) continue;
			if (read !== write) {
				lanes[write] = entry;
				lanes[read] = null;
			}
			outIndex.set(read, write);
			write++;
		}
		lanes.length = write;

		// 4) 线段：lane 是行顶的泳道，toLane 是行底的泳道。
		const segments: LaneSegment[] = [];
		// 本行提交的落点泳道在压实后的位置。
		const nodeOut = outIndex.get(lane) ?? lane;

		// 4a) 其它泳道：仍在等别的提交的整行贯穿（位置随压实平移）；
		//     也在等本提交的汇入节点后释放。
		for (let index = 0; index < awaited.length; index++) {
			const entry = awaited[index];
			if (entry === null || entry === undefined || index === lane) continue;
			if (entry.hash === commit.hash) {
				segments.push({ lane: index, toLane: lane, fromTop: true, toBottom: false, colour: entry.colour });
			} else {
				segments.push({ lane: index, toLane: outIndex.get(index) ?? index, fromTop: true, toBottom: true, colour: entry.colour });
			}
		}

		// 4b) 落点泳道：入线自行顶到节点，第一个父提交的出线自节点到行底。
		//     两者泳道一致时合并成一条贯穿线，由几何层在节点外沿断开。
		const inboundAtNode = inbound;
		const outboundAtNode = hasFirstParent && nodeOut === lane;
		if (inboundAtNode && outboundAtNode) {
			segments.push({ lane, toLane: lane, fromTop: true, toBottom: true, colour });
		} else {
			if (inboundAtNode) {
				segments.push({ lane, toLane: lane, fromTop: true, toBottom: false, colour });
			}
			if (hasFirstParent) {
				segments.push({ lane, toLane: nodeOut, fromTop: false, toBottom: true, colour });
			}
		}

		// 4c) 其余父提交：自节点分叉到各自的泳道。
		for (const parent of parentLanes) {
			segments.push({
				lane, toLane: outIndex.get(parent.lane) ?? parent.lane, fromTop: false, toBottom: true,
				colour: parent.colour,
			});
		}

		// 本行需要的宽度：输入与输出泳道数的较大者。
		const width = Math.max(awaited.length, lanes.length, lane + 1, 1);
		laneCount = Math.max(laneCount, width);
		rows.push({ lane, colour, segments, width });
	}

	return { rows, laneCount };
}

/** 12 色调色板，取自 DSH 主题变量。 */
export const LANE_COLOURS = [
	'var(--dsw-alias-lane-0, #2f7bff)',
	'var(--dsw-alias-lane-1, #ff3d8b)',
	'var(--dsw-alias-lane-2, #16c46a)',
	'var(--dsw-alias-lane-3, #ffab00)',
	'var(--dsw-alias-lane-4, #8b5cf6)',
	'var(--dsw-alias-lane-5, #ff4d3d)',
	'var(--dsw-alias-lane-6, #00d4d4)',
	'var(--dsw-alias-lane-7, #e040fb)',
	'var(--dsw-alias-lane-8, #a3e600)',
	'var(--dsw-alias-lane-9, #ff7a00)',
	'var(--dsw-alias-lane-10, #5b6cff)',
	'var(--dsw-alias-lane-11, #ffd400)',
];

/**
 * 取泳道颜色。
 *
 * @param colour - 颜色下标。
 * @returns CSS 颜色值。
 */
export function laneColour(colour: number): string {
	return LANE_COLOURS[colour % LANE_COLOURS.length];
}

/** 泳道中心线在行内的横向像素位置。 */
export function laneCentre(lane: number): number {
	return LANE_WIDTH * (lane + 1);
}

/** 泳道数换算成图形列宽。 */
export function laneSpanWidth(lanes: number): number {
	return LANE_WIDTH * (lanes + 1);
}

/** 线段几何：竖直段、曲线段或跨节点的上下两段。 */
export type SegmentGeometry =
	| { readonly kind: 'path'; readonly d: string }
	| { readonly kind: 'gap'; readonly upper: Line; readonly lower: Line }
	| { readonly kind: 'line'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };

/** 一条线段的两端坐标。 */
export interface Line {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
}

/** 节点几何：中心与半径。 */
export interface NodeGeometry {
	readonly x: number;
	readonly radius: number;
}

/**
 * 圆弧上到节点外沿的交点。
 *
 * 目标泳道与来源相邻时，节点圆心恰是圆弧的一个端点；本函数自该端点沿弧前进或回退，
 * 取弧上距节点圆心为 nodeRadius 的一点，使线停在节点外沿而非穿入节点。
 * nodeRadius 为 0 时返回端点本身。
 *
 * @param centre - 圆弧圆心。
 * @param node - 节点圆心。
 * @param nodeRadius - 节点外沿半径。
 * @param endAngle - 端点在弧上的角度（度，屏幕坐标）。
 * @param direction - 自端点沿弧前进的方向：+1 表示角度增大，-1 表示角度减小。
 * @returns 交点坐标。
 */
function arcEdgePoint(
	centre: { x: number; y: number }, node: { x: number; y: number }, nodeRadius: number,
	endAngle: number, direction: 1 | -1,
): { x: number; y: number } {
	const radius = LANE_WIDTH;
	if (nodeRadius <= 0) {
		const radians = (endAngle * Math.PI) / 180;
		return { x: centre.x + radius * Math.cos(radians), y: centre.y + radius * Math.sin(radians) };
	}
	// 弦长 nodeRadius 对应圆心角 θ：nodeRadius = 2R sin(θ/2)。
	const step = (2 * Math.asin(Math.min(1, nodeRadius / (2 * radius))) * 180) / Math.PI;
	const radians = ((endAngle + direction * step) * Math.PI) / 180;
	return { x: centre.x + radius * Math.cos(radians), y: centre.y + radius * Math.sin(radians) };
}

/**
 * 汇入本行节点的曲线：行顶起一段半径 LANE_WIDTH 的四分之一圆转为水平，再接入节点。
 *
 * 圆弧圆心在来源泳道中心线左（右）侧 LANE_WIDTH 处、行顶线上，终点落在行中线上、切向水平；
 * 目标泳道更远时续一段水平线接到节点外沿。目标泳道与来源相邻时圆弧终点正是节点圆心，
 * 改以圆弧与节点外沿的交点收束。
 *
 * @param x1 - 行顶的泳道中心线。
 * @param x2 - 节点所在泳道中心线。
 * @param radius - 节点外沿半径。
 * @returns SVG 路径描述。
 */
function mergeInPath(x1: number, x2: number, radius: number): string {
	const half = ROW_HEIGHT / 2;
	const leftwards = x2 < x1;
	const sweep = leftwards ? 1 : 0;
	const arcX = leftwards ? x1 - LANE_WIDTH : x1 + LANE_WIDTH;
	// 起点越界 ROW_OVERLAP：与上一行画到行底的线叠上，消除行边界接缝。
	const lead = `M ${x1} ${-ROW_OVERLAP} V 0 A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 ${sweep}`;
	if (arcX === x2) {
		// 节点圆心即圆弧终点：自 90° 端点沿弧回退到节点外沿。
		const exit = arcEdgePoint({ x: arcX, y: 0 }, { x: x2, y: half }, radius, 90, leftwards ? -1 : 1);
		return `${lead} ${exit.x} ${exit.y}`;
	}
	const edge = leftwards ? x2 + radius : x2 - radius;
	return `${lead} ${arcX} ${half} H ${edge}`;
}

/**
 * 自本行节点分叉下行的曲线：自节点外沿水平引出，末段以半径 LANE_WIDTH 的四分之一圆
 * 转为竖直落到行底。
 *
 * 圆弧圆心在目标泳道中心线旁 LANE_WIDTH 处、行底线上。目标泳道与节点相邻时水平段为零
 * 长度，改以圆弧与节点外沿的交点起画。
 *
 * @param x1 - 节点所在泳道中心线。
 * @param x2 - 分支在行底的泳道中心线。
 * @param radius - 节点外沿半径。
 * @returns SVG 路径描述。
 */
function forkOutPath(x1: number, x2: number, radius: number): string {
	const half = ROW_HEIGHT / 2;
	const sign = x2 > x1 ? 1 : -1;
	const sweep = sign > 0 ? 1 : 0;
	const arcStart = x2 - LANE_WIDTH * sign;
	// 终点越界 ROW_OVERLAP：与下一行自行顶起画的线叠上，消除行边界接缝。
	const tail = `V ${ROW_HEIGHT + ROW_OVERLAP}`;
	if (arcStart === x1) {
		// 节点圆心即圆弧起点：自 270° 端点沿弧前进到节点外沿。
		const exit = arcEdgePoint({ x: arcStart, y: ROW_HEIGHT }, { x: x1, y: half }, radius, 270, sign > 0 ? 1 : -1);
		return `M ${exit.x} ${exit.y} A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 ${sweep} ${x2} ${ROW_HEIGHT} ${tail}`;
	}
	return `M ${x1 + radius * sign} ${half} H ${arcStart} A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 ${sweep} ${x2} ${ROW_HEIGHT} ${tail}`;
}

/**
 * 泳道整行平移的 S 形路径：两段半径 S_CURVE_RADIUS 的四分之一圆接住行顶与行底的
 * 竖直切向，中间的水平段吃掉横向位移。
 *
 * @param x1 - 行顶的泳道中心线。
 * @param x2 - 行底的泳道中心线。
 * @returns SVG 路径描述。
 */
function shiftPath(x1: number, x2: number): string {
	const half = ROW_HEIGHT / 2;
	const radius = S_CURVE_RADIUS;
	const bend = half - radius;
	if (x2 < x1) {
		return `M ${x1} ${-ROW_OVERLAP} V ${bend} A ${radius} ${radius} 0 0 1 ${x1 - radius} ${half}`
			+ ` H ${x2 + radius} A ${radius} ${radius} 0 0 0 ${x2} ${half + radius} V ${ROW_HEIGHT + ROW_OVERLAP}`;
	}
	return `M ${x1} ${-ROW_OVERLAP} V ${bend} A ${radius} ${radius} 0 0 0 ${x1 + radius} ${half}`
		+ ` H ${x2 - radius} A ${radius} ${radius} 0 0 1 ${x2} ${half + radius} V ${ROW_HEIGHT + ROW_OVERLAP}`;
}

/**
 * 把一条线段转成 SVG 路径描述。
 *
 * 同泳道是竖直直线；跨泳道按方向分三种：行顶汇入节点是圆弧接水平，自节点分叉下行
 * 是水平接圆弧，整行平移是 S 形。三种曲线都在行顶与行底保持竖直切向，因此与相邻行
 * 的线连续，没有折角。
 *
 * 给出 node 时，落在节点上的竖直端点停在节点外沿，贯穿节点的整行线拆成上下两段
 * （kind 为 'gap'），节点内部因此不出现线。
 *
 * @param segment - 布局给出的线段。
 * @param node - 本行节点；不给时线段画到节点中心。
 * @returns 路径描述；线段无长度时返回 null。
 */
export function segmentGeometry(segment: LaneSegment, node: NodeGeometry | null = null): SegmentGeometry | null {
	const x1 = laneCentre(segment.lane);
	const x2 = laneCentre(segment.toLane);
	const half = ROW_HEIGHT / 2;
	const y1 = segment.fromTop ? 0 : half;
	const y2 = segment.toBottom ? ROW_HEIGHT : half;
	if (y1 === y2) return null;
	const radius = node === null ? 0 : node.radius;
	const onNode = node !== null && x1 === node.x;

	if (x1 === x2) {
		// 贯穿节点的整行线：拆成上下两段，节点内部留空。
		if (onNode && y1 < half && y2 > half) {
			return {
				kind: 'gap',
				upper: { x1, y1: -ROW_OVERLAP, x2: x1, y2: half - radius },
				lower: { x1, y1: half + radius, x2: x1, y2: ROW_HEIGHT + ROW_OVERLAP },
			};
		}
		const start = onNode && y1 === half ? half + radius : y1 === 0 ? -ROW_OVERLAP : y1;
		const end = onNode && y2 === half ? half - radius : y2 === ROW_HEIGHT ? ROW_HEIGHT + ROW_OVERLAP : y2;
		return { kind: 'line', x1, y1: start, x2, y2: end };
	}

	// 汇入本行节点：行顶起画，上半行落到节点。
	if (segment.fromTop && !segment.toBottom) {
		return { kind: 'path', d: mergeInPath(x1, x2, node !== null && x2 === node.x ? node.radius : 0) };
	}
	// 自本行节点分叉：下半行起画，落到行底。
	if (!segment.fromTop && segment.toBottom) {
		return { kind: 'path', d: forkOutPath(x1, x2, onNode ? radius : 0) };
	}
	// 整行平移：行顶到行底的 S 形过渡。
	return { kind: 'path', d: shiftPath(x1, x2) };
}
