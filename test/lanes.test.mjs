/**
 * 泳道布局的纯函数测试：用 `node --test` 运行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { laneColour, layoutCommits, LANE_COLOURS, LANE_WIDTH, ROW_HEIGHT } from '../src/client/lanes.js';

/** 构造一个提交。 */
const commit = (hash, ...parents) => ({ hash, parents });

test('线性提交只占用一条泳道', () => {
	const layout = layoutCommits([commit('c', 'b'), commit('b', 'a'), commit('a')]);
	assert.equal(layout.laneCount, 1);
	assert.deepEqual(layout.rows.map((row) => row.lane), [0, 0, 0]);
	assert.ok(layout.rows[0].segments[0].straight);
	assert.equal(layout.rows[2].segments.length, 0, '没有父提交时不画连线');
});

test('分支与合并各占泳道', () => {
	// m 合并了 a 与 b；a、b 有共同父 r。
	const layout = layoutCommits([
		commit('m', 'a', 'b'),
		commit('a', 'r'),
		commit('b', 'r'),
		commit('r'),
	]);
	assert.ok(layout.laneCount >= 2, `期望至少两条泳道，实际 ${layout.laneCount}`);
	// 第一行的第二个父提交指向另一条泳道。
	const fork = layout.rows[0].segments.find((segment) => !segment.straight);
	assert.ok(fork !== undefined, '合并提交应当有一条汇入线');
	assert.notEqual(fork.from.lane, fork.to.lane);
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
	assert.equal(layout.rows[0].segments.length, 0, '未知父提交不画线');
	assert.equal(layout.laneCount, 1);
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
