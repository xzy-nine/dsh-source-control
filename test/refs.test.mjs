/**
 * 引用筛选的测试：可达集过滤、工作区伪提交与贮藏提交的保留。
 *
 * 贮藏提交是分支尖端的子提交，沿父提交回溯的遍历取不到它，只能按标记保留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRefs, filterCommitsByRefs } from '../src/client/panel/refs.ts';

/** 造一个提交。 */
const commit = (hash, extra = {}) => ({ hash, parents: [], heads: [], remotes: [], tags: [], ...extra });

test('按引用过滤时保留贮藏提交', () => {
	const base = commit('base', { heads: ['dev'] });
	const stash = commit('stash1', { parents: ['base'], stash: { selector: 'refs/stash@{0}' } });
	const other = commit('other', { heads: ['feature'] });
	const filtered = filterCommitsByRefs([base, stash, other], new Set(['dev']));
	assert.deepEqual(filtered.map((item) => item.hash), ['base', 'stash1']);
});

test('工作区伪提交始终保留', () => {
	const uncommitted = commit('*');
	const filtered = filterCommitsByRefs([uncommitted, commit('other', { heads: ['feature'] })], new Set(['dev']));
	assert.deepEqual(filtered.map((item) => item.hash), ['*']);
});

test('空选择集表示不过滤', () => {
	const commits = [commit('a'), commit('b')];
	assert.equal(filterCommitsByRefs(commits, new Set()).length, 2);
});

test('选中分支的可达历史保留，分支外提交被过滤', () => {
	const root = commit('root');
	const devTip = commit('dev-tip', { parents: ['root'], heads: ['dev'] });
	const side = commit('side', { parents: ['root'], heads: ['feature'] });
	const filtered = filterCommitsByRefs([devTip, side, root], new Set(['dev']));
	assert.deepEqual(filtered.map((item) => item.hash), ['dev-tip', 'root']);
});

test('引用收集只取分支、远程与标签', () => {
	const refs = collectRefs([
		commit('a', { heads: ['dev'], remotes: [{ name: 'origin/dev' }], tags: [{ name: 'v1' }], stash: { selector: 'refs/stash@{0}' } }),
	]);
	assert.deepEqual(refs.map((ref) => ref.name), ['dev', 'origin/dev', 'v1']);
});
