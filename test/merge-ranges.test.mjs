/**
 * 合并区间的模型测试：行差异、区间对齐、取舍与结果拼装。
 *
 * 判据取自 VS Code 合并编辑器的 ModifiedBaseRange：两侧差异在基线上相交或相邻即为
 * 同一段，否则各自成段；结果文档是选择表的纯映射。
 */
import assert from 'node:assert/strict';
import { parallel } from './harness.mjs';
import { analyzeMerge, diffLines, linesOf, resultLinesOf } from '../src/shared/merge-ranges.ts';

/** 造一份行文本。 */
const text = (...lines) => lines.join('\n') + '\n';

/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('合并区间', (t) => {
	t.test('切行：末尾换行不产生额外空行', () => {
		assert.deepEqual(linesOf('a\nb\n'), ['a', 'b']);
		assert.deepEqual(linesOf('a\nb'), ['a', 'b']);
		assert.deepEqual(linesOf(''), []);
	});

	t.test('行差异：单行替换', () => {
		const changes = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
		assert.deepEqual(changes, [{ baseStart: 1, baseLength: 1, otherStart: 1, otherLength: 1 }]);
	});

	t.test('行差异：纯插入与纯删除', () => {
		assert.deepEqual(diffLines(['a', 'c'], ['a', 'b', 'c']), [{ baseStart: 1, baseLength: 0, otherStart: 1, otherLength: 1 }]);
		assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c']), [{ baseStart: 1, baseLength: 1, otherStart: 1, otherLength: 0 }]);
	});

	t.test('行差异：内容相同没有区间', () => {
		assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), []);
	});

	t.test('行差异：两处相隔较远的改动各成一段', () => {
		const base = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
		const other = ['1', 'X', '3', '4', '5', '6', '7', '8', 'Y', '10'];
		const changes = diffLines(base, other);
		assert.equal(changes.length, 2);
		assert.deepEqual(changes.map((c) => c.baseStart), [1, 8]);
	});

	t.test('区间对齐：双方改同一处落进同一段，且标为冲突', () => {
		const analysis = analyzeMerge(
			text('a', 'b', 'c'),
			text('a', 'OURS', 'c'),
			text('a', 'THEIRS', 'c'),
		);
		assert.equal(analysis.ranges.length, 1);
		assert.equal(analysis.ranges[0].conflicting, true);
		assert.deepEqual(analysis.ranges[0].ours.lines, ['OURS']);
		assert.deepEqual(analysis.ranges[0].theirs.lines, ['THEIRS']);
	});

	t.test('区间对齐：只有一侧改动时不标为冲突', () => {
		const analysis = analyzeMerge(
			text('a', 'b', 'c'),
			text('a', 'OURS', 'c'),
			text('a', 'b', 'c'),
		);
		assert.equal(analysis.ranges.length, 1);
		assert.equal(analysis.ranges[0].conflicting, false);
		assert.equal(analysis.ranges[0].ours.changed, true);
		assert.equal(analysis.ranges[0].theirs.changed, false);
	});

	t.test('区间对齐：两处相隔较远的改动各自成段', () => {
		const base = text('1', '2', '3', '4', '5', '6', '7', '8', '9', '10');
		const ours = text('1', 'A', '3', '4', '5', '6', '7', '8', '9', '10');
		const theirs = text('1', '2', '3', '4', '5', '6', '7', '8', 'B', '10');
		const analysis = analyzeMerge(base, ours, theirs);
		assert.equal(analysis.ranges.length, 2, '两处改动互不相邻，必须各自成段');
		assert.equal(analysis.ranges[0].conflicting, false);
		assert.equal(analysis.ranges[1].conflicting, false);
	});

	t.test('取舍：一侧覆盖另一侧', () => {
		const analysis = analyzeMerge(text('a', 'b', 'c'), text('a', 'O', 'c'), text('a', 'T', 'c'));
		assert.deepEqual(resultLinesOf(analysis, new Map([[0, 'ours']])), ['a', 'O', 'c']);
		assert.deepEqual(resultLinesOf(analysis, new Map([[0, 'theirs']])), ['a', 'T', 'c']);
	});

	t.test('未处理的区间保留基线内容', () => {
		const analysis = analyzeMerge(text('a', 'b', 'c'), text('a', 'O', 'c'), text('a', 'T', 'c'));
		assert.deepEqual(resultLinesOf(analysis, new Map()), ['a', 'b', 'c'], '没有选择时结果等于基线');
	});

	t.test('多段各自取舍', () => {
		const base = text('1', '2', '3', '4', '5', '6', '7', '8', '9', '10');
		const ours = text('1', 'A', '3', '4', '5', '6', '7', '8', '9', '10');
		const theirs = text('1', '2', '3', '4', '5', '6', '7', '8', 'B', '10');
		const analysis = analyzeMerge(base, ours, theirs);
		const result = resultLinesOf(analysis, new Map([[0, 'ours'], [1, 'theirs']]));
		assert.deepEqual(result, ['1', 'A', '3', '4', '5', '6', '7', '8', 'B', '10']);
	});

	t.test('双方新增同一文件：基线为空也能处理', () => {
		const analysis = analyzeMerge('', text('OURS'), text('THEIRS'));
		assert.equal(analysis.ranges.length, 1);
		assert.equal(analysis.ranges[0].conflicting, true);
		assert.deepEqual(resultLinesOf(analysis, new Map([[0, 'theirs']])), ['THEIRS']);
	});
});
