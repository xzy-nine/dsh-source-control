/**
 * 差异页视图选择：只剩自动换行，默认值与设置映射都要成立。
 *
 * 左右并排是唯一布局（中间要站一列分段暂存按钮），因此没有 split 这一项，
 * 持久化里的遗留 diffSplit 键被忽略。选择随设置持久化，这里断言的是纯映射。
 */
import assert from 'node:assert/strict';
import { DEFAULT_DIFF_VIEW, diffViewOf, withDiffView } from '../../src/client/diff/diff-view.ts';
import { defaultSettings } from '../../src/client/panel/settings-model.ts';
import { parallel } from '../harness.mjs';

/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('差异视图', (t) => {
	t.test('默认自动换行', () => {
		assert.deepEqual(DEFAULT_DIFF_VIEW, { wrap: true });
	});

	t.test('设置缺失时取默认值', () => {
		assert.deepEqual(diffViewOf(null), DEFAULT_DIFF_VIEW);
	});

	t.test('从设置里读出换行选择', () => {
		const settings = { ...defaultSettings(), diffWrap: false };
		assert.deepEqual(diffViewOf(settings), { wrap: false });
	});

	t.test('设置里缺换行项时按默认补齐', () => {
		// 缺少这一项的设置按默认补齐，不能落成「不换行」。
		const settings = { ...defaultSettings() };
		delete settings.diffWrap;
		assert.deepEqual(diffViewOf(settings), DEFAULT_DIFF_VIEW);
	});

	t.test('改写换行不影响其它设置', () => {
		const settings = { ...defaultSettings(), diffWrap: true };
		const next = withDiffView(settings, { wrap: false });
		assert.equal(next.diffWrap, false);
		assert.equal(next.autoRefresh, settings.autoRefresh, '只改换行时其它项保持原值');
	});

	t.test('默认设置里换行项已就位', () => {
		assert.equal(defaultSettings().diffWrap, true);
	});

});
