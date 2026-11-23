/**
 * 行区间选择的测试：跨 hunk、跨折叠展开的未变更行都要能连成一个区间。
 *
 * 这是本插件接管选区的理由：forge 自带的选区只认 hunk 内的行，展开后的未变更行
 * 选不中，跨 hunk 的区间也会被整段拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../..', import.meta.url);
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const saved = {
	window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
	document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
};

const range = await import(new URL('src/client/diff/line-range.ts', root).href);

/**
 * 造一个视图骨架：两行统一行、一个折叠按钮、再两行统一行、一个并排配对行。
 * 折叠按钮没有行号，代表展开前的未变更行；展开后它会被替换成带行号的普通行。
 *
 * @param document - 当前 DOM 文档。
 * @returns 视图根元素。
 */
function buildHost(document) {
	const host = document.createElement('div');
	const row = (oldNo, newNo) => {
		const element = document.createElement('div');
		element.setAttribute('data-diff-line', 'context');
		const old = document.createElement('span');
		old.setAttribute('data-old-line', String(oldNo));
		const next = document.createElement('span');
		next.setAttribute('data-new-line', String(newNo));
		element.append(old, next);
		return element;
	};
	const gap = document.createElement('button');
	gap.setAttribute('data-forge-diff-gap', '0');
	host.append(row(10, 10), row(11, 11), gap, row(30, 31), row(null, 32));
	// 一个并排配对行：两侧同处一行。
	const pair = document.createElement('div');
	pair.setAttribute('data-diff-pair', 'change');
	const left = document.createElement('span');
	left.setAttribute('data-old-line', '33');
	const right = document.createElement('span');
	right.setAttribute('data-new-line', '34');
	pair.append(left, right);
	host.append(pair);
	return host;
}

Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });

test('折叠按钮不算可选择的行', () => {
	const host = buildHost(dom.window.document);
	const rows = range.selectableRows(host);
	assert.equal(rows.length, 5, '两行 + 两行 + 一个配对行；折叠按钮不计入');
});

test('跨 hunk 的区间连成一片', () => {
	const host = buildHost(dom.window.document);
	const rows = range.selectableRows(host);
	// 第 0 行（10）到第 2 行（31）：中间隔着折叠按钮与一个 hunk 边界。
	const picked = range.rangeBetween(rows, 0, 2);
	assert.deepEqual(picked, { side: 'R', startLine: 10, endLine: 31 });
});

test('整段方法体跨 hunk 时取到首尾', () => {
	const host = buildHost(dom.window.document);
	const rows = range.selectableRows(host);
	const picked = range.rangeBetween(rows, 1, 4);
	assert.equal(picked.startLine, 11);
	assert.equal(picked.endLine, 34);
});

test('反向拖动与正向拖动结果一致', () => {
	const host = buildHost(dom.window.document);
	const rows = range.selectableRows(host);
	assert.deepEqual(range.rangeBetween(rows, 2, 0), range.rangeBetween(rows, 0, 2));
});

test('只有旧侧行号时退回旧侧', () => {
	const host = buildHost(dom.window.document);
	// 把最后两行改成只有旧侧行号。
	for (const element of host.querySelectorAll('[data-new-line]')) element.removeAttribute('data-new-line');
	const rows = range.selectableRows(host);
	const picked = range.rangeBetween(rows, 0, 1);
	assert.equal(picked.side, 'L');
	assert.equal(picked.startLine, 10);
	assert.equal(picked.endLine, 11);
});

test('标记只落在区间内的行上', () => {
	const host = buildHost(dom.window.document);
	const rows = range.selectableRows(host);
	range.markRange(rows, 1, 2);
	assert.equal(rows.filter((row) => row.hasAttribute('data-sc-range')).length, 2);
	range.markRange(rows, null, null);
	assert.equal(rows.filter((row) => row.hasAttribute('data-sc-range')).length, 0);
});

test('正文拖动交给浏览器，行号列才起手选行', () => {
	const host = buildHost(dom.window.document);
	const [first] = range.selectableRows(host);
	// 行内两格：行号（只放数字）与正文（带 data-review-code）。
	const gutter = dom.window.document.createElement('span');
	gutter.textContent = '10';
	const code = dom.window.document.createElement('span');
	code.setAttribute('data-review-code', '');
	code.textContent = 'const a = 1';
	first.append(gutter, code);

	assert.equal(range.gutterPressed(gutter, first), true, '按在行号数字上应起手选行');
	assert.equal(range.gutterPressed(code, first), false, '按在正文里应交给浏览器的文本选区');
	// 行内容的子节点（高亮会把它切成很多片段）属于正文。
	const token = dom.window.document.createElement('span');
	token.textContent = 'const';
	code.replaceChildren(token);
	assert.equal(range.gutterPressed(token, first), false, '正文里的高亮片段仍属正文');
});

test('合并视图的行号带标记，按在行号上即选行', () => {
	const host = buildHost(dom.window.document);
	const [first] = range.selectableRows(host);
	const gutter = dom.window.document.createElement('span');
	gutter.setAttribute('data-sc-line-no', '');
	gutter.textContent = '7';
	gutter.setAttribute('data-ours-line', '7');
	first.append(gutter);
	assert.equal(range.gutterPressed(gutter, first), true, '带 data-sc-line-no 就算行号列');
});

test('行号列以外的纯文字不起手选行', () => {
	const host = buildHost(dom.window.document);
	const [first] = range.selectableRows(host);
	const text = dom.window.document.createElement('span');
	text.textContent = 'hello';
	first.append(text);
	assert.equal(range.gutterPressed(text, first), false, '正文文字不触发选行');
});

test.after?.(() => {
	for (const [key, descriptor] of Object.entries(saved)) {
		if (descriptor === undefined) delete globalThis[key];
		else Object.defineProperty(globalThis, key, descriptor);
	}
	dom.window.close();
});
