/**
 * 后台刷新的状态与提示：登记/移除、进行中标志、相对时间文案与告知判据。
 *
 * 纯函数层，无 React 依赖。面板状态只构造本模块用到的字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	backgroundFlagsOf, beginBackground, endBackground, lastRefreshText, refreshNoticeOf, refreshNoticeSince,
} from '../src/client/panel/refresh-status.ts';

/** 构造一个只含本模块所需字段的面板状态。 */
const stateOf = (background = [], lastRefreshAt = 0) => ({
	phase: 'ready', error: null, commits: [], head: null, more: false, nextSkip: 0,
	entries: [], selectedHash: null, detail: null, busy: [], remotes: [], foreignBranches: [],
	merging: false, background, lastRefreshAt,
});

test('登记后台刷新：同一作用面只保留一份', () => {
	const once = beginBackground(stateOf(), 'graph', 1000);
	assert.deepEqual(once.background, [{ scope: 'graph', at: 1000 }]);
	// 已在刷新时原样返回：并发刷新共用一条指示。
	assert.equal(beginBackground(once, 'graph', 2000), once);
	// 不同作用面各记一份。
	const both = beginBackground(once, 'entries', 3000);
	assert.equal(both.background.length, 2);
});

test('移除后台刷新：按作用面移除并写入完成时刻', () => {
	const state = beginBackground(beginBackground(stateOf(), 'graph', 1000), 'entries', 1000);
	const settled = endBackground(state, 'graph', 5000);
	assert.deepEqual(settled.background, [{ scope: 'entries', at: 1000 }]);
	assert.equal(settled.lastRefreshAt, 5000);
	// 完成时刻不回退：乱序完成时保留较晚的一个。
	const later = endBackground(settled, 'entries', 4000);
	assert.equal(later.lastRefreshAt, 5000);
});

test('移除后台刷新：该作用面未在刷新时仍写入完成时刻', () => {
	const settled = endBackground(stateOf(), 'entries', 7000);
	assert.deepEqual(settled.background, []);
	assert.equal(settled.lastRefreshAt, 7000);
});

test('进行中标志：按作用面分别给出', () => {
	assert.deepEqual(backgroundFlagsOf([]), { graph: false, entries: false });
	assert.deepEqual(backgroundFlagsOf([{ scope: 'graph', at: 1 }]), { graph: true, entries: false });
	assert.deepEqual(
		backgroundFlagsOf([{ scope: 'graph', at: 1 }, { scope: 'entries', at: 2 }]),
		{ graph: true, entries: true },
	);
});

test('相对时间文案：分档给出，从未刷新为空串', () => {
	assert.equal(lastRefreshText(0, 100_000), '');
	assert.equal(lastRefreshText(99_000, 100_000), '刚刚');
	assert.equal(lastRefreshText(40_000, 100_000), '1 分钟前');
	// at 为 0 表示从未刷新，任何当前时刻都给出空串。
	assert.equal(lastRefreshText(0, 20 * 60_000), '');
	assert.equal(lastRefreshText(1, 20 * 60_000 + 1), '20 分钟前');
	assert.equal(lastRefreshText(1, 3 * 3_600_000 + 1), '3 小时前');
	// 时钟回拨（系统时间被改）时不给负值文案。
	assert.equal(lastRefreshText(200_000, 100_000), '刚刚');
});

/** 构造一轮后台刷新的基线。 */
const baselineOf = (overrides = {}) => ({
	at: 1000, scope: 'repo|main|200', ready: true, entries: 3, commits: 10, ...overrides,
});

test('告知判据：只在计数变化时给出文案', () => {
	const same = { entries: 3, commits: 10 };
	assert.equal(refreshNoticeOf(same, same), '');
	assert.equal(refreshNoticeOf(same, { entries: 5, commits: 10 }), '已更新：工作区 +2 个改动');
	assert.equal(refreshNoticeOf(same, { entries: 3, commits: 15 }), '已更新：提交图 +5 个提交');
	assert.equal(refreshNoticeOf(same, { entries: 3, commits: 7 }), '已更新：提交图 -3 个提交');
	assert.equal(
		refreshNoticeOf(same, { entries: 1, commits: 20 }),
		'已更新：工作区 -2 个改动，提交图 +10 个提交',
	);
});

test('告知基线：同范围的相邻两轮按变化量给出文案', () => {
	assert.equal(refreshNoticeSince(baselineOf(), baselineOf({ at: 2000, entries: 4 })), '已更新：工作区 +1 个改动');
	assert.equal(refreshNoticeSince(baselineOf(), baselineOf({ at: 2000 })), '');
});

test('告知基线：换仓库、换引用起点、换窗口与未就绪的轮次不比较', () => {
	// 首次进入没有上一轮基线。
	assert.equal(refreshNoticeSince(null, baselineOf()), '');
	// 换仓库或换引用起点：两份提交列表不是同一批数据。
	assert.equal(refreshNoticeSince(baselineOf(), baselineOf({ scope: 'other|main|200' })), '');
	// 加载更多后窗口不同：提交数差值来自翻页，不是新提交。
	assert.equal(refreshNoticeSince(baselineOf(), baselineOf({ scope: 'repo|main|400', commits: 410 })), '');
	// 任一轮仍在加载：计数是中间态。
	assert.equal(refreshNoticeSince(baselineOf({ ready: false }), baselineOf({ commits: 12 })), '');
	assert.equal(refreshNoticeSince(baselineOf(), baselineOf({ ready: false, commits: 12 })), '');
});
