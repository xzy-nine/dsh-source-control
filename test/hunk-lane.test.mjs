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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { JSDOM } = await import('jsdom');
const { hunkSlots } = await import('../src/client/diff/hunk-lane.ts');

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

test('分段列只在两侧都有改动、有块且展开时让出宽度', () => {
	const source = readFileSync(join(root, 'src', 'client', 'index.ts'), 'utf8');
	const rule = /const laneVisible = ([\s\S]*?);\n/.exec(source);
	assert.ok(rule !== null, '应有分段列的显示判据');
	const body = rule[1];
	assert.match(body, /oldText !== null/, '单侧改动只有一栏，没有中间缝');
	assert.match(body, /newText !== null/, '单侧改动只有一栏，没有中间缝');
	assert.match(body, /hunks\.length > 0/, '没有补丁块就没有可暂存的东西');
	assert.match(body, /slots\.length > 0/, '量不出位置时不画，避免按钮浮在空中');
	assert.match(body, /fileState\.expanded/, '折叠的文件段里没有行，按钮无处可站');
	assert.match(body, /conflict/, '冲突视图自己有中间列，不再叠一条分段列');
	assert.match(source, /'data-sc-lane': laneVisible \? '' : undefined/, '让宽由同一条判据驱动');
	assert.match(source, /laneVisible && React\.createElement\(HunkLane/, '轨道由同一条判据驱动');
});

test('分段列宽 48px，只有带标记时才让宽', () => {
	const lane = readFileSync(join(root, 'src', 'client', 'css', 'hunk-bar.module.css'), 'utf8');
	assert.match(lane, /width:48px/, '轨道宽 48px');
	assert.match(lane, /margin-left:-24px/, '轨道以中线居中');
	// 按钮在区间里垂直居中，而不是贴在上沿。
	assert.match(lane, /\.slot\{[^}]*align-items:center/, '按钮在区间内垂直居中');
	const page = readFileSync(join(root, 'src', 'client', 'css', 'index.module.css'), 'utf8');
	const gap = /\[data-sc-lane\] :global\(\[data-diff-pair\]\)\{column-gap:(\d+)px\}/.exec(page);
	assert.ok(gap !== null, '应有让宽的规则');
	assert.equal(gap[1], '48', '让出的宽度与轨道宽度一致');
	assert.ok(!/^\.diffBody :global\(\[data-diff-pair\]\)/m.test(page), '让宽规则必须挂在标记下');
});
