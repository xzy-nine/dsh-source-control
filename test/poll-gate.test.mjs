/**
 * 轮询闸门测试：只有「变化已稳定」且距上次自动重载足够久才重载。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_REFRESH_INTERVAL_MS, shouldAutoRefresh } from '../src/client/panel/poll-gate.ts';

/** 一次判定。 */
const gate = (overrides) => shouldAutoRefresh({
	signature: 'a', lastSeen: 'a', loaded: 'b', lastRefreshAt: 0, now: AUTO_REFRESH_INTERVAL_MS, ...overrides,
});

test('变化仍在进行时不重载', () => {
	// 克隆中途：每轮签名都不同，一次也不应重载。
	assert.equal(gate({ signature: 'b', lastSeen: 'a' }), false);
});

test('首次轮询不重载：只有一次观测，无法判断是否稳定', () => {
	assert.equal(gate({ lastSeen: '' }), false);
});

test('连续两次看到同一份变化才重载', () => {
	assert.equal(gate({}), true);
});

test('签名与已加载的一致时不重载', () => {
	assert.equal(gate({ loaded: 'a' }), false);
});

test('距上次自动重载不足最小间隔时不重载', () => {
	// 上次重载发生在 1ms 前：本次与它的间隔是 59999ms，仍不足最小间隔。
	assert.equal(gate({ lastRefreshAt: 1 }), false);
	// 间隔正好达到最小间隔时放行。
	assert.equal(gate({ lastRefreshAt: 0 }), true);
});
