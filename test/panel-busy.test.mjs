/**
 * 忙碌状态分级：按仓库与影响面记录，互不阻塞。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addBusy, anyBusy, busyFlagsOf, isRepoBusy, removeBusy } from '../src/client/panel/busy.ts';

test('记录按仓库与影响面分别保存', () => {
	const entries = addBusy(addBusy([], '/repo/a', 'commit'), '/repo/a', 'network');
	assert.equal(entries.length, 2);
	assert.equal(isRepoBusy(entries, '/repo/a'), true);
	assert.equal(isRepoBusy(entries, '/repo/a', 'commit'), true);
	assert.equal(isRepoBusy(entries, '/repo/a', 'history'), false);
});

test('同一仓库的不同影响面互不阻塞', () => {
	const entries = addBusy(addBusy([], '/repo/a', 'commit'), '/repo/a', 'network');
	const flags = busyFlagsOf(entries, '/repo/a');
	assert.equal(flags.commit, true);
	assert.equal(flags.network, true);
	assert.equal(flags.read, false);
	assert.equal(flags.history, false);
});

test('不同仓库互不阻塞', () => {
	const entries = addBusy([], '/repo/a', 'commit');
	assert.equal(isRepoBusy(entries, '/repo/a'), true);
	assert.equal(isRepoBusy(entries, '/repo/b'), false);
	assert.deepEqual(busyFlagsOf(entries, '/repo/b'), { read: false, commit: false, history: false, network: false });
});

test('重复触发的同类操作各占一份，逐个移除', () => {
	let entries = addBusy(addBusy([], '/repo/a', 'commit'), '/repo/a', 'commit');
	assert.equal(entries.length, 2);
	entries = removeBusy(entries, '/repo/a', 'commit');
	assert.equal(isRepoBusy(entries, '/repo/a', 'commit'), true, '移除一份后仍在忙');
	entries = removeBusy(entries, '/repo/a', 'commit');
	assert.equal(isRepoBusy(entries, '/repo/a', 'commit'), false);
	assert.equal(entries.length, 0);
});

test('移除不存在的记录时原样返回', () => {
	const entries = addBusy([], '/repo/a', 'commit');
	assert.equal(removeBusy(entries, '/repo/a', 'history'), entries);
	assert.equal(removeBusy(entries, '/repo/b', 'commit'), entries);
});

test('未选中仓库恒为空闲', () => {
	const entries = addBusy([], '/repo/a', 'commit');
	assert.equal(isRepoBusy(entries, null), false);
	assert.equal(isRepoBusy(entries, null, 'commit'), false);
	assert.equal(anyBusy(busyFlagsOf(entries, null)), false);
});

test('任一影响面在忙都点亮进度条', () => {
	const idle = { read: false, commit: false, history: false, network: false };
	assert.equal(anyBusy(idle), false);
	for (const scope of ['read', 'commit', 'history', 'network']) {
		assert.equal(anyBusy({ ...idle, [scope]: true }), true, scope + ' 在忙时应显示进度条');
	}
});
