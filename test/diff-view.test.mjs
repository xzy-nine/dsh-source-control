/**
 * 差异页视图选择的测试：按地址记忆、默认值、覆盖写入。
 */
import assert from 'node:assert/strict';
import { readDiffView, writeDiffView } from '../src/client/diff/diff-view.ts';
import { parallel } from './harness.mjs';

const ADDRESS = 'dsh-resource://git-diff/session/s1/*/src/a.ts';


/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('差异视图', (t) => {
	t.test('没有记录时返回默认选择', () => {
		assert.deepEqual(readDiffView(ADDRESS), { split: true, wrap: true });
	});

	t.test('写入后按地址读回', () => {
		writeDiffView(ADDRESS, { split: false, wrap: false });
		assert.deepEqual(readDiffView(ADDRESS), { split: false, wrap: false });
	});

	t.test('不同地址互不影响', () => {
		writeDiffView('dsh-resource://git-diff/session/s1/*/src/a.ts', { split: false, wrap: true });
		assert.deepEqual(readDiffView('dsh-resource://git-diff/session/s1/*/src/b.ts'), { split: true, wrap: true });
	});

	t.test('再次写入覆盖先前选择', () => {
		writeDiffView('dsh-resource://git-diff/session/s1/*/src/c.ts', { split: false, wrap: false });
		writeDiffView('dsh-resource://git-diff/session/s1/*/src/c.ts', { split: true, wrap: false });
		assert.deepEqual(readDiffView('dsh-resource://git-diff/session/s1/*/src/c.ts'), { split: true, wrap: false });
	});
});
