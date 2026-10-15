/**
 * 泳道布局的纯函数测试：用 `node --test` 运行。
 *
 * 重点覆盖「贯穿线」——一条泳道在等待下游提交期间，每一行都必须有连线，
 * 否则分支线会在行与行之间断开（初版正是漏了这一点）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	laneCentre, laneColour, laneSpanWidth, layoutCommits, nodeOuterRadius, segmentGeometry,
	LANE_COLOURS, LANE_WIDTH, ROW_HEIGHT, ROW_OVERLAP, S_CURVE_RADIUS,
} from '../src/client/graph/lanes.ts';

/** 构造一个提交。 */
const commit = (hash, ...parents) => ({ hash, parents });

/** 取某一行里覆盖指定泳道的竖直贯穿线。 */
const throughAt = (layout, row, lane) => layout.rows[row].segments.find(
	(segment) => segment.lane === lane && segment.toLane === lane && segment.fromTop && segment.toBottom,
);

test('线性提交只占用一条泳道', () => {
	const layout = layoutCommits([commit('c', 'b'), commit('b', 'a'), commit('a')]);
	assert.equal(layout.laneCount, 1);
	assert.deepEqual(layout.rows.map((row) => row.lane), [0, 0, 0]);
	// 首行是分支的头：节点上方无线，只画下半段。
	const first = layout.rows[0].segments.find((segment) => segment.lane === 0);
	assert.ok(first !== undefined && !first.fromTop && first.toBottom, '首行只画下半段');
	// 中间行：入线与出线连成整行。
	assert.ok(throughAt(layout, 1, 0) !== undefined);
	// 末行是根提交：只画上半段。
	const last = layout.rows[2].segments.find((segment) => segment.lane === 0);
	assert.ok(last !== undefined && last.fromTop && !last.toBottom, '根提交只画上半段');
});

test('分支与合并各占泳道', () => {
	// m 合并 a 与 b；a、b 有共同父 r。
	const layout = layoutCommits([
		commit('m', 'a', 'b'),
		commit('a', 'r'),
		commit('b', 'r'),
		commit('r'),
	]);
	assert.ok(layout.laneCount >= 2, `期望至少两条泳道，实际 ${layout.laneCount}`);
	const fork = layout.rows[0].segments.find((segment) => segment.lane !== segment.toLane);
	assert.ok(fork !== undefined, '合并提交应有分叉线');
	assert.notEqual(fork.lane, fork.toLane);
});

test('等待下游提交的泳道在中间各行保持连线', () => {
	// a 的父提交 r 隔了两行才出现：中间行必须仍有 a 所在泳道的贯穿线。
	const layout = layoutCommits([
		commit('m', 'a', 'b'),
		commit('b', 'x'),
		commit('x', 'r'),
		commit('a', 'r'),
		commit('r'),
	]);
	const fork = layout.rows[0].segments.find((segment) => segment.lane !== segment.toLane);
	const lane = fork.toLane;
	for (const row of [1, 2]) {
		assert.ok(throughAt(layout, row, lane) !== undefined, `第 ${row} 行缺少泳道 ${lane} 的贯穿线`);
	}
});

test('每条向下延伸的线都在下一行被接续', () => {
	// 通用不变量：本行画到行底的线，其端点泳道在下一行必须已有线连上。
	const commits = [
		commit('h', 'g', 'f'),
		commit('g', 'e'),
		commit('f', 'e'),
		commit('e', 'd'),
		commit('d', 'c', 'b'),
		commit('c', 'a'),
		commit('b', 'a'),
		commit('a'),
	];
	const layout = layoutCommits(commits);
	for (let row = 0; row + 1 < commits.length; row++) {
		const current = layout.rows[row];
		for (const segment of current.segments.filter((item) => item.toBottom)) {
			const lane = segment.toLane;
			const next = layout.rows[row + 1];
			const continues = next.segments.some((item) => item.fromTop && item.lane === lane) || next.lane === lane;
			assert.ok(continues, `第 ${row} 行泳道 ${lane} 向下延伸，但第 ${row + 1} 行没有接续`);
		}
	}
});

test('每个提交都得到确定的行与泳道', () => {
	const commits = [commit('d', 'c'), commit('c', 'b'), commit('b', 'a'), commit('a')];
	const layout = layoutCommits(commits);
	assert.equal(layout.rows.length, commits.length);
	for (const row of layout.rows) {
		assert.ok(Number.isInteger(row.lane) && row.lane >= 0);
		assert.ok(row.width >= 1);
	}
});

test('空序列不抛错', () => {
	const layout = layoutCommits([]);
	assert.deepEqual(layout.rows, []);
	assert.equal(layout.laneCount, 0);
});

test('父提交未加载时保留泳道并画到行底', () => {
	// 分页只给出窗口内的提交：'missing' 还没加载，泳道不能释放。
	const layout = layoutCommits([commit('b', 'missing'), commit('a')]);
	assert.equal(layout.laneCount, 2, 'b 的父提交仍占一条泳道，a 另取一条');
	assert.ok(layout.rows[0].segments.every((segment) => segment.toBottom), 'b 的线画到行底');
});

test('分页外的第二个父提交仍占一条泳道', () => {
	const layout = layoutCommits([commit('m', 'a', 'later'), commit('a', 'later')]);
	assert.equal(layout.laneCount, 2);
	assert.ok(layout.rows[0].segments.some((segment) => segment.lane !== segment.toLane), '合并的分叉线照画');
});

test('压实后行间的泳道与颜色仍然连续', () => {
	// 压实会左移泳道：行底的下标必须与下一行行顶的下标、颜色一致，
	// 否则线会错位或变色。这里让三条分支并存后依次汇入，触发多次压实。
	const commits = [
		commit('m', 'a', 'b', 'd'),
		commit('a', 'r'),
		commit('b', 'r'),
		commit('r'),
		commit('d', 'r'),
	];
	const layout = layoutCommits(commits);
	for (let row = 0; row + 1 < commits.length; row++) {
		for (const segment of layout.rows[row].segments.filter((item) => item.toBottom)) {
			const next = layout.rows[row + 1];
			const continues = next.segments.find((item) => item.fromTop && item.lane === segment.toLane)
				?? (next.lane === segment.toLane ? { colour: next.colour } : undefined);
			assert.ok(continues !== undefined, `第 ${row} 行泳道 ${segment.toLane} 在下一行没有接续`);
			assert.equal(continues.colour, segment.colour, `第 ${row} 行泳道 ${segment.toLane} 的颜色在行间断开`);
		}
	}
});

test('泳道位置保持稳定不左移', () => {
	// 泳道一次分配后原位延续：中间泳道消亡时，其右侧泳道不左移填补，
	// 因此不产生 S 形平移段。
	const layout = layoutCommits([
		commit('m', 'a', 'b', 'd'),
		commit('a', 'r'),
		commit('b', 'r'),
		commit('r'),
		commit('d', 'r'),
	]);
	const shifted = layout.rows.flatMap((row) => row.segments).filter(
		(segment) => segment.fromTop && segment.toBottom && segment.lane !== segment.toLane,
	);
	assert.equal(shifted.length, 0, '泳道不应随压实平移');
	// 贯穿段始终留在原泳道。
	for (const row of layout.rows) {
		for (const segment of row.segments) {
			if (segment.fromTop && segment.toBottom) assert.equal(segment.lane, segment.toLane, '贯穿段不改变泳道');
		}
	}
});

test('分页加载后已加载部分的行不变', () => {
	// 只加载前 3 个提交时，前 3 行的泳道、颜色与线段必须与加载全部时相同，
	// 否则「加载更多」会让已在屏幕上的部分跳变。
	const all = [commit('h', 'g', 'f'), commit('g', 'e'), commit('f', 'e'), commit('e', 'd'), commit('d')];
	const partial = layoutCommits(all.slice(0, 3));
	const full = layoutCommits(all);
	for (let row = 0; row < 3; row++) {
		assert.equal(partial.rows[row].lane, full.rows[row].lane, `第 ${row} 行泳道不一致`);
		assert.equal(partial.rows[row].colour, full.rows[row].colour, `第 ${row} 行颜色不一致`);
		assert.deepEqual(
			partial.rows[row].segments.map((segment) => [segment.lane, segment.toLane, segment.fromTop, segment.toBottom]),
			full.rows[row].segments.map((segment) => [segment.lane, segment.toLane, segment.fromTop, segment.toBottom]),
			`第 ${row} 行线段不一致`,
		);
	}
});

test('没有父提交时线到节点为止', () => {
	const layout = layoutCommits([commit('only')]);
	assert.equal(layout.rows[0].segments.length, 0, '孤立提交不画任何线');
});

test('缺 parents 字段不抛错', () => {
	const layout = layoutCommits([{ hash: 'x' }, { hash: 'y' }]);
	assert.equal(layout.rows.length, 2);
});

test('颜色按泳道循环取用', () => {
	assert.equal(laneColour(0), LANE_COLOURS[0]);
	assert.equal(laneColour(LANE_COLOURS.length), LANE_COLOURS[0]);
	assert.equal(laneColour(LANE_COLOURS.length + 3), LANE_COLOURS[3]);
});

test('几何常量与样式一致', () => {
	assert.equal(typeof LANE_WIDTH, 'number');
	assert.equal(typeof ROW_HEIGHT, 'number');
	assert.ok(LANE_WIDTH > 0 && ROW_HEIGHT > 0);
});

test('整行贯穿线从行顶画到行底并越界重叠', () => {
	const geometry = segmentGeometry({ lane: 0, toLane: 0, fromTop: true, toBottom: true });
	assert.equal(geometry.kind, 'line');
	// 两端各越界 ROW_OVERLAP：与相邻行的线重叠，消除亚像素接缝。
	assert.equal(geometry.y1, -ROW_OVERLAP);
	assert.equal(geometry.y2, ROW_HEIGHT + ROW_OVERLAP);
});

test('入线与出线在节点处断开', () => {
	const inbound = segmentGeometry({ lane: 0, toLane: 0, fromTop: true, toBottom: false });
	assert.equal(inbound.y1, -ROW_OVERLAP);
	assert.equal(inbound.y2, ROW_HEIGHT / 2);
	const outbound = segmentGeometry({ lane: 0, toLane: 0, fromTop: false, toBottom: true });
	assert.equal(outbound.y1, ROW_HEIGHT / 2);
	assert.equal(outbound.y2, ROW_HEIGHT + ROW_OVERLAP);
});

test('曲线入线从行顶起画', () => {
	// 分支汇入本行节点：上半行必须有线，否则与上一行断开（初版正是从这里断的）。
	const geometry = segmentGeometry({ lane: 1, toLane: 0, fromTop: true, toBottom: false });
	assert.equal(geometry.kind, 'path');
	assert.match(geometry.d, new RegExp(`^M [\\d.]+ ${-ROW_OVERLAP} V 0 `), '起点应越界重叠');
	assert.ok(geometry.d.includes(`${ROW_HEIGHT / 2}`), '曲线终点应落在节点高度');
});

test('曲线分叉从节点画到行底', () => {
	const geometry = segmentGeometry({ lane: 0, toLane: 1, fromTop: false, toBottom: true });
	assert.equal(geometry.kind, 'path');
	assert.match(geometry.d, new RegExp(`^M [\\d.]+ ${ROW_HEIGHT / 2} `));
	assert.ok(geometry.d.trim().endsWith(`V ${ROW_HEIGHT + ROW_OVERLAP}`), '终点应越界重叠');
});

test('末行的线画到行底以便下一段接续', () => {
	// 末行的父提交可能还在下一段分页：末行不截断，否则分页边界处断线。
	const layout = layoutCommits([commit('b', 'outside')]);
	const outbound = layout.rows[0].segments.find((segment) => !segment.fromTop && segment.toBottom);
	assert.ok(outbound !== undefined, '末行仍有向下的线');
	const geometry = segmentGeometry(outbound);
	assert.equal(geometry.kind, 'line');
	assert.equal(geometry.y2, ROW_HEIGHT + ROW_OVERLAP);
});

test('零长度线段不产生元素', () => {
	assert.equal(segmentGeometry({ lane: 0, toLane: 0, fromTop: false, toBottom: false }), null);
});

test('泳道中心线按泳道宽度排布', () => {
	assert.equal(laneCentre(0), LANE_WIDTH);
	assert.equal(laneCentre(3), 4 * LANE_WIDTH);
	// 图形列宽 = LANE_WIDTH * (泳道数 + 1)：两侧各留半个泳道。
	assert.equal(laneSpanWidth(1), 2 * LANE_WIDTH);
	assert.equal(laneSpanWidth(3), 4 * LANE_WIDTH);
});

test('入线与出线停在节点外沿', () => {
	const node = { x: laneCentre(0), radius: nodeOuterRadius('plain') };
	const inbound = segmentGeometry({ lane: 0, toLane: 0, fromTop: true, toBottom: false }, node);
	assert.equal(inbound.kind, 'line');
	assert.equal(inbound.y1, -ROW_OVERLAP);
	assert.equal(inbound.y2, ROW_HEIGHT / 2 - node.radius);
	const outbound = segmentGeometry({ lane: 0, toLane: 0, fromTop: false, toBottom: true }, node);
	assert.equal(outbound.y1, ROW_HEIGHT / 2 + node.radius);
	assert.equal(outbound.y2, ROW_HEIGHT + ROW_OVERLAP);
});

test('贯穿节点的整行线拆成上下两段', () => {
	const node = { x: laneCentre(0), radius: nodeOuterRadius('merge') };
	const geometry = segmentGeometry({ lane: 0, toLane: 0, fromTop: true, toBottom: true }, node);
	assert.equal(geometry.kind, 'gap');
	assert.equal(geometry.upper.y1, -ROW_OVERLAP);
	assert.equal(geometry.upper.y2, ROW_HEIGHT / 2 - node.radius);
	assert.equal(geometry.lower.y1, ROW_HEIGHT / 2 + node.radius);
	assert.equal(geometry.lower.y2, ROW_HEIGHT + ROW_OVERLAP);
});

test('别条泳道的贯穿线不受节点影响', () => {
	const node = { x: laneCentre(0), radius: nodeOuterRadius('head') };
	const geometry = segmentGeometry({ lane: 1, toLane: 1, fromTop: true, toBottom: true }, node);
	assert.equal(geometry.kind, 'line');
	assert.equal(geometry.y1, -ROW_OVERLAP);
	assert.equal(geometry.y2, ROW_HEIGHT + ROW_OVERLAP);
});

/** 取路径描述里的第一对坐标（M 的落点）。 */
const pathStart = (d) => {
	const numbers = d.match(/-?[\d.]+/g).map(Number);
	return { x: numbers[0], y: numbers[1] };
};

/**
 * 取路径描述里的最后一个曲线端点（A / H / V 之前的落点），跳过行底越界重叠段。
 *
 * @param d - SVG 路径描述。
 * @returns 端点坐标。
 */
const pathEnd = (d) => {
	// 末尾形如 `... V <越界值>` 时，真正的端点是它之前的那一对坐标。
	const trimmed = d.trim().replace(/ V -?[\d.]+$/, '');
	const numbers = trimmed.match(/-?[\d.]+/g).map(Number);
	return { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] };
};

test('曲线端点停在节点外沿', () => {
	const node = { x: laneCentre(0), radius: nodeOuterRadius('plain') };
	// 相邻泳道汇入：圆弧终点即节点圆心，收束点应落在节点外沿上。
	const inbound = segmentGeometry({ lane: 1, toLane: 0, fromTop: true, toBottom: false }, node);
	assert.equal(inbound.kind, 'path');
	const inboundEnd = pathEnd(inbound.d);
	assert.ok(Math.abs(Math.hypot(inboundEnd.x - node.x, inboundEnd.y - ROW_HEIGHT / 2) - node.radius) < 1e-9,
		`入线终点应在节点外沿，实际 ${JSON.stringify(inboundEnd)}`);

	const fork = segmentGeometry({ lane: 0, toLane: 1, fromTop: false, toBottom: true }, node);
	assert.equal(fork.kind, 'path');
	const forkStart = pathStart(fork.d);
	assert.ok(Math.abs(Math.hypot(forkStart.x - node.x, forkStart.y - ROW_HEIGHT / 2) - node.radius) < 1e-9,
		`分叉起点应在节点外沿，实际 ${JSON.stringify(forkStart)}`);
	assert.ok(fork.d.trim().endsWith(`V ${ROW_HEIGHT + ROW_OVERLAP}`), '分叉曲线应越界重叠到行底之外');
});

test('隔一条泳道的汇入与分叉走水平段', () => {
	// 目标与来源相隔两条泳道时，圆弧半径 11 只吃掉一条泳道，其余靠水平段补齐。
	const inbound = segmentGeometry({ lane: 2, toLane: 0, fromTop: true, toBottom: false });
	assert.equal(inbound.kind, 'path');
	assert.match(inbound.d, /A 11 11 0 0 1 22 11 H 11$/, '圆弧落在相邻泳道、行中线，随后水平接入');

	const fork = segmentGeometry({ lane: 0, toLane: 2, fromTop: false, toBottom: true });
	assert.equal(fork.kind, 'path');
	assert.match(fork.d, new RegExp(`^M 11 11 H 22 A 11 11 0 0 1 33 22 V ${ROW_HEIGHT + ROW_OVERLAP}$`),
		'水平引出后圆弧落到行底，再越界重叠');
});

test('泳道平移走 S 形曲线', () => {
	const geometry = segmentGeometry({ lane: 2, toLane: 0, fromTop: true, toBottom: true });
	assert.equal(geometry.kind, 'path');
	// 两段半径 S_CURVE_RADIUS 的四分之一圆 + 中间水平段，两端越界重叠消除接缝。
	const bend = ROW_HEIGHT / 2 - S_CURVE_RADIUS;
	assert.match(
		geometry.d,
		new RegExp(`^M ${laneCentre(2)} ${-ROW_OVERLAP} V ${bend} A ${S_CURVE_RADIUS} ${S_CURVE_RADIUS} 0 0 1 ${laneCentre(2) - S_CURVE_RADIUS} ${ROW_HEIGHT / 2}`
			+ ` H ${laneCentre(0) + S_CURVE_RADIUS} A ${S_CURVE_RADIUS} ${S_CURVE_RADIUS} 0 0 0 ${laneCentre(0)} ${ROW_HEIGHT / 2 + S_CURVE_RADIUS} V ${ROW_HEIGHT + ROW_OVERLAP}$`),
		`实际的 S 曲线：${geometry.d}`,
	);
});

test('曲线一律不含贝塞尔命令', () => {
	// 曲线由 M / A / H / V 组成，与参考实现的圆弧风格一致。
	for (const segment of [
		{ lane: 1, toLane: 0, fromTop: true, toBottom: false },
		{ lane: 0, toLane: 1, fromTop: false, toBottom: true },
		{ lane: 2, toLane: 0, fromTop: true, toBottom: true },
		{ lane: 0, toLane: 3, fromTop: false, toBottom: true },
	]) {
		const geometry = segmentGeometry(segment);
		assert.equal(geometry.kind, 'path');
		assert.ok(!/[CQ]/.test(geometry.d), `路径不应含贝塞尔命令：${geometry.d}`);
	}
});

test('节点外沿半径按种类递增', () => {
	assert.ok(nodeOuterRadius('head') > nodeOuterRadius('merge'), '当前分支节点最大');
	assert.ok(nodeOuterRadius('merge') > nodeOuterRadius('plain'), '合并节点大于普通节点');
});

