/**
 * AI 提交请求的组装：被合并入的提交、二进制清单、diff 三段顺序与丢弃说明。
 *
 * 请求文本直接决定模型看到什么，顺序与缺省因此按行为断言而不是看源码。
 */
import assert from 'node:assert/strict';
import { importHostModule } from './lib-import.mjs';
import { parallel } from './harness.mjs';

const { buildCommitRequest, droppedNotice, DROPPED_LIST_MAX } = await importHostModule('source-control/ai-commit-request.js');

/** 一份只有 diff 的收集结果。 */
const base = { diff: 'diff --git a/a.ts b/a.ts\n+1\n', binary: [], merged: [], dropped: [] };

/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('AI 提交请求组装', (t) => {
	t.test('普通提交只含 diff 段', () => {
		const text = buildCommitRequest(base, false);
		assert.ok(text.includes('diff --git a/a.ts b/a.ts'), '应含 diff');
		assert.ok(!text.includes('被合并入的提交'), '非合并提交不应有合并段');
		assert.ok(!text.includes('二进制文件'), '无二进制时不应有清单段');
	});

	t.test('合并提交：被合并入的提交排在 diff 之前', () => {
		const text = buildCommitRequest({
			...base,
			merged: [{ hash: 'abc1234', body: 'feat: 分支提交' }],
		}, false);
		const mergedAt = text.indexOf('abc1234');
		const diffAt = text.indexOf('diff --git');
		assert.ok(mergedAt >= 0, '应含短哈希');
		assert.ok(text.includes('feat: 分支提交'), '应含被合并提交的完整信息');
		assert.ok(mergedAt < diffAt, '合并段应排在 diff 之前');
	});

	t.test('多个被合并入的提交逐条列出', () => {
		const text = buildCommitRequest({
			...base,
			merged: [
				{ hash: 'aaaaaaa', body: 'feat: 一' },
				{ hash: 'bbbbbbb', body: 'fix: 二' },
			],
		}, false);
		assert.ok(text.includes('aaaaaaa'), '应列出第一个提交');
		assert.ok(text.includes('bbbbbbb'), '应列出第二个提交');
	});

	t.test('二进制文件只给文件名，排在 diff 之前', () => {
		const text = buildCommitRequest({ ...base, binary: ['img.png', 'font.woff2'] }, false);
		assert.ok(text.includes('img.png') && text.includes('font.woff2'), '应列出二进制文件名');
		assert.ok(text.indexOf('img.png') < text.indexOf('diff --git'), '清单段应排在 diff 之前');
	});

	t.test('修补上一次提交用修补模板', () => {
		const text = buildCommitRequest(base, true);
		assert.ok(text.includes('修补上一次提交'), '应使用 requestAmend 模板');
	});

	t.test('丢弃说明列出被丢弃的文件', () => {
		const notice = droppedNotice([
			{ path: 'a.md', reason: 'document' },
			{ path: 'b.ts', reason: 'budget' },
		]);
		assert.ok(notice.includes('a.md') && notice.includes('b.ts'), '应列出文件名');
		assert.ok(notice.includes('2'), '应给出总数');
	});

	t.test('丢弃说明在超出列举上限时只列前一部分并给出总数', () => {
		const dropped = Array.from({ length: DROPPED_LIST_MAX + 5 }, (_, at) => ({ path: `f${String(at)}.ts`, reason: 'budget' }));
		const notice = droppedNotice(dropped);
		assert.ok(notice.includes('f0.ts'), '应列出前一部分');
		assert.ok(!notice.includes(`f${String(DROPPED_LIST_MAX + 4)}.ts`), '超出上限的文件不逐个列出');
		assert.ok(notice.includes(String(DROPPED_LIST_MAX + 5)), '应给出总数');
	});

	t.test('没有丢弃时不产生说明', () => {
		assert.equal(droppedNotice([]), '');
	});
});
