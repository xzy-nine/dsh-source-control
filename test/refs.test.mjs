/**
 * 引用筛选的测试：状态读写按仓库绑定、取数起点、手选校验与摘要文案。
 *
 * 筛选模型与 VS Code 图形视图一致：自动模式不落盘，手选按引用 id 持久化，失效即回退自动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	autoRefNames, checkedRefIds, DEFAULT_REF_FILTER, filterBranchesOf, filterKeyOf, filterSummaryOf, legacyFilterOf,
	readStoredFilter, refIdOf, refNameOf, revalidatedFilter, writeStoredFilter,
} from '../src/client/panel/refs.ts';

/** 造一个引用项。 */
const ref = (id, name, type) => ({ id, name, hash: 'h-' + name, type, kind: '' });

test('默认筛选是自动，且不落盘', () => {
	const repo = 'E:/work/repo-a';
	const registry = writeStoredFilter({}, repo, DEFAULT_REF_FILTER);
	assert.deepEqual(registry, {}, '自动模式不写条目');
	assert.equal(readStoredFilter(registry, repo).mode, 'auto');
});

test('按仓库绑定：两个仓库各记各的，全部模式记字面量', () => {
	const a = 'E:/work/repo-a';
	const b = 'e:/work/repo-b/';
	let registry = writeStoredFilter({}, a, { mode: 'all', ids: [] });
	registry = writeStoredFilter(registry, b, { mode: 'manual', ids: ['refs/heads/feature'] });
	assert.equal(readStoredFilter(registry, a).mode, 'all');
	assert.deepEqual(readStoredFilter(registry, b).ids, ['refs/heads/feature']);
	// 路径写法差异（大小写、尾斜杠）落到同一个键。
	assert.equal(filterKeyOf('E:\\work\\repo-a\\'), filterKeyOf(a));
});

test('切回自动时删掉该仓库的条目，其余仓库保留', () => {
	const a = 'E:/work/repo-a';
	const b = 'E:/work/repo-b';
	let registry = writeStoredFilter({}, a, { mode: 'all', ids: [] });
	registry = writeStoredFilter(registry, b, { mode: 'all', ids: [] });
	registry = writeStoredFilter(registry, a, DEFAULT_REF_FILTER);
	assert.equal(readStoredFilter(registry, a).mode, 'auto');
	assert.equal(readStoredFilter(registry, b).mode, 'all');
});

test('非法持久化值回退自动', () => {
	const repo = 'E:/work/repo-a';
	assert.equal(readStoredFilter(null, repo).mode, 'auto');
	assert.equal(readStoredFilter({ [filterKeyOf(repo)]: 42 }, repo).mode, 'auto');
	assert.equal(readStoredFilter({ [filterKeyOf(repo)]: [] }, repo).mode, 'auto');
	assert.equal(readStoredFilter({ other: 'manual' }, repo).mode, 'auto');
});

test('引用 id 与短名双向换算', () => {
	assert.equal(refIdOf('main', 'branch'), 'refs/heads/main');
	assert.equal(refIdOf('origin/main', 'remote'), 'refs/remotes/origin/main');
	assert.equal(refIdOf('v1', 'tag'), 'refs/tags/v1');
	assert.equal(refNameOf('refs/heads/main'), 'main');
	assert.equal(refNameOf('refs/remotes/origin/dev'), 'origin/dev');
	assert.equal(refNameOf('refs/tags/v1'), 'v1');
});

test('自动模式取当前分支、上游与分叉来源，去重保序', () => {
	assert.deepEqual(
		autoRefNames({ head: 'feature', upstream: 'origin/feature', base: 'origin/main' }),
		['feature', 'origin/feature', 'origin/main'],
	);
	// 上游与分叉来源相同只留一个。
	assert.deepEqual(
		autoRefNames({ head: 'main', upstream: 'origin/main', base: 'origin/main' }),
		['main', 'origin/main'],
	);
	// 分离头指针用提交哈希作起点；无上游与来源时只剩它。
	assert.deepEqual(autoRefNames({ head: null, headHash: 'abc123', upstream: null, base: null }), ['abc123']);
});

test('取数起点：全部为 null，自动与手选给引用名', () => {
	const context = { head: 'feature', headHash: 'h1', upstream: 'origin/feature', base: 'origin/main' };
	assert.equal(filterBranchesOf({ mode: 'all', ids: [] }, context), null);
	assert.deepEqual(filterBranchesOf({ mode: 'auto', ids: [] }, context), ['feature', 'origin/feature', 'origin/main']);
	assert.deepEqual(
		filterBranchesOf({ mode: 'manual', ids: ['refs/heads/dev', 'refs/tags/v1'] }, context),
		['dev', 'v1'],
	);
	// 自动模式的上下文为空时退回全部，避免空取数。
	assert.equal(filterBranchesOf({ mode: 'auto', ids: [] }, { head: null, headHash: null, upstream: null, base: null }), null);
});

test('手选引用失效时回退自动', () => {
	const refs = [ref('refs/heads/main', 'main', 'branch'), ref('refs/heads/dev', 'dev', 'branch')];
	// 命中：原样保留。
	const kept = { mode: 'manual', ids: ['refs/heads/main'] };
	assert.equal(revalidatedFilter(kept, refs), kept);
	// 部分失效：只留下仍存在的。
	assert.deepEqual(
		revalidatedFilter({ mode: 'manual', ids: ['refs/heads/main', 'refs/heads/gone'] }, refs).ids,
		['refs/heads/main'],
	);
	// 全部失效：回退自动。
	assert.equal(revalidatedFilter({ mode: 'manual', ids: ['refs/heads/gone'] }, refs).mode, 'auto');
});

test('勾选态：全部勾满，自动只勾起点，手选用 id 集合', () => {
	const refs = [
		ref('refs/heads/main', 'main', 'branch'),
		ref('refs/remotes/origin/main', 'origin/main', 'remote'),
		ref('refs/heads/dev', 'dev', 'branch'),
	];
	const context = { head: 'main', headHash: 'h1', upstream: 'origin/main', base: null };
	assert.deepEqual([...checkedRefIds({ mode: 'all', ids: [] }, refs, context)], refs.map((item) => item.id));
	assert.deepEqual(
		[...checkedRefIds({ mode: 'auto', ids: [] }, refs, context)],
		['refs/heads/main', 'refs/remotes/origin/main'],
	);
	assert.deepEqual([...checkedRefIds({ mode: 'manual', ids: ['refs/heads/dev'] }, refs, context)], ['refs/heads/dev']);
});

test('按钮摘要：模式名、单个引用名或数量', () => {
	assert.equal(filterSummaryOf({ mode: 'all', ids: [] }), '全部');
	assert.equal(filterSummaryOf({ mode: 'auto', ids: [] }), '自动');
	assert.equal(filterSummaryOf({ mode: 'manual', ids: ['refs/heads/dev'] }), 'dev');
	assert.equal(filterSummaryOf({ mode: 'manual', ids: ['refs/heads/a', 'refs/heads/b'] }), '2 个');
});
test('旧版筛选折合为新形状：模式保留，名字按前缀推断引用种类', () => {
	assert.deepEqual(legacyFilterOf({ mode: 'all', selected: [] }), { mode: 'all', ids: [] });
	assert.equal(legacyFilterOf({ mode: 'auto', selected: [] }).mode, 'auto');
	assert.deepEqual(
		legacyFilterOf({ mode: 'manual', selected: ['main', 'origin/dev'] }).ids,
		['refs/heads/main', 'refs/remotes/origin/dev'],
	);
	assert.equal(legacyFilterOf(null), null);
	assert.equal(legacyFilterOf({ mode: 'unknown' }), null);
});
