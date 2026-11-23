/**
 * 面板重挂载的客户端渲染态：切会话会让面板整体重新挂载，重新挂载后首帧要能直接取回
 * 上次画出来的状态与已加载提交数上限。
 *
 * 这里只覆盖客户端渲染态与取数参数的行为。数据缓存在宿主内存里（见
 * host-cache.test.mjs），模块边界由 [代码结构](../../Docs/实现/代码结构.md) 持有。
 */
import assert from 'node:assert/strict';
import { parallel } from '../harness.mjs';
import {
	dropGraphWindows, dropRenderedGraph, rememberedMaxCommits,
	rememberPanelState, rememberedPanelState, rememberRepoInfo, rememberedRepoInfo, repoKeyOf,
} from '../../src/client/panel/graph-window-cache.ts';

/** 一个最小可用的面板状态。 */
function state(head = 'main') {
	return {
		phase: 'ready', entriesPhase: 'ready', error: null,
		commits: [], head, headHash: null, upstream: null, ahead: 0, behind: 0,
		more: false, nextSkip: 0, entries: [], entriesTruncated: false,
		selectedHash: null, detail: null, busy: [], remotes: [], foreignBranches: [], merging: false,
		background: [], lastRefreshAt: 0,
	};
}

/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('面板重挂载的渲染态', (t) => {
	t.test('记下的状态与提交数上限可按仓库取回', () => {
		const stored = state();
		rememberPanelState('/work/a', stored, 300);
		assert.equal(rememberedPanelState('/work/a'), stored, '重新挂载时首帧取回上次的面板状态');
		assert.equal(rememberedMaxCommits('/work/a'), 300, '提交数上限一并取回，宿主缓存键因此不变');
	});

	t.test('仓库键忽略大小写与尾分隔符', () => {
		rememberPanelState('E:/Repo/A', state('one'), 100);
		assert.equal(rememberedMaxCommits('e:/repo/a/'), 100, '尾分隔符与大小写不同仍是同一仓库');
		assert.equal(rememberedPanelState('E:/Repo/A'), rememberedPanelState('e:/repo/a'));
		assert.equal(repoKeyOf('E:/Repo/A/'), 'e:/repo/a');
	});

	t.test('从未渲染过的仓库取回 undefined', () => {
		assert.equal(rememberedPanelState('/work/never'), undefined);
		assert.equal(rememberedMaxCommits('/work/never'), undefined);
	});

	t.test('超出上限时按插入序淘汰最旧的仓库', () => {
		for (let index = 0; index < 20; index += 1) rememberPanelState(`/work/lru-${index}`, state(), index);
		assert.notEqual(rememberedPanelState('/work/lru-19'), undefined, '最新的仍在');
		assert.equal(rememberedPanelState('/work/lru-0'), undefined, '最旧的被淘汰');
	});

	t.test('dropGraphWindows 丢弃渲染态与已知仓库信息', () => {
		rememberPanelState('/work/b', state(), 50);
		rememberRepoInfo('/work/b', { remotes: [], stashes: [] });
		dropGraphWindows('/work/b');
		assert.equal(rememberedPanelState('/work/b'), undefined, '写操作后界面按新数据重建');
		assert.equal(rememberedRepoInfo('/work/b'), undefined, '贮藏与远程随写操作变化，一并作废');
	});

	t.test('dropRenderedGraph 只丢渲染态，已知仓库信息保留', () => {
		rememberPanelState('/work/c', state(), 50);
		const info = { remotes: [], stashes: [] };
		rememberRepoInfo('/work/c', info);
		dropRenderedGraph('/work/c');
		assert.equal(rememberedPanelState('/work/c'), undefined);
		assert.equal(rememberedRepoInfo('/work/c'), info, '换引用筛选不改变远程与贮藏');
	});
});
