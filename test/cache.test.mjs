/**
 * 有界缓存基元测试：用 `node --test` 运行。
 *
 * 覆盖容量淘汰、取值次序（`get` 置新、`peek` 不动次序）、按身份与按键的派生值缓存，
 * 以及映射表比对与就地淘汰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	LruMap, forKey, forObject, mapsEqual, trimOldest,
} from '../src/client/shared/cache.ts';

/** 取全部键，按旧到新排列。 */
const keysOf = (map) => [...map.keys()];

test('容量上限由构造参数决定', () => {
	const map = new LruMap({ limit: 7 });
	assert.equal(map.limit, 7);
	assert.equal(map.size, 0);
	map.set('a', 1);
	assert.equal(map.size, 1);
	map.clear();
	assert.equal(map.size, 0);
});

test('get 命中后置为最新，peek 不改变次序', () => {
	const map = new LruMap({ limit: 3, ratio: 1 });
	map.set('a', 1).set('b', 2).set('c', 3);
	assert.equal(map.get('a'), 1);
	assert.deepEqual(keysOf(map), ['b', 'c', 'a']);
	assert.equal(map.peek('b'), 2);
	assert.deepEqual(keysOf(map), ['b', 'c', 'a'], 'peek 不改次序');
});

test('超限时按插入序淘汰最旧的若干个', () => {
	// ratio 0.5：上限 10，淘汰到 5。
	const map = new LruMap({ limit: 10, ratio: 0.5 });
	for (let index = 0; index < 11; index += 1) map.set(index, index);
	assert.equal(map.size, 5);
	assert.deepEqual(keysOf(map), [6, 7, 8, 9, 10]);
});

test('淘汰不会多删到目标以下', () => {
	const map = new LruMap({ limit: 2, ratio: 0.8 });
	map.set('a', 1).set('b', 2);
	map.set('c', 3);
	// ceil(2 * 0.8) = 2，只淘汰一项。
	assert.equal(map.size, 2);
	assert.deepEqual(keysOf(map), ['b', 'c']);
});

test('delete 与 has 按条目生效', () => {
	const map = new LruMap({ limit: 4 });
	map.set('a', 1).set('b', 2);
	assert.equal(map.has('a'), true);
	assert.equal(map.delete('a'), true);
	assert.equal(map.delete('a'), false);
	assert.equal(map.has('a'), false);
	assert.deepEqual(keysOf(map), ['b']);
});

test('重复写入同一个键只保留一份且置为最新', () => {
	const map = new LruMap({ limit: 4, ratio: 1 });
	map.set('a', 1).set('b', 2).set('a', 9);
	assert.equal(map.size, 2);
	assert.deepEqual(keysOf(map), ['b', 'a']);
	assert.equal(map.get('a'), 9);
});

test('forObject 按对象隔离且同一对象返回同一引用', () => {
	const compute = forObject((key) => ({ value: key.value * 2 }));
	const one = { value: 1 };
	const two = { value: 1 };
	const first = compute(one);
	assert.equal(compute(one), first, '同一对象复用');
	assert.notEqual(compute(two), first, '不同对象各自计算');
	assert.equal(compute(two).value, 2);
});

test('forKey 命中不重算，淘汰后重算', () => {
	let calls = 0;
	const compute = forKey((key) => {
		calls += 1;
		return key.toUpperCase();
	}, { limit: 2, ratio: 1 });
	assert.equal(compute('a'), 'A');
	assert.equal(compute('a'), 'A');
	assert.equal(calls, 1, '命中不重算');
	assert.equal(compute('b'), 'B');
	// 上限 2：写入 c 后淘汰最旧的 a。
	assert.equal(compute('c'), 'C');
	assert.equal(compute('a'), 'A');
	assert.equal(calls, 4, '被淘汰的键重新计算');
});

test('forKey 缓存 undefined 值也视为命中', () => {
	let calls = 0;
	const compute = forKey(() => {
		calls += 1;
		return undefined;
	}, { limit: 2 });
	assert.equal(compute('a'), undefined);
	assert.equal(compute('a'), undefined);
	assert.equal(calls, 1);
});

test('mapsEqual 先比条目数再逐项比对', () => {
	assert.equal(mapsEqual(new Map([['a', 1]]), new Map([['a', 1]])), true);
	assert.equal(mapsEqual(new Map([['a', 1]]), new Map([['a', 2]])), false);
	assert.equal(mapsEqual(new Map([['a', 1]]), new Map([['b', 1]])), false);
	assert.equal(mapsEqual(new Map([['a', 1]]), new Map()), false);
	assert.equal(mapsEqual(new Map(), new Map()), true);
	// 自定义判据按字段比较。
	const same = (left, right) => left.id === right.id;
	assert.equal(mapsEqual(new Map([['a', { id: 1 }]]), new Map([['a', { id: 1 }]]), same), true);
	assert.equal(mapsEqual(new Map([['a', { id: 1 }]]), new Map([['a', { id: 2 }]]), same), false);
	assert.equal(mapsEqual(new Map([['a', undefined]]), new Map([['a', undefined]])), true);
});

test('trimOldest 就地删最旧的条目并返回同一表', () => {
	const map = new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]);
	const trimmed = trimOldest(map, 3);
	assert.equal(trimmed, map, '返回传入的表');
	assert.deepEqual([...map.keys()], ['c', 'd', 'e']);
	// 已达上限时不删。
	trimOldest(map, 3);
	assert.deepEqual([...map.keys()], ['c', 'd', 'e']);
});
