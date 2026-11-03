/**
 * 面板状态的合并契约：变更列表那一路的就绪阶段与提交图分开。
 *
 * 判据取自界面行为：一次刷新里提交图与工作区快照并行发出，快照通常先回。共用一个阶段会让
 * 更改区陪着提交图一起显示占位 —— 提交图被慢操作挡住时，已经取到的变更列表也画不出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshot } from '../src/client/panel/graph-state.ts';
import { parallel } from './harness.mjs';

/** 一个最小可用的面板状态。 */
function makeState(overrides = {}) {
	return {
		phase: 'loading', entriesPhase: 'loading', error: null,
		commits: [], head: 'main', headHash: null, upstream: null, ahead: 0, behind: 0,
		more: false, nextSkip: 0, entries: [], entriesTruncated: false,
		selectedHash: null, detail: null, busy: [], remotes: [], foreignBranches: [], merging: false,
		background: [], lastRefreshAt: 0,
		...overrides,
	};
}

/** 一份工作区快照。 */
function makeSnapshot(overrides = {}) {
	return {
		entries: [], head: 'aaa', branch: 'main', upstream: null, ahead: 0, behind: 0,
		merging: false, truncated: false, ...overrides,
	};
}

parallel('面板状态合并', (t) => {
	t.test('快照落地即把变更列表那一路置为就绪，提交图仍是加载中', () => {
		const merged = mergeSnapshot(makeState(), makeSnapshot());
		assert.equal(merged.entriesPhase, 'ready', '手里已有快照，变更列表就是就绪的');
		assert.equal(merged.phase, 'loading', '提交图是否就绪由另一路决定，不受这里影响');
	});

	t.test('快照写入不改提交图阶段', () => {
		const merged = mergeSnapshot(makeState({ phase: 'ready' }), makeSnapshot());
		assert.equal(merged.phase, 'ready');
		assert.equal(merged.entriesPhase, 'ready');
	});

	t.test('条目未变时保持原引用', () => {
		const entries = [{ path: 'a.txt', origPath: null, index: ' ', worktree: 'M' }];
		const merged = mergeSnapshot(makeState({ entries }), makeSnapshot({ entries }));
		assert.equal(merged.entries, entries, '未变的条目复用同一数组，更改区的树计算因此不重算');
	});

	t.test('条目变化时换新数组', () => {
		const before = [{ path: 'a.txt', origPath: null, index: ' ', worktree: 'M' }];
		const after = [{ path: 'b.txt', origPath: null, index: ' ', worktree: 'M' }];
		const merged = mergeSnapshot(makeState({ entries: before }), makeSnapshot({ entries: after }));
		assert.deepEqual(merged.entries.map((entry) => entry.path), ['b.txt']);
	});
});
