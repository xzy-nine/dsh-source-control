/**
 * 泳道布局的纯函数测试：用 `node --test` 运行。
 *
 * 重点覆盖「贯穿线」——一条泳道在等待下游提交期间，每一行都必须有连线，
 * 否则分支线会在行与行之间断开（初版正是漏了这一点）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { laneCentre, laneColour, layoutCommits, nodeOuterRadius, segmentGeometry, LANE_COLOURS, LANE_WIDTH, ROW_HEIGHT } from '../src/client/lanes.js';

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
	const fork = layout.rows[0].segments.find((segment) => segment.curved);
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
	const fork = layout.rows[0].segments.find((segment) => segment.curved);
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

test('父提交不在序列中时释放泳道', () => {
	const layout = layoutCommits([commit('b', 'missing'), commit('a')]);
	assert.equal(layout.laneCount, 1);
	assert.ok(layout.rows[0].segments.every((segment) => Number.isInteger(segment.lane)));
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

test('整行贯穿线从行顶画到行底', () => {
	const geometry = segmentGeometry({ lane: 0, toLane: 0, fromTop: true, toBottom: true, curved: false });
	assert.equal(geometry.kind, 'line');
	assert.equal(geometry.y1, 0);
	assert.equal(geometry.y2, ROW_HEIGHT);
});

test('入线与出线在节点处断开', () => {
	const inbound = segmentGeometry({ lane: 0, toLane: 0, fromTop: true, toBottom: false, curved: false });
	assert.equal(inbound.y1, 0);
	assert.equal(inbound.y2, ROW_HEIGHT / 2);
	const outbound = segmentGeometry({ lane: 0, toLane: 0, fromTop: false, toBottom: true, curved: false });
	assert.equal(outbound.y1, ROW_HEIGHT / 2);
	assert.equal(outbound.y2, ROW_HEIGHT);
});

test('曲线入线从行顶起画', () => {
	// 分支汇入本行节点：上半行必须有线，否则与上一行断开（初版正是从这里断的）。
	const geometry = segmentGeometry({ lane: 1, toLane: 0, fromTop: true, toBottom: false, curved: true });
	assert.equal(geometry.kind, 'path');
	assert.match(geometry.d, /^M [\d.]+ 0 /);
	assert.ok(geometry.d.includes(`${ROW_HEIGHT / 2}`), '曲线终点应落在节点高度');
});

test('曲线分叉从节点画到行底', () => {
	const geometry = segmentGeometry({ lane: 0, toLane: 1, fromTop: false, toBottom: true, curved: true });
	assert.equal(geometry.kind, 'path');
	assert.match(geometry.d, new RegExp(`^M [\\d.]+ ${ROW_HEIGHT / 2} `));
	assert.ok(geometry.d.trim().endsWith(String(ROW_HEIGHT)));
});

test('末行的出线不再向下延伸', () => {
	// 末行没有下一行可接，纯出线（起点=终点=节点高度）视为零长度，不产生元素。
	assert.equal(segmentGeometry({ lane: 0, toLane: 0, fromTop: false, toBottom: true, curved: false }, true), null);
	// 入线仍要画到节点，末行的根提交因此有上半段。
	const inbound = segmentGeometry({ lane: 0, toLane: 0, fromTop: true, toBottom: false, curved: false }, true);
	assert.equal(inbound.y1, 0);
	assert.equal(inbound.y2, ROW_HEIGHT / 2);
});

test('横移段拆成两段直线', () => {
	const geometry = segmentGeometry({ lane: 0, toLane: 1, fromTop: false, toBottom: true, curved: false });
	assert.equal(geometry.kind, 'bend');
	assert.equal(geometry.horizontal.y2, ROW_HEIGHT / 2);
	assert.equal(geometry.vertical.y1, ROW_HEIGHT / 2);
});

test('零长度线段不产生元素', () => {
	assert.equal(segmentGeometry({ lane: 0, toLane: 0, fromTop: false, toBottom: false, curved: false }), null);
});

test('泳道中心线按泳道宽度排布', () => {
	assert.equal(laneCentre(0), LANE_WIDTH / 2);
	assert.equal(laneCentre(3), 3 * LANE_WIDTH + LANE_WIDTH / 2);
});

test('入线与出线停在节点外沿', () => {
	const node = { x: laneCentre(0), radius: nodeOuterRadius('plain') };
	const inbound = segmentGeometry({ lane: 0, toLane: 0, fromTop: true, toBottom: false, curved: false }, false, node);
	assert.equal(inbound.kind, 'line');
	assert.equal(inbound.y1, 0);
	assert.equal(inbound.y2, ROW_HEIGHT / 2 - node.radius);
	const outbound = segmentGeometry({ lane: 0, toLane: 0, fromTop: false, toBottom: true, curved: false }, false, node);
	assert.equal(outbound.y1, ROW_HEIGHT / 2 + node.radius);
	assert.equal(outbound.y2, ROW_HEIGHT);
});

test('贯穿节点的整行线拆成上下两段', () => {
	const node = { x: laneCentre(0), radius: nodeOuterRadius('merge') };
	const geometry = segmentGeometry({ lane: 0, toLane: 0, fromTop: true, toBottom: true, curved: false }, false, node);
	assert.equal(geometry.kind, 'gap');
	assert.equal(geometry.upper.y1, 0);
	assert.equal(geometry.upper.y2, ROW_HEIGHT / 2 - node.radius);
	assert.equal(geometry.lower.y1, ROW_HEIGHT / 2 + node.radius);
	assert.equal(geometry.lower.y2, ROW_HEIGHT);
});

test('别条泳道的贯穿线不受节点影响', () => {
	const node = { x: laneCentre(0), radius: nodeOuterRadius('head') };
	const geometry = segmentGeometry({ lane: 1, toLane: 1, fromTop: true, toBottom: true, curved: false }, false, node);
	assert.equal(geometry.kind, 'line');
	assert.equal(geometry.y1, 0);
	assert.equal(geometry.y2, ROW_HEIGHT);
});

test('曲线端点停在节点外沿', () => {
	const node = { x: laneCentre(0), radius: nodeOuterRadius('plain') };
	const inbound = segmentGeometry({ lane: 1, toLane: 0, fromTop: true, toBottom: false, curved: true }, false, node);
	assert.equal(inbound.kind, 'path');
	assert.match(inbound.d, new RegExp(`, ${laneCentre(0)} ${ROW_HEIGHT / 2 - node.radius}$`));
	const fork = segmentGeometry({ lane: 0, toLane: 1, fromTop: false, toBottom: true, curved: true }, false, node);
	assert.match(fork.d, new RegExp(`^M ${laneCentre(0)} ${ROW_HEIGHT / 2 + node.radius} `));
});

test('节点外沿半径按种类递增', () => {
	assert.ok(nodeOuterRadius('head') > nodeOuterRadius('merge'), '当前分支节点最大');
	assert.ok(nodeOuterRadius('merge') > nodeOuterRadius('plain'), '合并节点大于普通节点');
});

