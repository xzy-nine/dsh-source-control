/**
 * 窗口化渲染区间计算的测试：用 `node --test` 运行。
 *
 * 覆盖空列表、越界位置、视口高度为 0、展开详情造成的非均匀行高与 overscan 边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { topIndexOf, visibleRange } from '../src/client/graph/window-range.ts';

/** 按等高行构造偏移表。 */
const uniform = (rowCount, height = 20) => {
	const offsets = new Float64Array(rowCount + 1);
	for (let index = 0; index < rowCount; index += 1) offsets[index + 1] = offsets[index] + height;
	return offsets;
};

test('空列表的顶部行与区间都收敛到 0', () => {
	assert.equal(topIndexOf(new Float64Array(1), 0, 0), 0);
	assert.equal(topIndexOf(new Float64Array(1), 500, 0), 0);
	assert.deepEqual(visibleRange(new Float64Array(1), 0, 0, 12, 0), { first: 0, last: 0 });
});

test('顶部行是包含滚动位置的那一行', () => {
	const offsets = uniform(10);
	assert.equal(topIndexOf(offsets, 0, 10), 0);
	assert.equal(topIndexOf(offsets, 19, 10), 0, '行内位置仍属该行');
	assert.equal(topIndexOf(offsets, 20, 10), 1, '行边界属于下一行');
	assert.equal(topIndexOf(offsets, 95, 10), 4);
});

test('顶部行在负位置与超出内容时收拢', () => {
	const offsets = uniform(5);
	assert.equal(topIndexOf(offsets, -30, 5), 0);
	assert.equal(topIndexOf(offsets, 10000, 5), 4);
});

test('区间上下各留 overscan 行', () => {
	const offsets = uniform(100);
	const range = visibleRange(offsets, 50, 200, 12, 100);
	// 顶部行 50，视口 200 覆盖 10 行（50..59），上下各 12 行。
	assert.deepEqual(range, { first: 38, last: 72 });
});

test('顶部与底部越界时区间收拢到列表范围内', () => {
	const offsets = uniform(20);
	assert.deepEqual(visibleRange(offsets, 0, 100, 5, 20), { first: 0, last: 10 });
	assert.deepEqual(visibleRange(offsets, 19, 100, 5, 20), { first: 14, last: 20 });
});

test('视口高度为 0 时上下各取 overscan 行', () => {
	const offsets = uniform(50);
	assert.deepEqual(visibleRange(offsets, 20, 0, 3, 50), { first: 17, last: 23 });
});

test('展开详情的行高计入区间', () => {
	// 前 3 行等高 20，第 3 行（下标 3）展开后高 100，其后各行顺延。
	const offsets = Float64Array.from([0, 20, 40, 60, 160, 180, 200, 220, 240, 260, 280]);
	// 滚动到展开块底部（160）时顶部行是下标 4，视口 40 覆盖 2 行。
	assert.equal(topIndexOf(offsets, 160, 10), 4);
	assert.deepEqual(visibleRange(offsets, 4, 40, 1, 10), { first: 3, last: 7 });
	// 滚动位置落在展开块内部时顶部行仍是展开行。
	assert.equal(topIndexOf(offsets, 120, 10), 3);
});

test('区间仅一屏时首尾都覆盖全部行', () => {
	const offsets = uniform(4);
	assert.deepEqual(visibleRange(offsets, 0, 1000, 12, 4), { first: 0, last: 4 });
});
