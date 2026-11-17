/**
 * 分段暂存轨道的几何：把补丁块落到它在正文里的实际位置。
 *
 * 位置与高度都从渲染结果量出——并排布局把一串删除行与新增行配成一行、自动换行又把
 * 一行撑成多行，因此按行数推算是错的。这里用 jsdom 造出带行号的骨架来验证判据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { JSDOM } = await import('jsdom');
const { hunkSlots } = await import('../src/client/diff/hunk-lane.ts');

/** 造一个正文容器：每行带两侧行号，行高固定 22。
 *
 * @param document - 当前 DOM 文档。
 * @param numbers - 每行的 [旧侧, 新侧] 行号。
 * @returns 容器元素。
 */
function buildBody(document, numbers) {
	const host = document.createElement('div');
	for (const [oldNo, newNo] of numbers) {
		const row = document.createElement('div');
		row.setAttribute('data-diff-line', 'context');
		const old = document.createElement('span');
		old.setAttribute('data-old-line', String(oldNo));
		const next = document.createElement('span');
		next.setAttribute('data-new-line', String(newNo));
		row.append(old, next);
		host.append(row);
	}
	// jsdom 不做布局：按 22 行高给出几何，容器从 0 起。
	const posed = [...host.children];
	host.getBoundingClientRect = () => ({ top: 0, bottom: posed.length * 22, left: 0, right: 600, width: 600, height: posed.length * 22 });
	for (const [index, row] of posed.entries()) {
		const top = index * 22;
		row.getBoundingClientRect = () => ({ top, bottom: top + 22, left: 0, right: 600, width: 600, height: 22 });
	}
	return host;
}

/** 两个补丁块：首块从新侧第 10 行起，次块从新侧第 30 行起。 */
const HUNKS = [
	{ index: 0, header: '@@ -10,2 +10,2 @@', oldStart: 10, oldLines: 2, newStart: 10, newLines: 2 },
	{ index: 1, header: '@@ -30,1 +30,1 @@', oldStart: 30, oldLines: 1, newStart: 30, newLines: 1 },
];

test('块的位置取首行的实际偏移', () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	// 第 0、1 行是首块；第 2 行是折叠区展开的未变更行；第 3 行是次块。
	const body = buildBody(dom.window.document, [[10, 10], [11, 11], [12, 12], [30, 30]]);
	globalThis.document = dom.window.document;
	const slots = hunkSlots(body, HUNKS);
	assert.equal(slots.length, 2);
	assert.equal(slots[0].index, 0);
	assert.equal(slots[0].top, 0, '首块从正文顶端开始');
	assert.equal(slots[0].height, 66, '首块的高度到次块首行为止，含折叠区');
	assert.equal(slots[1].index, 1);
	assert.equal(slots[1].top, 66, '次块贴着它自己的首行');
	assert.equal(slots[1].height, 22, '末块到正文末尾');
	dom.window.close();
});

test('纯删除的块按旧侧行号定位', () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	const body = buildBody(dom.window.document, [[10, 10], [11, 11]]);
	globalThis.document = dom.window.document;
	// newLines 为 0 的块只存在于旧侧。
	const slots = hunkSlots(body, [{ index: 0, header: '@@ -11,1 +0,0 @@', oldStart: 11, oldLines: 1, newStart: 0, newLines: 0 }]);
	assert.equal(slots.length, 1);
	assert.equal(slots[0].top, 22, '按旧侧第 11 行找到第二行');
	dom.window.close();
});

test('没有块或没有行时不产生落位', () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	const empty = buildBody(dom.window.document, []);
	assert.deepEqual(hunkSlots(empty, HUNKS), [], '没有可选择的行时给空表');
	assert.deepEqual(hunkSlots(empty, []), [], '没有块时给空表');
	assert.deepEqual(hunkSlots(null, HUNKS), [], '容器缺失时给空表');
	dom.window.close();
});
