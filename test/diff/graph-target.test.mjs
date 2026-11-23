/**
 * 提交图定位的纯计算：目标提交的取法与推进判据。
 *
 * 定位分两步——目标在已加载窗口之外时先补齐（当前分支落后于上游时，HEAD 之前可以排着几百条
 * 别的分支的提交），加载到之后再滚动。这里覆盖两步的分界与目标自身的取法。
 */
import assert from 'node:assert/strict';
import { headTargetOf, jumpStepOf } from '../../src/client/panel/graph-target.ts';
import { parallel } from '../harness.mjs';

/** 造一条提交。 */
const commit = (hash, heads = []) => ({ hash, heads, parents: [] });

/** 未提交伪提交行。 */
const uncommitted = () => commit('*');


/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('定位目标', (t) => {
	t.test('快照给出的 HEAD 哈希优先于列表里的分支名', () => {
		const commits = [commit('newest', ['other']), commit('head1', ['main'])];
		assert.equal(headTargetOf(commits, 'main', 'detached'), 'detached');
	});

	t.test('没有快照值时按当前分支名找', () => {
		const commits = [commit('newest', ['other']), commit('head1', ['main']), commit('old')];
		assert.equal(headTargetOf(commits, 'main', null), 'head1');
	});

	t.test('分离头指针且没有快照值时退回最新的一条真实提交', () => {
		const commits = [uncommitted(), commit('newest'), commit('old')];
		assert.equal(headTargetOf(commits, null, null), 'newest');
	});

	t.test('没有可用的目标时返回 null', () => {
		assert.equal(headTargetOf([], null, null), null, '列表为空');
		assert.equal(headTargetOf([uncommitted()], null, null), null, '只有未提交行');
		assert.equal(headTargetOf([commit('a')], 'main', ''), 'a', '空字符串按缺席处理');
	});
});

parallel('定位推进', (t) => {
	const commits = [commit('newest'), commit('old')];

	t.test('目标已加载即滚动，不再取数', () => {
		assert.equal(jumpStepOf('old', commits, true, false), 'scroll');
		assert.equal(jumpStepOf('old', commits, false, false), 'scroll', '有没有更多提交不影响已加载的目标');
	});

	t.test('目标未加载且还有更早的提交：先翻页', () => {
		assert.equal(jumpStepOf('older', commits, true, false), 'page');
	});

	t.test('已为这份列表取过：等这一页回来，不再重复取', () => {
		assert.equal(jumpStepOf('older', commits, true, true), 'wait');
	});

	t.test('目标未加载且没有更多提交：停下', () => {
		assert.equal(jumpStepOf('older', commits, false, false), 'stop');
		assert.equal(jumpStepOf('older', commits, false, true), 'stop');
	});
});
