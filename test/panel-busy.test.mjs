/**
 * 忙碌状态分级：按仓库与影响面记录，互不阻塞。
 */
import assert from 'node:assert/strict';
import { addBusy, anyBusy, busyFlagsOf, isReadBlocked, isRepoBusy, removeBusy } from '../src/client/panel/busy.ts';
import { parallel } from './harness.mjs';


/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('忙碌分级', (t) => {
	t.test('记录按仓库与影响面分别保存', () => {
		const entries = addBusy(addBusy([], '/repo/a', 'commit'), '/repo/a', 'network');
		assert.equal(entries.length, 2);
		assert.equal(isRepoBusy(entries, '/repo/a'), true);
		assert.equal(isRepoBusy(entries, '/repo/a', 'commit'), true);
		assert.equal(isRepoBusy(entries, '/repo/a', 'history'), false);
	});

	t.test('同一仓库的不同影响面互不阻塞', () => {
		const entries = addBusy(addBusy([], '/repo/a', 'commit'), '/repo/a', 'network');
		const flags = busyFlagsOf(entries, '/repo/a');
		assert.equal(flags.commit, true);
		assert.equal(flags.network, true);
		assert.equal(flags.read, false);
		assert.equal(flags.history, false);
	});

	t.test('不同仓库互不阻塞', () => {
		const entries = addBusy([], '/repo/a', 'commit');
		assert.equal(isRepoBusy(entries, '/repo/a'), true);
		assert.equal(isRepoBusy(entries, '/repo/b'), false);
		assert.deepEqual(busyFlagsOf(entries, '/repo/b'), { read: false, commit: false, history: false, network: false });
	});

	t.test('重复触发的同类操作各占一份，逐个移除', () => {
		let entries = addBusy(addBusy([], '/repo/a', 'commit'), '/repo/a', 'commit');
		assert.equal(entries.length, 2);
		entries = removeBusy(entries, '/repo/a', 'commit');
		assert.equal(isRepoBusy(entries, '/repo/a', 'commit'), true, '移除一份后仍在忙');
		entries = removeBusy(entries, '/repo/a', 'commit');
		assert.equal(isRepoBusy(entries, '/repo/a', 'commit'), false);
		assert.equal(entries.length, 0);
	});

	t.test('移除不存在的记录时原样返回', () => {
		const entries = addBusy([], '/repo/a', 'commit');
		assert.equal(removeBusy(entries, '/repo/a', 'history'), entries);
		assert.equal(removeBusy(entries, '/repo/b', 'commit'), entries);
	});

	t.test('未选中仓库恒为空闲', () => {
		const entries = addBusy([], '/repo/a', 'commit');
		assert.equal(isRepoBusy(entries, null), false);
		assert.equal(isRepoBusy(entries, null, 'commit'), false);
		assert.equal(anyBusy(busyFlagsOf(entries, null)), false);
	});

	t.test('任一影响面在忙都点亮进度条', () => {
		const idle = { read: false, commit: false, history: false, network: false };
		assert.equal(anyBusy(idle), false);
		for (const scope of ['read', 'commit', 'history', 'network']) {
			assert.equal(anyBusy({ ...idle, [scope]: true }), true, scope + ' 在忙时应显示进度条');
		}
	});

	t.test('联网操作不挡住后台读取', () => {
		/*
		 * 推送与抓取不改写本地对象库与工作区：把它们算作阻塞，会让变更列表与提交图在一次推送的
		 * 整段时间里停更。
		 */
		const network = addBusy([], '/repo/a', 'network');
		assert.equal(isReadBlocked(network, '/repo/a'), false, '联网操作不算阻塞');
		assert.equal(isRepoBusy(network, '/repo/a'), true, '但它仍是忙碌：控件与进度条照常');
	});

	t.test('本地写操作挡住后台读取', () => {
		for (const scope of ['read', 'commit', 'history']) {
			assert.equal(isReadBlocked(addBusy([], '/repo/a', scope), '/repo/a'), true, scope + ' 应挡住读取');
		}
	});

	t.test('未选中仓库时读取不被挡住', () => {
		assert.equal(isReadBlocked(addBusy([], '/repo/a', 'commit'), null), false);
	});

	t.test('别的仓库的操作不挡住本仓库读取', () => {
		assert.equal(isReadBlocked(addBusy([], '/repo/b', 'history'), '/repo/a'), false);
	});
});
