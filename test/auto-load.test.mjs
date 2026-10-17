/**
 * 图形区自动加载更多的判定：`shouldLoadMore` 的三道闸门。
 *
 * 重点覆盖「页末不停翻页」的两种成因：容器已可滚动时仍自动续取，以及同一滚动位置
 * 被惯性滚动的后续事件反复触发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_LOAD_THRESHOLD, shouldLoadMore } from '../src/client/graph/auto-load.ts';

/** 构造一次判定输入。 */
const input = (overrides = {}) => ({
	hasMore: true,
	pending: false,
	metrics: { scrollHeight: 2000, scrollTop: 500, clientHeight: 600 },
	chain: false,
	lastLoadedAt: null,
	...overrides,
});

test('距底部超过阈值时不取', () => {
	// 内容 2000、视口 600、位置 500 → 距底 900，远大于阈值。
	assert.equal(shouldLoadMore(input()), false);
});

test('距底部不足阈值时取', () => {
	// 内容 2000、视口 600、位置 1350 → 距底 50。
	assert.equal(shouldLoadMore(input({ metrics: { scrollHeight: 2000, scrollTop: 1350, clientHeight: 600 } })), true);
});

test('没有更多或已有在途请求时不取', () => {
	const atBottom = { scrollHeight: 2000, scrollTop: 1350, clientHeight: 600 };
	assert.equal(shouldLoadMore(input({ metrics: atBottom, hasMore: false })), false);
	assert.equal(shouldLoadMore(input({ metrics: atBottom, pending: true })), false);
});

test('容器未挂载时不取', () => {
	assert.equal(shouldLoadMore(input({ metrics: null })), false);
});

test('同一滚动位置只触发一次', () => {
	const atBottom = { scrollHeight: 2000, scrollTop: 1350, clientHeight: 600 };
	assert.equal(shouldLoadMore(input({ metrics: atBottom, lastLoadedAt: 1350 })), false, '位置未变时不再取');
	assert.equal(shouldLoadMore(input({ metrics: atBottom, lastLoadedAt: 1200 })), true, '位置变化后可以再取');
});

test('续取只在内容未填满视口时发生', () => {
	/*
	 * 用户停在底部、内容已可滚动：取回一页后 `commits` 变化会触发一次续取。
	 * 此时若放行，就会一页接一页地连锁加载——这正是「始终停留在最后不停翻页」的成因。
	 */
	const scrollable = { scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 };
	assert.equal(shouldLoadMore(input({ metrics: scrollable, chain: true })), false, '容器可滚动时不续取');

	// 首屏内容不足一屏：仍需要续取直到填满。
	const notFilled = { scrollHeight: 300, scrollTop: 0, clientHeight: 600 };
	assert.equal(shouldLoadMore(input({ metrics: notFilled, chain: true })), true, '填不满视口时续取');
});

test('续取不受滚动位置闸门约束', () => {
	// 续取是程序发起的，同一位置也应当补足；位置闸门只拦用户滚动。
	const notFilled = { scrollHeight: 300, scrollTop: 0, clientHeight: 600 };
	assert.equal(shouldLoadMore(input({ metrics: notFilled, chain: true, lastLoadedAt: 0 })), true);
});

test('阈值与边界一致', () => {
	const exactly = { scrollHeight: 2000, scrollTop: 2000 - 600 - AUTO_LOAD_THRESHOLD, clientHeight: 600 };
	assert.equal(shouldLoadMore(input({ metrics: exactly })), true, '正好等于阈值时取');
	const beyond = { ...exactly, scrollTop: exactly.scrollTop - 1 };
	assert.equal(shouldLoadMore(input({ metrics: beyond })), false, '超出阈值 1 像素即不取');
});
