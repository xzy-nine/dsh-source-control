/**
 * 右键菜单边缘避让的测试。
 *
 * 重点：菜单高度必须参与计算——只夹住底边而不减去菜单高度，靠近屏幕底部的菜单
 * 会溢出视口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeMenu, placeSubmenu, MENU_MARGIN, SUBMENU_GAP } from '../src/client/menu-placement.ts';

/** 常见视口。 */
const VIEWPORT = { width: 1280, height: 800 };
/** 常见菜单尺寸。 */
const SIZE = { width: 220, height: 300 };

test('有空间时菜单落在指针处', () => {
	const placed = placeMenu({ x: 400, y: 200 }, SIZE, VIEWPORT);
	assert.equal(placed.left, 400);
	assert.equal(placed.top, 200);
});

test('靠近右边缘时向左收，不超出视口', () => {
	const placed = placeMenu({ x: VIEWPORT.width - 10, y: 100 }, SIZE, VIEWPORT);
	assert.equal(placed.left, VIEWPORT.width - SIZE.width - MENU_MARGIN);
	assert.ok(placed.left + SIZE.width <= VIEWPORT.width, '菜单右边界应在视口内');
});

test('靠近底边时上移，菜单完整可见', () => {
	// 只夹底边（不减去菜单高度）会得到近 800 的 top，菜单高 300 必然溢出。
	const placed = placeMenu({ x: 100, y: VIEWPORT.height - 10 }, SIZE, VIEWPORT);
	assert.ok(placed.top + SIZE.height <= VIEWPORT.height, `菜单底边应在视口内，实际 ${placed.top + SIZE.height}`);
	assert.ok(placed.top >= MENU_MARGIN, '不应越过上边界');
	// 上方放得下时翻到指针上方，比贴底边更贴近指针。
	assert.equal(placed.top, VIEWPORT.height - 10 - SIZE.height);
});

test('上方也放不下时贴底边收进视口', () => {
	// 指针在中部而菜单很高：上方放不下，贴底边保证底部不溢出。
	const tall = { width: 220, height: 500 };
	const placed = placeMenu({ x: 100, y: 400 }, tall, VIEWPORT);
	assert.equal(placed.top, VIEWPORT.height - tall.height - MENU_MARGIN);
	assert.ok(placed.top + tall.height <= VIEWPORT.height, '菜单底边应在视口内');
});

test('下方放不下且上方放得下时翻到指针上方', () => {
	const placed = placeMenu({ x: 100, y: VIEWPORT.height - 100 }, SIZE, VIEWPORT);
	assert.equal(placed.top, VIEWPORT.height - 100 - SIZE.height, '应翻到指针上方');
	assert.ok(placed.top >= MENU_MARGIN);
});

test('右下角同时贴边', () => {
	const placed = placeMenu({ x: VIEWPORT.width - 5, y: VIEWPORT.height - 5 }, SIZE, VIEWPORT);
	assert.ok(placed.left >= MENU_MARGIN && placed.left + SIZE.width <= VIEWPORT.width, '水平应在视口内');
	assert.ok(placed.top >= MENU_MARGIN && placed.top + SIZE.height <= VIEWPORT.height, '垂直应在视口内');
});

test('左上角不越界', () => {
	const placed = placeMenu({ x: 0, y: 0 }, SIZE, VIEWPORT);
	assert.equal(placed.left, MENU_MARGIN, '应留出左边距');
	assert.equal(placed.top, MENU_MARGIN, '应留出上边距');
});

test('菜单比视口还高时贴上边', () => {
	// 无论怎么放都放不下：贴上边，超出部分交给视口裁掉，而不是让菜单整体移出屏幕。
	const tall = { width: 220, height: 900 };
	const placed = placeMenu({ x: 100, y: 400 }, tall, VIEWPORT);
	assert.equal(placed.top, MENU_MARGIN);
});

test('二级菜单默认贴在父菜单右侧', () => {
	const parent = { left: 100, top: 100, width: 220 };
	const placed = placeSubmenu(parent, 40, SIZE, VIEWPORT);
	assert.equal(placed.left, parent.left + parent.width + SUBMENU_GAP);
	assert.equal(placed.top, parent.top + 40);
});

test('右侧放不下时二级菜单翻到左侧', () => {
	const parent = { left: VIEWPORT.width - 240, top: 100, width: 220 };
	const placed = placeSubmenu(parent, 0, SIZE, VIEWPORT);
	assert.ok(placed.left + SIZE.width <= VIEWPORT.width, '不应超出右边界');
	assert.equal(placed.left, parent.left - SIZE.width - SUBMENU_GAP, '应翻到父菜单左侧');
});

test('二级菜单底部贴边', () => {
	const parent = { left: 100, top: VIEWPORT.height - 100, width: 220 };
	const placed = placeSubmenu(parent, 80, SIZE, VIEWPORT);
	assert.ok(placed.top + SIZE.height <= VIEWPORT.height, '二级菜单底边应在视口内');
});

test('二级菜单两侧都放不下时留在视口内', () => {
	const parent = { left: 40, top: 100, width: 220 };
	// 视口太窄：左右都放不下，应夹进视口而不是跑到屏幕外。
	const narrow = { width: 300, height: 800 };
	const placed = placeSubmenu(parent, 0, SIZE, narrow);
	assert.ok(placed.left >= MENU_MARGIN, '不应越过左边界');
	assert.ok(placed.left + SIZE.width <= narrow.width, '不应越过右边界');
});
