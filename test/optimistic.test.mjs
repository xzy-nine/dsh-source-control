/**
 * 乐观更新的测试：按 git 索引/工作区语义推算条目，以及路径匹配与变更签名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	commitEntries, discardEntries, entriesSignature, stageEntries, unstageEntries,
} from '../src/client/panel/optimistic.ts';

/** 造一个条目。 */
const entry = (path, index, worktree, origPath = null) => ({ path, origPath, index, worktree });

/** 取「路径 -> 状态码」映射。 */
const codes = (entries) => Object.fromEntries(entries.map((item) => [item.path, `${item.index}${item.worktree}`]));

test('暂存未跟踪文件变为新增', () => {
	const result = stageEntries([entry('a.txt', '?', '?')], ['a.txt']);
	assert.deepEqual(codes(result), { 'a.txt': 'A ' });
});

test('暂存仅工作区改动：工作区状态移入索引列', () => {
	const result = stageEntries([entry('a.txt', ' ', 'M')], ['a.txt']);
	assert.deepEqual(codes(result), { 'a.txt': 'M ' });
});

test('暂存同时有索引与工作区改动：取工作区状态', () => {
	const result = stageEntries([entry('a.txt', 'M', 'M')], ['a.txt']);
	assert.deepEqual(codes(result), { 'a.txt': 'M ' });
});

test('暂存不命中时原样保留', () => {
	const before = [entry('a.txt', ' ', 'M')];
	const result = stageEntries(before, ['b.txt']);
	assert.deepEqual(result, before);
});

test('取消暂存新增退回未跟踪', () => {
	const result = unstageEntries([entry('a.txt', 'A', ' ')], ['a.txt']);
	assert.deepEqual(codes(result), { 'a.txt': '??' });
});

test('取消暂存普通改动：索引状态移回工作区列', () => {
	const result = unstageEntries([entry('a.txt', 'M', ' ')], ['a.txt']);
	assert.deepEqual(codes(result), { 'a.txt': ' M' });
});

test('丢弃未跟踪文件：整条移除', () => {
	const result = discardEntries([entry('a.txt', '?', '?')], ['a.txt']);
	assert.deepEqual(result, []);
});

test('丢弃已暂存并带工作区改动：保留索引部分', () => {
	const result = discardEntries([entry('a.txt', 'M', 'M')], ['a.txt']);
	assert.deepEqual(codes(result), { 'a.txt': 'M ' });
});

test('丢弃仅工作区改动：整条移除', () => {
	const result = discardEntries([entry('a.txt', ' ', 'M')], ['a.txt']);
	assert.deepEqual(result, []);
});

test('丢弃只作用于命中路径', () => {
	const result = discardEntries([entry('a.txt', ' ', 'M'), entry('b.txt', ' ', 'M')], ['a.txt']);
	assert.deepEqual(codes(result), { 'b.txt': ' M' });
});

test('提交后已暂存条目清除，带工作区改动的退回未暂存', () => {
	const result = commitEntries([entry('a.txt', 'A', ' '), entry('b.txt', 'M', 'M'), entry('c.txt', ' ', 'M')]);
	assert.deepEqual(codes(result), { 'b.txt': ' M', 'c.txt': ' M' });
});

test('重命名记录按原路径暂存同样命中', () => {
	const renamed = entry('new.txt', 'R', ' ', 'old.txt');
	const result = stageEntries([renamed], ['old.txt']);
	assert.deepEqual(codes(result), { 'new.txt': 'R ' });
});

test('重命名记录按原路径丢弃同样命中', () => {
	const renamed = entry('new.txt', 'R', 'M', 'old.txt');
	const result = discardEntries([renamed], ['old.txt']);
	assert.deepEqual(codes(result), { 'new.txt': 'R ' });
});

test('重命名记录按当前路径同样命中', () => {
	const renamed = entry('new.txt', 'R', ' ', 'old.txt');
	const result = unstageEntries([renamed], ['new.txt']);
	assert.deepEqual(codes(result), { 'new.txt': ' R' });
});

test('推算出的新条目保留原路径', () => {
	const renamed = entry('new.txt', 'R', 'M', 'old.txt');
	for (const result of [
		stageEntries([renamed], ['old.txt']),
		unstageEntries([renamed], ['old.txt']),
		discardEntries([renamed], ['old.txt']),
		commitEntries([renamed]),
	]) {
		assert.equal(result[0].origPath, 'old.txt');
	}
});

test('签名对相同输入稳定', () => {
	const entries = [entry('a.txt', ' ', 'M'), entry('b.txt', '?', '?')];
	assert.equal(entriesSignature(entries), entriesSignature([...entries]));
});

test('签名对顺序敏感', () => {
	const first = entry('a.txt', ' ', 'M');
	const second = entry('b.txt', '?', '?');
	assert.notEqual(entriesSignature([first, second]), entriesSignature([second, first]));
});

test('签名对状态变化敏感', () => {
	assert.notEqual(
		entriesSignature([entry('a.txt', ' ', 'M')]),
		entriesSignature([entry('a.txt', 'M', ' ')]),
	);
});

test('空列表签名为空文本', () => {
	assert.equal(entriesSignature([]), '');
});
