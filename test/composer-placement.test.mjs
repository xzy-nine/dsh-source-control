/**
 * 评论浮窗落位的测试：避开选区、贴边翻转、钳进视口。
 *
 * 浮窗按 fixed 定位，滚动视口与文件段的裁切都碰不到它；但位置要自己算，
 * 因此这里用假的行矩形覆盖「期望侧放得下」「放不下要翻」「两侧都紧张」三种情形。
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

const placement = await import(pathToFileURL(join(root, 'src', 'client', 'diff', 'composer-placement.ts')).href);

/**
 * 造一个外层与若干行，按给定的纵向位置摆放。
 *
 * @param rows - 每行的 `[top, bottom]`。
 * @param hostBox - 外层的矩形。
 * @returns 外层与行元素。
 */
function build(rows, hostBox = { left: 100, top: 0, width: 600, height: 2000 }) {
	const host = dom.window.document.createElement('div');
	const elements = rows.map(([top, bottom]) => {
		const row = dom.window.document.createElement('div');
		row.getBoundingClientRect = () => ({ left: 100, top, width: 600, height: bottom - top, bottom, right: 700 });
		host.append(row);
		return row;
	});
	host.getBoundingClientRect = () => ({ ...hostBox, bottom: hostBox.top + hostBox.height, right: hostBox.left + hostBox.width });
	return { host, rows: elements };
}

const VIEWPORT = { width: 1000, height: 800 };

test('向下拖：空间够时浮在选区上方并留出间隙', () => {
	const { host, rows } = build([[300, 322], [322, 344], [344, 366]]);
	const box = placement.placeComposer({
		host, rows, range: { low: 0, high: 2 }, forward: true, height: 200, viewport: VIEWPORT,
	});
	assert.equal(box.side, 'above');
	// 选区上缘 300，减间隙 8、自身 200。
	assert.equal(box.top, 300 - 8 - 200);
	assert.equal(box.left, 100 + 8);
	assert.equal(box.width, 600 - 16);
});

test('向上拖：空间够时浮在选区下方', () => {
	const { host, rows } = build([[100, 122], [122, 144], [144, 166]]);
	const box = placement.placeComposer({
		host, rows, range: { low: 0, high: 2 }, forward: false, height: 200, viewport: VIEWPORT,
	});
	assert.equal(box.side, 'below');
	assert.equal(box.top, 166 + 8);
});

test('期望侧完全放不下时才翻到另一侧', () => {
	// 选区贴视口顶端：上方连最小可用高度都没有，向下拖也只能翻到下方。
	const { host, rows } = build([[10, 32], [32, 54]]);
	const box = placement.placeComposer({
		host, rows, range: { low: 0, high: 1 }, forward: true, height: 200, viewport: VIEWPORT,
	});
	assert.equal(box.side, 'below');
	assert.equal(box.top, 54 + 8);
});

test('期望侧紧张但可用时不翻侧，改为内部滚动', () => {
	// 上方可用 150px：不够期望的 200，但超过最小可用高度，应保持方向并压缩高度。
	const { host, rows } = build([[166, 188], [188, 210]]);
	const box = placement.placeComposer({
		host, rows, range: { low: 0, high: 1 }, forward: true, height: 200, viewport: VIEWPORT,
	});
	assert.equal(box.side, 'above', '用户用拖动方向表达了意图，能放下就不翻');
	assert.ok(box.maxHeight <= VIEWPORT.height - 8 - box.top, '高度上限由视口剩余空间决定，内容在浮窗内部滚动');
	assert.ok(box.top >= 8, '上边不越过视口留白');
});

test('两侧都紧张时仍整块落在视口内', () => {
	// 选区占满整个视口高度，两侧都没有 200px。
	const { host, rows } = build([[0, 400], [400, 800]]);
	const box = placement.placeComposer({
		host, rows, range: { low: 0, high: 1 }, forward: true, height: 200, viewport: VIEWPORT,
	});
	assert.ok(box.top >= 8, '上边不越过视口留白');
	assert.ok(box.top + box.maxHeight <= VIEWPORT.height - 8 + 1, '高度上限把下边钳在视口内');
	assert.ok(box.maxHeight >= 120, '至少留出可用的输入高度');
});

test('高度上限不超过视口可用空间', () => {
	const { host, rows } = build([[600, 622]]);
	const box = placement.placeComposer({
		host, rows, range: { low: 0, high: 0 }, forward: false, height: 200, viewport: VIEWPORT,
	});
	assert.ok(box.top + box.maxHeight <= VIEWPORT.height - 8 + 1, '浮窗不会溢出视口底边');
});

test('区间末端尚未渲染时不给位置', () => {
	const { host, rows } = build([[10, 32]]);
	const box = placement.placeComposer({
		host, rows, range: { low: 0, high: 5 }, forward: true, height: 200, viewport: VIEWPORT,
	});
	assert.equal(box, null);
});

test('浮窗用 fixed 定位，脱离会裁切的祖先', () => {
	// 滚动视口是 overflow:auto、文件段是 overflow:clip，absolute 贴边必被裁。
	const cssSource = readFileSync(join(root, 'src', 'client', 'css', 'forge-adapter.module.css'), 'utf8');
	const rule = /\.floating\{[^}]*\}/.exec(cssSource);
	assert.ok(rule !== null, '应存在浮窗样式');
	assert.match(rule[0], /position:fixed/, '浮窗必须 fixed 定位，才能不被滚动视口与文件段裁掉');
});
