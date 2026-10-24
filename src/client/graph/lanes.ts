/**
 * 提交图的泳道布局：把提交序列算成每行的泳道占用与连线。
 *
 * 只输出纯数据，由 React 渲染，因此可以在不触碰 DOM 的情况下单测。
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
/** 领先/落后指示节点的外圈半径。 */
export const INDICATOR_NODE_RADIUS = 7;
/** 领先/落后指示节点的内圈半径。 */
export const INDICATOR_RING_RADIUS = 5;
/** 领先/落后指示节点内圈的虚线样式。 */
export const INDICATOR_DASH = '4,2';
/** 泳道线宽。 */
export const LANE_STROKE = 1.5;
/** 线段与节点外沿之间的留白。 */
export const NODE_GAP = 0.5;
/** 行边界的重叠量：相邻两行的线段各越界一点，消除亚像素舍入留下的接缝。 */
export const ROW_OVERLAP = 0.1;

/** 节点种类。 */
export type NodeKind = 'head' | 'merge' | 'plain' | 'incoming' | 'outgoing';

/**
 * 节点外沿半径：线段在此断开，节点内部不画线。
 *
 * @param kind - 节点种类。
 * @returns 外沿半径（像素），含线宽与留白。
 */
export function nodeOuterRadius(kind: NodeKind): number {
	if (kind === 'head') return HEAD_NODE_RADIUS + RING_STROKE / 2 + NODE_GAP;
	if (kind === 'incoming' || kind === 'outgoing') return INDICATOR_NODE_RADIUS + RING_STROKE / 2 + NODE_GAP;
	if (kind === 'merge') return MERGE_NODE_RADIUS + RING_STROKE / 2 + NODE_GAP;
	return NODE_RADIUS + NODE_GAP;
}

/** 布局所需的提交形状。 */
export interface LayoutCommit {
	/** 提交哈希。 */
	readonly hash: string;
	/** 父提交哈希。 */
	readonly parents?: readonly string[];
	/** 指向本提交的本地分支名。 */
	readonly heads?: readonly string[];
	/** 指向本提交的远程跟踪分支。 */
	readonly remotes?: readonly { readonly name: string }[];
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
	/** 颜色。 */
	readonly colour: string;
}

/** 一行的布局。 */
export interface LaneRow {
	/** 本行提交所在泳道。 */
	readonly lane: number;
	/** 颜色。 */
	readonly colour: string;
	/** 本行的线段。 */
	readonly segments: readonly LaneSegment[];
	/** 本行需要的泳道数。 */
	readonly width: number;
	/** 本行提交哈希；领先/落后指示行为 null。 */
	readonly hash: string | null;
	/** 指示行种类；普通提交行为 undefined。 */
	readonly indicator?: 'incoming' | 'outgoing';
}

/**
 * 泳道状态：某个边界处的泳道占用。
 *
 * null 表示空位；位置有意义（泳道下标即横向位置），因此不能压缩掉。
 */
export type LaneSeed = ReadonlyArray<{ readonly hash: string | null; readonly colour: string } | null>;

/** 续算所需的完整状态：泳道占用与色池游标。 */
export interface LaneCursor {
	/** 各泳道当前等待的提交与颜色。 */
	readonly lanes: LaneSeed;
	/** 色池下一次取用的下标；不带它续算会让新泳道换色。 */
	readonly nextColour: number;
}

/** 布局结果。 */
export interface LaneLayout {
	/** 每行布局。 */
	readonly rows: LaneRow[];
	/** 泳道总数。 */
	readonly laneCount: number;
	/** 末行之后的完整状态；续算或裁头后可从它接续。 */
	readonly endCursor: LaneCursor;

}
/** 决定引用色的分支名与领先/落后尖端。 */
export interface LaneRefs {
	/** 本地当前分支名。 */
	readonly head?: string | null;
	/** 上游远程跟踪分支名（如 origin/main）。 */
	readonly upstream?: string | null;
	/** 本地与上游的合并基提交哈希；无上游或无共同祖先时为 null。 */
	readonly baseTip?: string | null;
	/** 本地领先时的 HEAD 尖端哈希；无领先为 null。 */
	readonly localTip?: string | null;
	/** 云端领先时的上游尖端哈希；无落后为 null。 */
	readonly remoteTip?: string | null;
}

/** 一条等待中的泳道。 */
interface Lane {
	/** 该泳道正在等待的提交哈希；null 表示尚无归属。 */
	hash: string | null;
	/** 泳道颜色。 */
	colour: string;
}

/**
 * 计算提交序列的泳道布局。
 *
 * 泳道位置一次分配后保持稳定：本行提交所在泳道原位让给第一父提交，其余泳道原样延续，
 * 合并的其余父提交追加到最右侧新泳道。行间不重排、不左移压实。
 *
 * 领先/落后以虚拟行插入：云端领先插在远端尖端之前，本地领先插在 HEAD 之前，
 * 原有行依次下移。
 *
 * 分页加载只给出窗口内的提交：父提交落在窗口外时仍算有父提交，泳道继续被占住、
 * 线画到行底，下一次加载由同一泳道接续。布局只依赖本行之前的输入，因此窗口变长时
 * 已加载部分的行不变。
 *
 * @param commits - 提交序列，按图上的从上到下顺序。
 * @param refs - 决定引用色的本地分支与上游，以及领先/落后的两侧尖端。
 *
 * 单遍扫描：逐提交顺序处理、无回溯，泳道在提交离开后被后续复用，因此泳道数只与并发分支数有关。
 * 起始泳道可由 `seed` 给出，用于续接上一段：裁头后保留的部分因此不会整体左移。
 *
 * @returns 每行布局、泳道总数与末态泳道。
 * @returns 每行布局与泳道总数。
 */
export function layoutCommits(commits: readonly LayoutCommit[], refs: LaneRefs = {}, seed: LaneCursor | null = null): LaneLayout {
	const commitByHash = new Map<string, LayoutCommit>();
	for (const commit of commits) commitByHash.set(commit.hash, commit);
	// 色池游标随种子续接：否则裁头后新分配的泳道会与裁之前不同色。
	let nextColour = seed?.nextColour ?? 0;

	/** 无引用的泳道按 5 色池轮转分配。 */
	const poolColour = (): string => LANE_COLOURS[nextColour++ % LANE_COLOURS.length];
	/** 引用色优先级：本地 HEAD 蓝 → 上游紫 → 合并基橙；提交不承载引用时为 null。 */
	const refColour = (hash: string | null): string | null => {
		if (hash === null) return null;
		const commit = commitByHash.get(hash);
		if (commit === undefined) return null;
		if (refs.head !== undefined && refs.head !== null && (commit.heads ?? []).includes(refs.head)) {
			return HEAD_REF_COLOUR;
		}
		if (refs.upstream !== undefined && refs.upstream !== null
			&& (commit.remotes ?? []).some((remote) => remote.name === refs.upstream)) {
			return REMOTE_REF_COLOUR;
		}
		if (refs.baseTip !== undefined && refs.baseTip !== null && hash === refs.baseTip) {
			return BASE_REF_COLOUR;
		}
		return null;
	};

	let lanes: Array<Lane | null> = (seed?.lanes ?? []).map((lane) => (lane === null ? null : { ...lane }));
	let laneCount = 0;
	const baseRows: LaneRow[] = [];

	for (const commit of commits) {
		const input = lanes.map((lane) => (lane === null ? null : { ...lane }));
		const parentIds = commit.parents ?? [];
		const commitColour = refColour(commit.hash);

		// 第一遍：消费与继承。等待本提交的泳道中，最左的一条原位让给第一父提交，
		// 其余汇入它后释放（否则这些泳道会永远等待一个已经出现过的提交，成为幽灵泳道）。
		const output: Array<Lane | null> = [];
		let nodeLane = -1;
		for (const [index, lane] of input.entries()) {
			if (lane === null || lane.hash !== commit.hash) { output.push(lane === null ? null : { ...lane }); continue; }
			if (nodeLane === -1) {
				nodeLane = index;
				output.push({ hash: parentIds[0] ?? null, colour: commitColour ?? lane.colour });
			} else {
				output.push(null);
			}
		}
		// 未被任何泳道等待：本行是分支的头，节点放进最左空位，没有空位则追加到最右。
		const inbound = nodeLane !== -1;
		if (!inbound) {
			nodeLane = output.findIndex((lane) => lane === null);
			if (nodeLane === -1) {
				output.push({ hash: parentIds[0] ?? null, colour: commitColour ?? poolColour() });
				nodeLane = output.length - 1;
			} else {
				output[nodeLane] = { hash: parentIds[0] ?? null, colour: commitColour ?? poolColour() };
			}
		}

		// 其余父提交并入已在等待它的泳道，否则放进空位或追加到最右；
		// 同一提交被两条泳道等待会让它在后续行画出多余的交汇弧。
		const parentColour = (parent: string): string => refColour(parent) ?? poolColour();
		const placeLane = (hash: string, colour: string): number => {
			const existing = output.findIndex((lane) => lane !== null && lane.hash === hash);
			if (existing !== -1) return existing;
			const free = output.findIndex((lane) => lane === null);
			if (free !== -1) { output[free] = { hash, colour }; return free; }
			output.push({ hash, colour });
			return output.length - 1;
		};
		const forkLanes: Array<{ lane: number; colour: string }> = [];
		for (let w = 1; w < parentIds.length; w++) {
			const parent = parentIds[w];
			const lane = placeLane(parent, parentColour(parent));
			const colour = (output[lane] as Lane).colour;
			forkLanes.push({ lane, colour });
		}

		// 节点颜色：本提交的引用色优先，否则取所在泳道的颜色。
		const nodeColour = commitColour ?? (inbound ? input[nodeLane]?.colour : output[nodeLane]?.colour) ?? poolColour();
		// 线段：泳道下标即横向位置，不因泳道消亡而左移。
		const segments: LaneSegment[] = [];
		for (const [index, lane] of input.entries()) {
			if (lane === null || index === nodeLane) continue;
			// 其余等待本提交的泳道汇入节点后释放。
			if (lane.hash === commit.hash) {
				segments.push({ lane: index, toLane: nodeLane, fromTop: true, toBottom: false, colour: lane.colour });
			} else if (lane.hash !== null) {
				segments.push({ lane: index, toLane: index, fromTop: true, toBottom: true, colour: lane.colour });
			}
		}
		// 节点泳道：入线自行顶到节点，出线自节点到行底；两者并存时合成贯穿线。
		const outboundColour = output[nodeLane]?.colour ?? nodeColour;
		const hasOutbound = parentIds.length > 0;
		if (inbound && hasOutbound) {
			segments.push({ lane: nodeLane, toLane: nodeLane, fromTop: true, toBottom: true, colour: nodeColour });
		} else {
			if (inbound) segments.push({ lane: nodeLane, toLane: nodeLane, fromTop: true, toBottom: false, colour: nodeColour });
			if (hasOutbound) segments.push({ lane: nodeLane, toLane: nodeLane, fromTop: false, toBottom: true, colour: outboundColour });
		}
		for (const fork of forkLanes) {
			if (fork.lane === nodeLane) continue;
			segments.push({ lane: nodeLane, toLane: fork.lane, fromTop: false, toBottom: true, colour: fork.colour });
		}

		const width = Math.max(input.length, output.length, nodeLane + 1, 1);
		laneCount = Math.max(laneCount, width);
		baseRows.push({ lane: nodeLane, colour: nodeColour, segments, width, hash: commit.hash });
		lanes = output;
	}

	// 领先/落后：以虚拟行插入，原有行下移。
	const rows = baseRows.slice();
	const insertIndicator = (index: number, indicator: 'incoming' | 'outgoing'): void => {
		if (index < 0) return;
		const target = rows[index];
		const segments: LaneSegment[] = [];
		for (let lane = 0; lane < target.width; lane++) {
			if (lane === target.lane) continue;
			segments.push({ lane, toLane: lane, fromTop: true, toBottom: true, colour: LANE_COLOURS[lane % LANE_COLOURS.length] });
		}
		rows.splice(index, 0, {
			lane: target.lane, colour: indicator === 'incoming' ? REMOTE_REF_COLOUR : HEAD_REF_COLOUR,
			segments, width: target.width, hash: null, indicator,
		});
	};

	// 云端领先插在远端尖端之前；本地领先插在 HEAD 之前。
	// 远端尖端哈希在行数组中可能复现（同一提交在远端泳道再次出现），取最后一次出现
	// 才落在该尖端真正所在的那一段；从头找首次会让 incoming 指示行偏上。
	const lastRowOf = (hash: string): number => {
		for (let index = rows.length - 1; index >= 0; index--) {
			if (rows[index].hash === hash) return index;
		}
		return -1;
	};
	const remoteTip = refs.remoteTip ?? null;
	if (remoteTip !== null) insertIndicator(lastRowOf(remoteTip), 'incoming');
	const localTip = refs.localTip ?? null;
	if (localTip !== null) insertIndicator(rows.findIndex((row) => row.hash === localTip), 'outgoing');

	return {
		rows,
		laneCount,
		endCursor: { lanes: lanes.map((lane) => (lane === null ? null : { ...lane })), nextColour },
	};
}

/**
 * 泳道色池：5 色，按序轮转分配给不承载引用的分支。
 *
 * 取值对应 VS Code 提交图的 `--vscode-scmGraph-foreground1..5`。
 */
export const LANE_COLOURS = ['#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF'];

/** 本地 HEAD 引用色，与 `.ggg-ref-head` / `.ggg-ref-branch` 同源。 */
export const HEAD_REF_COLOUR = 'var(--dsw-alias-lane-0, #2f7bff)';

/** 远端引用色，与 `.ggg-ref-remote` 同源。 */
export const REMOTE_REF_COLOUR = 'var(--dsw-alias-lane-4, #8b5cf6)';

/**
 * 合并基引用色。
 *
 * 取值对应 VS Code 提交图的 `scmGraph.historyItemBaseRefColor` 默认值。
 */
export const BASE_REF_COLOUR = '#EA5C00';

/**
 * 取泳道颜色。
 *
 * @param colour - 颜色下标。
 * @returns CSS 颜色值。
 */
export function laneColour(colour: number): string {
	return LANE_COLOURS[((colour % LANE_COLOURS.length) + LANE_COLOURS.length) % LANE_COLOURS.length];
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
