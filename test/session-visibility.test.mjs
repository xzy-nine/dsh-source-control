/**
 * 会话可见性判定：`retainedBy.mainView` 是引用计数，不是布尔。
 *
 * 判据取自事故：AI 生成完成后不上屏，因为把计数当布尔比较（`=== true`）恒为假，
 * `onScreen` 永远不成立。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeWorkspaceOf, isSessionDisplayed } from '../src/client/panel/repo-preload.ts';
import { parallel } from './harness.mjs';

parallel('会话可见性', (t) => {
	t.test('引用计数大于 0 即视为正在显示', () => {
		assert.equal(isSessionDisplayed({ retainedBy: { mainView: 1 } }), true);
	});

	t.test('引用计数为 0 或缺失时不显示', () => {
		assert.equal(isSessionDisplayed({ retainedBy: { mainView: 0 } }), false);
		assert.equal(isSessionDisplayed({ retainedBy: {} }), false);
		assert.equal(isSessionDisplayed(undefined), false);
	});

	t.test('保留信息来源缺失时不算显示', () => {
		assert.equal(isSessionDisplayed(null), false);
		assert.equal(isSessionDisplayed({}), false);
	});

	t.test('活跃工作区：按传入顺序取第一个被主视图持有的会话', () => {
		const infos = [
			{ id: 's1', cwd: '/work/a' },
			{ id: 's2', cwd: '/work/b', retain: { retainedBy: { mainView: 1 } } },
			{ id: 's3', cwd: '/work/c', retain: { retainedBy: { mainView: 1 } } },
		];
		assert.deepEqual(activeWorkspaceOf(infos), { sessionId: 's2', cwd: '/work/b' });
	});

	t.test('活跃工作区：子代理会话与缺 cwd 的会话不产生工作区', () => {
		const infos = [
			{ id: 's1', cwd: '/work/a', retain: { retainedBy: { mainView: 1 } }, origin: 'subagent' },
			{ id: 's2', retain: { retainedBy: { mainView: 1 } } },
			{ id: 's3', cwd: '/work/c', retain: { retainedBy: { mainView: 1 } } },
		];
		assert.deepEqual(activeWorkspaceOf(infos), { sessionId: 's3', cwd: '/work/c' });
	});

	t.test('活跃工作区：没有正在显示的会话或输入缺失时为空', () => {
		assert.equal(activeWorkspaceOf([{ id: 's1', cwd: '/work/a' }]), null);
		assert.equal(activeWorkspaceOf([]), null);
		assert.equal(activeWorkspaceOf(null), null);
	});
});
