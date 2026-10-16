/**
 * 提交图窗口缓存：容量淘汰、键区分、路径归一化、按仓库删除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommitGraphCache } from '../src/client/graph/cache.ts';

/** 一组默认取数参数。 */
const baseOptions = {
	maxCommits: 100,
	skip: 0,
	ordering: 'date',
	showStashes: false,
	showTags: false,
	showRemoteBranches: false,
	onlyFollowFirstParent: false,
	includeCommitsMentionedByReflogs: false,
};

test('默认容量 32，超容量淘汰最久未用的一项', () => {
	const cache = createCommitGraphCache();
	for (let i = 0; i < 32; i++) cache.set('k' + i, i);
	assert.equal(cache.size, 32);
	cache.set('k32', 32);
	assert.equal(cache.size, 32);
	assert.equal(cache.get('k0'), undefined, '最先写入的一项被淘汰');
	assert.equal(cache.get('k1'), 1);
});

test('命中 get 刷新最近使用，淘汰改为最久未访问的一项', () => {
	const cache = createCommitGraphCache(2);
	cache.set('a', 1);
	cache.set('b', 2);
	assert.equal(cache.get('a'), 1);
	cache.set('c', 3);
	assert.equal(cache.get('a'), 1, '刚访问过的 a 保留');
	assert.equal(cache.get('b'), undefined, '最久未访问的 b 被淘汰');
	assert.equal(cache.get('c'), 3);
});

test('同键覆盖不增加容量占用', () => {
	const cache = createCommitGraphCache(1);
	cache.set('a', 1);
	cache.set('a', 2);
	assert.equal(cache.size, 1);
	assert.equal(cache.get('a'), 2);
});

test('容量下限为 1', () => {
	for (const capacity of [0, -5, 0.4]) {
		const cache = createCommitGraphCache(capacity);
		cache.set('a', 1);
		cache.set('b', 2);
		assert.equal(cache.size, 1, '容量 ' + capacity + ' 至少保留一项');
		assert.equal(cache.get('b'), 2);
	}
});

test('get 未命中返回 undefined', () => {
	const cache = createCommitGraphCache();
	assert.equal(cache.get('missing'), undefined);
});

test('每个参数变化都得到不同的键', () => {
	const cache = createCommitGraphCache();
	const repo = '/repo/a';
	const reference = cache.keyOf(repo, baseOptions);
	const variants = {
		maxCommits: { ...baseOptions, maxCommits: 101 },
		skip: { ...baseOptions, skip: 1 },
		ordering: { ...baseOptions, ordering: 'topo' },
		showStashes: { ...baseOptions, showStashes: true },
		showTags: { ...baseOptions, showTags: true },
		showRemoteBranches: { ...baseOptions, showRemoteBranches: true },
		onlyFollowFirstParent: { ...baseOptions, onlyFollowFirstParent: true },
		includeCommitsMentionedByReflogs: { ...baseOptions, includeCommitsMentionedByReflogs: true },
	};
	for (const [name, options] of Object.entries(variants)) {
		assert.notEqual(cache.keyOf(repo, options), reference, name + ' 应改变键');
	}
	const keys = Object.values(variants).map((options) => cache.keyOf(repo, options));
	assert.equal(new Set(keys).size, keys.length, '各参数组合互不碰撞');
});

test('不同仓库得到不同键', () => {
	const cache = createCommitGraphCache();
	assert.notEqual(cache.keyOf('/repo/a', baseOptions), cache.keyOf('/repo/b', baseOptions));
});

test('路径归一化：尾斜杠与大小写等价', () => {
	const cache = createCommitGraphCache();
	const reference = cache.keyOf('/repo/a', baseOptions);
	assert.equal(cache.keyOf('/repo/a/', baseOptions), reference);
	assert.equal(cache.keyOf('/repo/a///', baseOptions), reference);
	assert.equal(cache.keyOf('C:\\Repo\\A\\', baseOptions), cache.keyOf('c:\\repo\\a', baseOptions));
});

test('dropRepo 只删目标仓库，路径写法不同也命中', () => {
	const cache = createCommitGraphCache();
	const a = cache.keyOf('/repo/a', baseOptions);
	const aSkip = cache.keyOf('/repo/a/', { ...baseOptions, skip: 100 });
	const b = cache.keyOf('/repo/b', baseOptions);
	cache.set(a, 1);
	cache.set(aSkip, 2);
	cache.set(b, 3);
	cache.dropRepo('/repo/a');
	assert.equal(cache.get(a), undefined);
	assert.equal(cache.get(aSkip), undefined);
	assert.equal(cache.get(b), 3, '别的仓库保留');
	assert.equal(cache.size, 1);
});

test('clear 清空全部键', () => {
	const cache = createCommitGraphCache();
	cache.set('a', 1);
	cache.set('b', 2);
	cache.clear();
	assert.equal(cache.size, 0);
	assert.equal(cache.get('a'), undefined);
});

test('缓存任意值类型', () => {
	const cache = createCommitGraphCache();
	const value = { commits: [{ hash: 'abc' }] };
	cache.set(cache.keyOf('/repo/a', baseOptions), value);
	assert.equal(cache.get(cache.keyOf('/repo/a/', baseOptions)), value);
});
