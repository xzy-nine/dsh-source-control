/**
 * 行区间选择的测试：跨 hunk、跨折叠展开的未变更行都要能连成一个区间。
 *
 * 这是本插件接管选区的理由：forge 自带的选区只认 hunk 内的行，展开后的未变更行
 * 选不中，跨 hunk 的区间也会被整段拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const saved = {
	window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
	document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
};

const range = await import(pathToFileURL(join(root, 'src', 'client', 'diff', 'line-range.ts')).href);

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

test('手势由本插件接管，评论框仍用 forge 原生组件', () => {
	// forge 的选区只认 hunk 内的行，因此手势必须由本插件接管；
	// 但界面不复刻——评论框直接渲染 forge 的 ReviewComposer。
	const source = readFileSync(join(root, 'src', 'client', 'diff', 'forge-adapter.tsx'), 'utf8');
	const viewBlock = source.slice(source.indexOf('const view: DiffFileProps'));
	assert.ok(!/\breview:/.test(viewBlock), 'DiffFile 不应收到 review，行手势由本插件接管');
	assert.match(source, /selectableRows/, '应使用本插件的行选择');
	assert.match(source, /ReviewComposer/, '评论框应渲染 forge 的原生组件，而不是自建');
	assert.match(source, /actions: reviewActions/, '应把 forge 的评审动作面交给它的评论框');
	assert.ok(!/data-sc-selection/.test(source), '不应再有自建的选区确认栏');
});

test.after?.(() => {
	for (const [key, descriptor] of Object.entries(saved)) {
		if (descriptor === undefined) delete globalThis[key];
		else Object.defineProperty(globalThis, key, descriptor);
	}
	dom.window.close();
});
