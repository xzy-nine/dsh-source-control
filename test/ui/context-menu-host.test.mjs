/**
 * 宿主共享菜单承载：连续两次右键、第一次未选中任何条目时，第二次的菜单仍要有条目。
 *
 * 宿主的打开流程是先收掉上一份菜单（活动目标置空、旧目标作废）、再置入新目标。承载侧若把
 * 这一拍的空值当成「本份关闭」，刚登记的贡献会在弹窗出现前就被注销：菜单弹出时没有条目，
 * 而这次空开又把活动目标留在非空态，下一次右键重复同一过程——菜单从此打不开。
 *
 * 这里用一个按宿主契约实现的最小服务当被测面：活动目标是快照源，打开时先置空再置入新目标。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { showSharedContextMenu } from '../../src/client/ui/context-menu-host.ts';

/**
 * 建一个最小共享菜单服务。
 *
 * 只保留承载侧用到的面：活动目标、登记、打开、关闭。贡献被注销后其条目从已解析的菜单里消失，
 * 与宿主注册表让注销参与重新解析的行为一致。
 *
 * @returns 服务、登记表、打开记录与最近一次打开的条目。
 */
function createFakeMenus() {
	const active = createSnapshotStore(null);
	/** 登记中的贡献。 */
	const providers = new Set();
	/** 每次打开产生的一份解析。 */
	const resolutions = new Set();
	/** 每次打开的记录，按发生顺序。 */
	const opened = [];

	/** 按当前登记重新算出某份解析的条目。 */
	const refresh = (resolution) => {
		resolution.source.set(resolution.entries
			.filter((entry) => !entry.provider.aborted)
			.flatMap((entry) => entry.actions.map((action) => ({ id: `${entry.provider.id}/${action.id}`, label: action.label }))));
	};

	/** 为新目标解析一份菜单。 */
	const resolve = (target) => {
		const resolution = { source: createSnapshotStore([]), entries: [] };
		const providers4Target = [...providers]
			.filter((provider) => provider.target === target.kind)
			.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
		for (const provider of providers4Target) resolution.entries.push({ provider, actions: provider.resolve(target) });
		resolutions.add(resolution);
		refresh(resolution);
		return resolution;
	};

	const service = {
		active,
		registeredKinds: createSnapshotStore([]),
		register(contribution) {
			const provider = { ...contribution, aborted: false };
			providers.add(provider);
			return () => {
				if (provider.aborted) return;
				provider.aborted = true;
				providers.delete(provider);
				for (const resolution of resolutions) refresh(resolution);
			};
		},
		open(target, point) {
			// 宿主先收掉上一份，再置入新目标。
			active.set(null);
			const resolution = resolve(target);
			active.set(target);
			opened.push({ target, point, resolution });
		},
		close() { active.set(null); },
		select(id) {
			// 宿主的 select：先置空活动目标，再执行选中动作。
			const resolution = opened[opened.length - 1].resolution;
			active.set(null);
			const action = resolution.entries.flatMap((entry) => entry.actions).find((entry) => entry.id === id);
			action?.run?.();
		},
		notify() {},
		resolve,
	};
	/** 最近一次打开的条目。 */
	const last = () => opened[opened.length - 1].resolution.source.getSnapshot();
	return { service, opened, providers, last };
}

/** 让承载侧排进微任务的收尾与刷新都跑完。 */
async function settle() {
	await new Promise((done) => { setTimeout(done, 0); });
}

test('第一次未选中条目就再次右键，第二份菜单仍带条目', async () => {
	const { service, opened, providers, last } = createFakeMenus();
	const closed = [];
	showSharedContextMenu(service, [{ title: '提交' }], undefined, 20, 30, () => { closed.push('first'); });
	assert.equal(opened.length, 1, '第一次右键应打开一次');
	assert.deepEqual(last().map((action) => action.label), ['提交'], '第一次打开应有条目');

	// 上一份菜单还开着、没有选中任何条目，此时再次右键。
	showSharedContextMenu(service, [{ title: '提交' }, { title: '丢弃' }], undefined, 60, 90, () => { closed.push('second'); });
	await settle();

	assert.deepEqual(last().map((action) => action.label), ['提交', '丢弃'], '第二次打开必须带条目');
	assert.deepEqual(closed, ['first'], '只有上一份贡献收尾');
	assert.equal(providers.size, 1, '第二份贡献必须仍然登记');
});

test('选中时先执行动作、再收尾注销', async () => {
	const { service, providers } = createFakeMenus();
	const closed = [];
	const clicks = [];
	showSharedContextMenu(service, [{ title: '提交', onClick: () => { clicks.push('提交'); } }],
		undefined, 10, 20, () => { closed.push('closed'); });

	service.select('i0');

	assert.deepEqual(clicks, ['提交'], '选中动作应立即执行');
	assert.deepEqual(closed, [], '收尾必须排在选中动作之后');
	await settle();
	assert.deepEqual(closed, ['closed'], '收尾最终仍要发生');
	assert.equal(providers.size, 0, '收尾后贡献必须注销');
});

test('关闭后注销当前贡献并清空条目', async () => {
	const { service, providers, last } = createFakeMenus();
	const closed = [];
	showSharedContextMenu(service, [{ title: '提交' }], undefined, 20, 30, () => { closed.push('first'); });
	await settle();
	assert.equal(providers.size, 1);

	service.close();
	await settle();

	assert.deepEqual(closed, ['first'], '关闭后应收到关闭回调');
	assert.equal(providers.size, 0, '关闭后贡献必须注销');
	assert.deepEqual(last(), [], '关闭后条目应清空');
});
