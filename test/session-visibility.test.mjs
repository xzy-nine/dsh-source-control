/**
 * 会话可见性判定：`retainedBy.mainView` 是引用计数，不是布尔。
 *
 * 判据取自事故：AI 生成完成后不上屏，因为把计数当布尔比较（`=== true`）恒为假，
 * `onScreen` 永远不成立。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionDisplayed } from '../src/client/panel/repo-preload.ts';
import { parallel } from './harness.mjs';

/** 造一份会话列表快照。 */
function list(byId, current) {
	return { ids: Object.keys(byId), byId, ...(current === undefined ? {} : { current }) };
}

parallel('会话可见性', (t) => {
	t.test('引用计数大于 0 即视为正在显示', () => {
		assert.equal(isSessionDisplayed(list({ s1: { cwd: '/a', retainedBy: { mainView: 1 } } }), 's1'), true);
	});

	t.test('引用计数为 0 或缺失时不显示', () => {
		assert.equal(isSessionDisplayed(list({ s1: { cwd: '/a', retainedBy: { mainView: 0 } } }), 's1'), false);
		assert.equal(isSessionDisplayed(list({ s1: { cwd: '/a', retainedBy: {} } }), 's1'), false);
		assert.equal(isSessionDisplayed(list({ s1: { cwd: '/a' } }), 's1'), false);
	});

	t.test('只有被引用的那个会话算显示', () => {
		const state = list({
			s1: { cwd: '/a', retainedBy: { mainView: 0 } },
			s2: { cwd: '/b', retainedBy: { mainView: 1 } },
		});
		assert.equal(isSessionDisplayed(state, 's1'), false);
		assert.equal(isSessionDisplayed(state, 's2'), true);
	});

	t.test('旧宿主以 current 为准', () => {
		const state = list({ s1: { cwd: '/a' }, s2: { cwd: '/b' } }, 's2');
		assert.equal(isSessionDisplayed(state, 's2'), true);
		assert.equal(isSessionDisplayed(state, 's1'), false);
	});

	t.test('快照缺失或为空时一律不算显示', () => {
		assert.equal(isSessionDisplayed(null, 's1'), false);
		assert.equal(isSessionDisplayed({}, 's1'), false);
	});
});
