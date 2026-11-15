/**
 * 忙碌状态分级：按仓库与影响面记录，互不阻塞。
 */
import assert from 'node:assert/strict';
import { addBusy, anyBusy, busyFlagsOf, cancellableEntriesOf, isReadBlocked, isRepoBusy, removeBusy, setBusyLabel } from '../src/client/panel/busy.ts';
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

	t.test('只有带停止键的记录可停止', () => {
		const entries = addBusy(
			addBusy([], '/repo/a', 'network'),
			'/repo/a', 'network', { cancelKey: 'k1', label: '从所有远程抓取' },
		);
		const cancellable = cancellableEntriesOf(entries);
		assert.equal(cancellable.length, 1, '不带键的记录不进入停止清单');
		assert.equal(cancellable[0].cancelKey, 'k1');
		assert.equal(cancellable[0].label, '从所有远程抓取');
	});

	t.test('按影响面决定停止入口的呈现方式', () => {
		/*
		 * 会挡住其他功能的长任务必须弹窗说明；不挡功能的只占一行，不打断用户继续操作。
		 */
		const network = addBusy([], '/repo/a', 'network', { cancelKey: 'n', label: '抓取' });
		assert.equal(cancellableEntriesOf(network)[0].surface, 'row', '联网操作不挡功能，用行内入口');

		for (const scope of ['read', 'commit', 'history']) {
			const blocking = addBusy([], '/repo/a', scope, { cancelKey: scope, label: scope });
			assert.equal(cancellableEntriesOf(blocking)[0].surface, 'dialog', scope + ' 挡住功能，应弹窗');
		}
	});

	t.test('阶段改写按停止键定位', () => {
		let entries = addBusy([], '/repo/a', 'network', { cancelKey: 'k1', label: '抓取' });
		entries = setBusyLabel(entries, 'k1', '合并');
		assert.equal(cancellableEntriesOf(entries)[0].label, '合并');

		// 键不存在时原样返回：操作已结束时到来的阶段上报不该凭空造出记录。
		assert.equal(setBusyLabel(entries, 'missing', '推送'), entries);
	});

	t.test('阶段改写不波及并行中的另一次操作', () => {
		let entries = addBusy([], '/repo/a', 'network', { cancelKey: 'k1', label: '抓取' });
		entries = addBusy(entries, '/repo/a', 'network', { cancelKey: 'k2', label: '抓取' });
		entries = setBusyLabel(entries, 'k2', '合并');

		const labels = cancellableEntriesOf(entries).map((entry) => entry.cancelKey + '=' + entry.label);
		assert.deepEqual(labels, ['k1=抓取', 'k2=合并']);
	});

	t.test('按停止键精确移除，不误删并行的另一次操作', () => {
		let entries = addBusy([], '/repo/a', 'network', { cancelKey: 'k1', label: '抓取一' });
		entries = addBusy(entries, '/repo/a', 'network', { cancelKey: 'k2', label: '抓取二' });
		assert.equal(entries.length, 2);

		entries = removeBusy(entries, '/repo/a', 'network', 'k2');
		assert.equal(entries.length, 1, '只移除指定的那一次');
		assert.equal(cancellableEntriesOf(entries)[0].cancelKey, 'k1', '另一次仍在停止清单里');

		/*
		 * 不带键的移除只认同样没有键的记录：它属于不可停止的操作，若按影响面随手摘一条，
		 * 会把还在跑、仍带停止入口的那次一并去掉。
		 */
		entries = removeBusy(entries, '/repo/a', 'network');
		assert.equal(entries.length, 1, '带键的记录不被不带键的移除波及');
		assert.equal(cancellableEntriesOf(entries)[0].cancelKey, 'k1');
	});

	t.test('不带键的移除只摘不带键的记录', () => {
		let entries = addBusy([], '/repo/a', 'network');
		entries = addBusy(entries, '/repo/a', 'network', { cancelKey: 'k1', label: '抓取' });

		entries = removeBusy(entries, '/repo/a', 'network');
		assert.equal(entries.length, 1, '只摘掉不带键的那一份');
		assert.equal(cancellableEntriesOf(entries)[0].cancelKey, 'k1', '带键的仍在停止清单里');
	});
});
