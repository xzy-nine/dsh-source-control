/**
 * ANSI 配色渲染测试。
 *
 * 覆盖 SGR 的颜色、加粗与复位；其它转义序列只丢弃，文本原样保留。
 */
import assert from 'node:assert/strict';
import { parallel } from '../harness.mjs';
import { parseAnsi } from '../../src/client/ui/ansi.ts';


/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('ANSI 配色', (t) => {
	t.test('无色文本是一段无样式片段', () => {
		assert.deepEqual(parseAnsi('plain'), [{ text: 'plain', style: {} }]);
		assert.deepEqual(parseAnsi(''), []);
	});

	t.test('gitee 横幅按颜色切开', () => {
		const chunks = parseAnsi("Hi \u001b[36;01myang(@xzy_nine)\u001b[0m! You've \u001b[32msuccessfully\u001b[0m authenticated.");
		assert.deepEqual(chunks, [
			{ text: 'Hi ', style: {} },
			{ text: 'yang(@xzy_nine)', style: { color: '#00cdcd', fontWeight: 600 } },
			{ text: "! You've ", style: {} },
			{ text: 'successfully', style: { color: '#00cd00' } },
			{ text: ' authenticated.', style: {} },
		]);
	});

	t.test('非 SGR 转义序列丢弃，文本照常保留', () => {
		assert.deepEqual(parseAnsi('a\u001b[2Kb'), [{ text: 'a', style: {} }, { text: 'b', style: {} }]);
	});

	t.test('背景色与样式复位', () => {
		assert.deepEqual(parseAnsi('\u001b[41;1mx\u001b[22;49my'), [
			{ text: 'x', style: { background: '#cd0000', fontWeight: 600 } },
			{ text: 'y', style: {} },
		]);
	});
});
