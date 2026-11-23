/**
 * 分段暂存轨道的几何：把每个补丁块的改动区间落到它在正文里的实际位置。
 *
 * 按钮摆在改动区间的垂直中点：贴块首行会让它看起来属于上面的未改动区域，而块内还带着
 * 上下文行。位置与高度都从渲染结果量出——并排布局把删除行与新增行配成同一行、自动换行
 * 又把一行撑成多行，按行数推算会错位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { JSDOM } = await import('jsdom');
const { hunkLineText, hunkSlots, markHunkRows, sameSlots, scrollToHunk } = await import('../src/client/diff/hunk-lane.ts');
const { setShownSide, titleScopeOf } = await import('../src/client/diff/shown-side.ts');
const { gitDiffTitle } = await import('../src/client/diff/resource-path.ts');

/** 造一个正文容器：每行带两侧行号，行高固定 22。 */
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
	const posed = [...host.children];
	host.getBoundingClientRect = () => ({ top: 0, bottom: posed.length * 22, left: 0, right: 600, width: 600, height: posed.length * 22 });
	for (const [index, row] of posed.entries()) {
		const top = index * 22;
		row.getBoundingClientRect = () => ({ top, bottom: top + 22, left: 0, right: 600, width: 600, height: 22 });
	}
	return host;
}

/** 两个补丁块：首块改新侧第 10-11 行，次块改新侧第 30 行。 */
const HUNKS = [
	{ index: 0, header: '@@ -10,2 +10,2 @@', oldStart: 10, oldLines: 2, newStart: 10, newLines: 2 },
	{ index: 1, header: '@@ -30,1 +30,1 @@', oldStart: 30, oldLines: 1, newStart: 30, newLines: 1 },
];

test('落位覆盖改动区间，不含块内的上下文行', () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	// 第 0 行是上面的未改动行，第 1-2 行是首块的改动，第 3 行是次块的改动。
	const body = buildBody(dom.window.document, [[9, 9], [10, 10], [11, 11], [30, 30]]);
	const slots = hunkSlots(body, HUNKS);
	assert.equal(slots.length, 2);
	assert.equal(slots[0].index, 0);
	assert.equal(slots[0].top, 22, '首个改动的上沿，不是正文顶端');
	assert.equal(slots[0].height, 44, '高度取到末个改动的下沿');
	assert.equal(slots[1].index, 1);
	assert.equal(slots[1].top, 66, '次块贴着它自己的改动行');
	assert.equal(slots[1].height, 22, '单行改动的高度就是一行');
	dom.window.close();
});

test('按钮落在改动区间的中点', () => {
	// 轨道把区间上下等分后居中按钮，因此中点就是 (top + height / 2)。
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	const body = buildBody(dom.window.document, [[10, 10], [11, 11], [12, 12], [13, 13]]);
	// 一个块改 4 行：区间从 0 到 88，中点 44。
	const slots = hunkSlots(body, [{ index: 0, header: '@@ -10,4 +10,4 @@', oldStart: 10, oldLines: 4, newStart: 10, newLines: 4 }]);
	assert.equal(slots[0].top, 0);
	assert.equal(slots[0].height, 88);
	const center = slots[0].top + slots[0].height / 2;
	assert.equal(center, 44, '中点位于改动区间的正中');
	dom.window.close();
});

test('纯删除的块按旧侧行号定位', () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	const body = buildBody(dom.window.document, [[10, 10], [11, null]]);
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

test('行号提示用区间写法而不是补丁头', () => {
	const single = { index: 0, header: '@@ -10 +10 @@', oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 };
	const multi = { index: 1, header: '@@ -10,3 +10,3 @@', oldStart: 10, oldLines: 3, newStart: 10, newLines: 3 };
	assert.equal(hunkLineText(single), '第 10 行', '单行给单行号');
	assert.equal(hunkLineText(multi), '第 10-12 行', '多行给闭区间');
	// 纯删除的块只存在于旧侧，提示仍按它自己的行号给。
	const deletion = { index: 2, header: '@@ -7,2 +0,0 @@', oldStart: 7, oldLines: 2, newStart: 0, newLines: 0 };
	assert.equal(hunkLineText(deletion), '第 7-8 行', '纯删除块按旧侧行号');
});

test('跳到某一块会滚动到它的改动首行', () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	const body = buildBody(dom.window.document, [[9, 9], [10, 10], [11, 11], [30, 30]]);
	// jsdom 没有 scrollIntoView：补一个记录调用的替身。
	const scrolled = [];
	for (const row of body.children) row.scrollIntoView = () => { scrolled.push(row); };

	assert.equal(scrollToHunk(body, HUNKS, 1), true, '次块能找到');
	assert.equal(scrolled.length, 1, '滚到一行');
	assert.equal(scrolled[0], body.children[3], '滚到次块的改动首行');
	assert.equal(scrollToHunk(body, HUNKS, 99), false, '不存在的块返回 false');
	assert.equal(scrollToHunk(null, HUNKS, 0), false, '容器缺失返回 false');
	dom.window.close();
});

test('索引化后仍按显示顺序取改动行', () => {
	// 一次遍历建索引再按行号取，结果必须与原逐行扫描一致：跨块、纯删除都要对。
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	const body = buildBody(dom.window.document, [[1, 1], [2, 2], [5, null], [6, null], [8, 9], [9, 10]]);
	const hunks = [
		{ index: 0, header: '@@ -2,1 +2,1 @@', oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
		{ index: 1, header: '@@ -5,2 +4,0 @@', oldStart: 5, oldLines: 2, newStart: 4, newLines: 0 },
	];
	markHunkRows(body, hunks, 1);
	const marked = [...body.children].map((row) => row.hasAttribute('data-sc-hunk-hover'));
	assert.deepEqual(marked, [false, false, true, true, false, false], '纯删除块只标旧侧两行');
	markHunkRows(body, hunks, 0);
	assert.deepEqual([...body.children].map((row) => row.hasAttribute('data-sc-hunk-hover')),
		[false, true, false, false, false, false], '换块时清掉上一块');
	dom.window.close();
});

test('指到分段按钮把它要处理的行标出来', () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	// 第 0 行未改动，第 1-2 行是首块的改动，第 3 行是次块的改动。
	const body = buildBody(dom.window.document, [[9, 9], [10, 10], [11, 11], [30, 30]]);
	const marked = () => [...body.children].map((row) => row.hasAttribute('data-sc-hunk-hover'));

	markHunkRows(body, HUNKS, 0);
	assert.deepEqual(marked(), [false, true, true, false], '只标首块的两行改动');
	markHunkRows(body, HUNKS, 1);
	assert.deepEqual(marked(), [false, false, false, true], '换块时清掉上一块');
	markHunkRows(body, HUNKS, null);
	assert.deepEqual(marked(), [false, false, false, false], '清除标记');
	dom.window.close();
});

test('显示侧决定标题，且可在两侧之间来回切', () => {
	// 标题由注册处按地址算，读不到页内状态；显示侧登记在共享快照里供它读取。
	const address = 'dsh-resource://git-diff/session/s1/%2A';
	const worktreeScope = { kind: 'worktree', staged: false };
	const stagedScope = { kind: 'worktree', staged: true };

	assert.equal(titleScopeOf(address, worktreeScope).staged, false, '未登记时与地址一致');
	setShownSide(address, true);
	assert.equal(titleScopeOf(address, worktreeScope).staged, true, '切到暂存区后标题随之变化');
	assert.equal(gitDiffTitle(titleScopeOf(address, worktreeScope)), '暂存的更改', '标题写暂存区');
	// 再切回工作区：两侧之间可以反复搬动，标题也跟回来。
	setShownSide(address, false);
	assert.equal(gitDiffTitle(titleScopeOf(address, worktreeScope)), '更改', '切回工作区后标题回到更改');
	// 登记为空表示与地址一致。
	setShownSide(address, null);
	assert.equal(titleScopeOf(address, worktreeScope).staged, false, '清掉登记后回到地址');
	// 提交与对比作用域没有对侧，不受显示侧影响。
	const commitScope = { kind: 'commit', hash: 'abcdef1' };
	setShownSide(address, true);
	assert.deepEqual(titleScopeOf(address, commitScope), commitScope, '提交作用域不跟随显示侧');
	setShownSide(address, null);
});

test('轨道宽度与正文让出的空隙相等', () => {
	// 轨道叠在两栏正文的中间缝上：让出的 column-gap 必须与轨道同宽，窄了按钮压到代码上，
	// 宽了正文中间留出空白。两个数字分属两个 CSS 模块，只能靠这条断言保持一致。
	const lane = readFileSync(join(root, 'src', 'client', 'css', 'hunk-bar.module.css'), 'utf8');
	const width = Number(/^\.lane\{[^}]*width:(\d+)px/m.exec(lane)?.[1]);
	assert.ok(Number.isFinite(width) && width > 0, '轨道应有像素宽度');
	// 按钮是方形，且必须放得进轨道。
	const button = /^\.button\{([^}]*)\}/m.exec(lane)?.[1] ?? '';
	assert.equal(Number(/width:(\d+)px/.exec(button)?.[1]), Number(/height:(\d+)px/.exec(button)?.[1]), '按钮应为正方形');
	assert.ok(Number(/width:(\d+)px/.exec(button)?.[1]) <= width, '按钮不得宽于轨道');
	// 轨道以中线居中：负一半的外边距。
	assert.equal(Number(/margin-left:(-\d+)px/.exec(lane)?.[1]), -width / 2, '轨道按其宽度的一半居中');

	const page = readFileSync(join(root, 'src', 'client', 'css', 'index.module.css'), 'utf8');
	const gaps = [...page.matchAll(/\[data-sc-lane\][^{]*\{column-gap:(\d+)px\}/g)].map((match) => Number(match[1]));
	assert.ok(gaps.length > 0, '应存在分段列的让宽规则');
	for (const gap of gaps) assert.equal(gap, width, '让出的宽度必须等于轨道宽度');
});

test('落位等价判断挡住重复写入', () => {
	// 没有这个判断，measure 每次写入都会触发重渲染、重渲染又再量，最终整棵树被卸载。
	const a = [{ index: 0, top: 10, height: 20 }, { index: 1, top: 30, height: 10 }];
	assert.equal(sameSlots(a, [{ index: 0, top: 10, height: 20 }, { index: 1, top: 30, height: 10 }]), true, '同值判为相等');
	assert.equal(sameSlots(a, a), true, '同一引用相等');
	assert.equal(sameSlots(a, [{ index: 0, top: 10, height: 20 }]), false, '长度不同不相等');
	assert.equal(sameSlots(a, [{ index: 0, top: 11, height: 20 }, { index: 1, top: 30, height: 10 }]), false, '位置变了不相等');
	assert.equal(sameSlots(a, [{ index: 0, top: 10.2, height: 20 }, { index: 1, top: 30, height: 10 }]), true, '亚像素抖动不算变化');
	assert.equal(sameSlots(a, [{ index: 9, top: 10, height: 20 }, { index: 1, top: 30, height: 10 }]), false, '块下标变了不相等');
});
