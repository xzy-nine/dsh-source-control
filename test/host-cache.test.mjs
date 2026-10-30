/**
 * 宿主缓存契约：提交图窗口键含 HEAD、命中即最近使用、按仓库失效的范围、快照的 HEAD 守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importHostModule } from './lib-import.mjs';

const cache = await importHostModule('source-control/host-cache.js');

/** 一组默认的提交图取数参数。 */
function graphParams(overrides = {}) {
	return {
		head: 'aaa',
		maxCommits: 100,
		skip: 0,
		ordering: 'topo',
		showTags: true,
		showRemoteBranches: true,
		showStashes: true,
		onlyFollowFirstParent: false,
		includeCommitsMentionedByReflogs: false,
		hideRemotes: [],
		branches: null,
		remotes: [],
		stashes: [],
		...overrides,
	};
}

/** 一个提交图窗口值。 */
function graphValue(head = 'aaa') {
	return {
		commits: [{ hash: head }], head, tags: [],
		moreCommitsAvailable: false, nextSkip: 1, foreignBranches: [],
	};
}

/** 一个工作区快照值。 */
function snapshotValue(head) {
	return { entries: [], head, branch: 'main', upstream: null, ahead: 0, behind: 0, merging: false, error: null };
}

test('graphKey：HEAD 参与键，HEAD 变化后同一组参数不再命中', () => {
	const before = cache.graphKey('/repo/a', graphParams({ head: 'aaa' }));
	const after = cache.graphKey('/repo/a', graphParams({ head: 'bbb' }));
	assert.notEqual(before, after, 'HEAD 变化应改变键');
});

test('graphKey：HEAD 未知统一编码为哨兵，不与真实哈希碰撞', () => {
	// 未知 HEAD 与字面 '*' 同属「未知」：真实哈希是十六进制，不可能等于 '*'。
	assert.equal(
		cache.graphKey('/repo/a', graphParams({ head: null })),
		cache.graphKey('/repo/a', graphParams({ head: '*' })),
	);
	assert.notEqual(
		cache.graphKey('/repo/a', graphParams({ head: null })),
		cache.graphKey('/repo/a', graphParams({ head: 'abc123' })),
	);
});

test('提交图窗口：HEAD 未变命中，HEAD 变了不命中', () => {
	cache.clearHostCache();
	cache.writeGraph('/repo/a', graphParams({ head: 'aaa' }), graphValue('aaa'));
	assert.equal(cache.readGraph('/repo/a', graphParams({ head: 'aaa' }))?.head, 'aaa');
	assert.equal(cache.readGraph('/repo/a', graphParams({ head: 'bbb' })), undefined);
});

test('提交图窗口：命中即最近使用，容量淘汰落在最久未用的一项', () => {
	cache.clearHostCache();
	const limit = 64;
	for (let index = 0; index < limit; index += 1) {
		cache.writeGraph('/repo/a', graphParams({ skip: index }), graphValue(`h${index}`));
	}
	// 命中第一项，使其成为最近使用。
	assert.notEqual(cache.readGraph('/repo/a', graphParams({ skip: 0 })), undefined);
	// 再写入一项，淘汰应落在第二项而不是第一项。
	cache.writeGraph('/repo/a', graphParams({ skip: limit }), graphValue('hnew'));
	assert.notEqual(cache.readGraph('/repo/a', graphParams({ skip: 0 })), undefined, '刚访问过的窗口保留');
	assert.equal(cache.readGraph('/repo/a', graphParams({ skip: 1 })), undefined, '最久未用的窗口被淘汰');
});

test('invalidateRepo：只清目标仓库，别的仓库保留', () => {
	cache.clearHostCache();
	cache.writeGraph('/repo/a', graphParams(), graphValue());
	cache.writeGraph('/repo/b', graphParams(), graphValue());
	cache.writeSnapshot('/repo/a', snapshotValue('aaa'));
	cache.writeSnapshot('/repo/b', snapshotValue('aaa'));

	cache.invalidateRepo('/repo/a');

	assert.equal(cache.readGraph('/repo/a', graphParams()), undefined);
	assert.equal(cache.readSnapshot('/repo/a', 'aaa'), undefined);
	assert.notEqual(cache.readGraph('/repo/b', graphParams()), undefined, '别的仓库的窗口保留');
	assert.notEqual(cache.readSnapshot('/repo/b', 'aaa'), undefined, '别的仓库的快照保留');
});

test('invalidateRepo：子仓库的写使父仓库失效，父仓库的写使子仓库失效', () => {
	cache.clearHostCache();
	cache.writeGraph('/repo/parent', graphParams(), graphValue());
	cache.writeGraph('/repo/parent/sub', graphParams(), graphValue());

	cache.invalidateRepo('/repo/parent/sub');
	assert.equal(cache.readGraph('/repo/parent', graphParams()), undefined, '父仓库受影响');
	assert.equal(cache.readGraph('/repo/parent/sub', graphParams()), undefined);
});

test('invalidateRepo：路径写法不同（尾分隔符与大小写）同样命中', () => {
	cache.clearHostCache();
	cache.writeGraph('/Repo/A', graphParams(), graphValue());
	cache.invalidateRepo('/repo/a/');
	assert.equal(cache.readGraph('/Repo/A', graphParams()), undefined);
});

test('工作区快照：HEAD 变化后不命中旧条目', () => {
	cache.clearHostCache();
	cache.writeSnapshot('/repo/a', snapshotValue('aaa'));
	assert.notEqual(cache.readSnapshot('/repo/a', 'aaa'), undefined);
	assert.equal(cache.readSnapshot('/repo/a', 'bbb'), undefined, 'HEAD 已变，不命中');
});

test('工作区快照：未给 HEAD 时按写入时的键读', () => {
	cache.clearHostCache();
	cache.writeSnapshot('/repo/a', snapshotValue('aaa'));
	assert.equal(cache.readSnapshot('/repo/a'), undefined, '未知 HEAD 不与任何具体 HEAD 混用');
	assert.equal(cache.readSnapshot('/repo/a', null), undefined);
});

test('仓库信息：命中后可按仓库失效', () => {
	cache.clearHostCache();
	const params = { showRemoteBranches: true, showStashes: true, hideRemotes: [] };
	cache.writeRepoInfo('/repo/a', params, { branches: [], head: null, remotes: [], stashes: [], error: null });
	assert.notEqual(cache.readRepoInfo('/repo/a', params), undefined);
	cache.invalidateRepo('/repo/a');
	assert.equal(cache.readRepoInfo('/repo/a', params), undefined);
});

test('钩子路径：未命中为 undefined，写入后按归一化路径命中', () => {
	cache.clearHostCache();
	assert.equal(cache.readHooksPath('/repo/a'), undefined);
	cache.writeHooksPath('/repo/a', '.githooks');
	assert.equal(cache.readHooksPath('/Repo/A/'), '.githooks', '尾分隔符与大小写不影响命中');
	assert.equal(cache.readHooksPath('/repo/b'), undefined, '只按仓库区分');
});

test('钩子路径：按仓库失效，祖先与后代一并覆盖', () => {
	cache.clearHostCache();
	cache.writeHooksPath('/repo/parent', '');
	cache.writeHooksPath('/repo/parent/sub', '.hooks');
	cache.invalidateRepo('/repo/parent/sub');
	assert.equal(cache.readHooksPath('/repo/parent'), undefined, '父仓库受影响');
	assert.equal(cache.readHooksPath('/repo/parent/sub'), undefined);
	cache.writeHooksPath('/repo/parent', '');
	cache.clearHostCache();
	assert.equal(cache.readHooksPath('/repo/parent'), undefined, '清空后不再命中');
});
