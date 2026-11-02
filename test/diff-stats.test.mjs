/**
 * 差异行数统计的测试：从 hunk 行前缀数出新增与删除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffStats } from '../src/client/diff/diff-stats.ts';

test('混合改动分别计入新增与删除', () => {
	const stats = diffStats([{ lines: [' 上下文', '-旧行', '+新行', ' 尾行'] }]);
	assert.deepEqual(stats, { added: 1, deleted: 1 });
});

test('纯新增没有删除行', () => {
	const stats = diffStats([{ lines: ['+a', '+b', '+c'] }]);
	assert.deepEqual(stats, { added: 3, deleted: 0 });
});

test('纯删除没有新增行', () => {
	const stats = diffStats([{ lines: ['-a', '-b'] }]);
	assert.deepEqual(stats, { added: 0, deleted: 2 });
});

test('多 hunk 累加', () => {
	const stats = diffStats([
		{ lines: ['+a', '-b'] },
		{ lines: ['+c', '-d', '-e'] },
	]);
	assert.deepEqual(stats, { added: 2, deleted: 3 });
});

test('空 hunk 列表计为零', () => {
	assert.deepEqual(diffStats([]), { added: 0, deleted: 0 });
});

test('只有上下文行时两项都为零', () => {
	assert.deepEqual(diffStats([{ lines: [' a', ' b'] }]), { added: 0, deleted: 0 });
});

test('hunk 内的空行不计数', () => {
	assert.deepEqual(diffStats([{ lines: ['+a', ' ', '-b'] }]), { added: 1, deleted: 1 });
});
