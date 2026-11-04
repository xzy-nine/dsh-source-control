/**
 * 差异页视图选择：默认值、设置到选择的映射、改写一项。
 *
 * 选择是面板设置的一部分，因此这里断言的是纯映射，不涉及存储；持久化由设置那一套负责。
 */
import assert from 'node:assert/strict';
import { DEFAULT_DIFF_VIEW, diffViewOf, withDiffView } from '../src/client/diff/diff-view.ts';
import { defaultSettings } from '../src/client/panel/settings-model.ts';
import { parallel } from './harness.mjs';

/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('差异视图', (t) => {
	t.test('默认左右并排且自动换行', () => {
		assert.deepEqual(DEFAULT_DIFF_VIEW, { split: true, wrap: true });
	});

	t.test('设置缺失时取默认值', () => {
		assert.deepEqual(diffViewOf(null), DEFAULT_DIFF_VIEW);
	});

	t.test('从设置里读出选择', () => {
		const settings = { ...defaultSettings(), diffSplit: false, diffWrap: false };
		assert.deepEqual(diffViewOf(settings), { split: false, wrap: false });
	});

	t.test('设置里缺这两项时按默认补齐', () => {
		// 旧版设置没有这两个字段：升级后不能变成「都不开」。
		const settings = { ...defaultSettings() };
		delete settings.diffSplit;
		delete settings.diffWrap;
		assert.deepEqual(diffViewOf(settings), DEFAULT_DIFF_VIEW);
	});

	t.test('改写一项不影响另一项', () => {
		const settings = { ...defaultSettings(), diffSplit: true, diffWrap: true };
		const next = withDiffView(settings, { split: false });
		assert.equal(next.diffSplit, false);
		assert.equal(next.diffWrap, true, '只改 split 时 wrap 保持原值');
		assert.deepEqual(diffViewOf(next), { split: false, wrap: true });
	});

	t.test('默认设置里这两项已就位', () => {
		const settings = defaultSettings();
		assert.equal(settings.diffSplit, true);
		assert.equal(settings.diffWrap, true);
	});
});
