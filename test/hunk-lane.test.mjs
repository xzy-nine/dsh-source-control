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

test('轨道按钮在指到与聚焦时高亮、离开时清除', () => {
	const source = readFileSync(join(root, 'src', 'client', 'diff', 'hunk-bar.ts'), 'utf8');
	assert.match(source, /onPointerEnter: \(\) => \{ markHunkRows\(host, hunks, hunk\.index\)/, '指到按钮时标出该块的行');
	assert.match(source, /onPointerLeave: \(\) => \{ markHunkRows\(host, hunks, null\)/, '离开时清除');
	assert.match(source, /onFocus:/, '键盘聚焦同样标出');
	// 高亮要压在红绿底色之上：并排布局的增减底色画在行内的单元格上，因此染色用铺满整格的
	// 绝对定位伪元素，而不是给行加内阴影（那会落在单元格下方，看不见）。
	const css = readFileSync(join(root, 'src', 'client', 'css', 'forge-adapter.module.css'), 'utf8');
	const base = /\[data-sc-hunk-hover\]\)\{([^}]*)\}/.exec(css);
	assert.ok(base !== null, '应有悬停高亮的样式');
	assert.match(base[1], /position:relative/, '行要成为伪元素的定位参照');
	const overlay = /\[data-sc-hunk-hover\]\)::after\{([^}]*)\}/.exec(css);
	assert.ok(overlay !== null, '染色由伪元素铺满整格');
	assert.match(overlay[1], /position:absolute;inset:0/, '伪元素盖满该行');
	assert.match(overlay[1], /pointer-events:none/, '染色层不能挡指针');
	assert.match(overlay[1], /5%/, '淡到只是微微泛白');
	assert.ok(!/box-shadow:inset 0 0 0 9999px/.test(css), '不要用行内阴影：它落在单元格底色下面');
});

test('按钮常驻淡显，指进中间列加深，指到某个时实显', () => {
	const lane = readFileSync(join(root, 'src', 'client', 'css', 'hunk-bar.module.css'), 'utf8');
	// 触屏没有 hover：只按 hover 显隐会让按钮在那些设备上永远不出现，因此要有常驻态。
	const button = /^\.button\{([^}]*)\}/m.exec(lane);
	assert.ok(button !== null, '应有按钮规则');
	assert.match(button[1], /opacity:0\.35/, '常驻淡显，不悬停也看得见');
	assert.ok(!/opacity:0;/.test(button[1]), '默认不能是全隐');
	// 整列接收指针：否则只有指到按钮本身才触发，列里其余位置没有反应。
	const rule = /^\.lane\{([^}]*)\}/m.exec(lane);
	assert.ok(rule !== null, '应有轨道规则');
	assert.match(rule[1], /pointer-events:auto/, '整列接收指针，指进列里即触发');
	// 指到列：整体加深；指到某个：它实显。
	assert.match(lane, /\.lane:hover \.button\{opacity:0\.6\}/, '指进列时整体加深');
	assert.match(lane, /\.lane:hover \.slot:hover \.button[^{]*\{opacity:1/, '指到某个按钮时才实显');
	// 列是空隙，里面没有正文；按钮不能比列宽，否则会压到两栏代码上。
	assert.match(lane, /width:18px;height:18px/, '按钮 18px');
	assert.match(rule[1], /width:20px/, '列宽只比按钮多 2px');
});

test('分段按钮自己接收指针事件', () => {
	// `pointer-events` 会从槽位继承：槽位设成 none 后按钮曾经跟着穿透，点击落不到按钮上。
	const lane = readFileSync(join(root, 'src', 'client', 'css', 'hunk-bar.module.css'), 'utf8');
	const button = /^\.button\{([^}]*)\}/m.exec(lane);
	assert.ok(button !== null, '应有按钮规则');
	assert.match(button[1], /pointer-events:auto/, '按钮必须收回指针事件，否则继承槽位的 none');
	const slot = /^\.slot\{([^}]*)\}/m.exec(lane);
	assert.ok(slot !== null, '应有槽位规则');
	assert.match(slot[1], /pointer-events:none/, '槽位不吃指针，hover 交给整列');
});

test('一侧取空后就地切到另一侧继续看同一文件', () => {
	const source = readFileSync(join(root, 'src', 'client', 'index.ts'), 'utf8');
	// 只在工作区 / 暂存区之间搬动：提交与对比作用域没有对侧。
	const rule = /const emptyNow = ([\s\S]*?);\n/.exec(source);
	assert.ok(rule !== null, '应有取空判据');
	assert.match(rule[1], /hunks\.length === 0/, '没有补丁块即为取空');
	const at = source.indexOf('const switchScopeSide = React.useCallback(');
	assert.ok(at >= 0, '应有切侧实现');
	const body = source.slice(at, source.indexOf('const [followedSide', at) === -1 ? at + 2000 : source.indexOf('}, [scope, staged, loadOtherSide]);', at));
	assert.match(body, /scope\.kind !== 'worktree'/, '提交与对比作用域不切侧');
	assert.match(body, /setFollowedSide\(toStaged\)/, '记下切过去的是哪一侧');
	assert.match(body, /data\.hunks\.length === 0/, '对侧也空时不切，避免两侧来回跳');
	// 同一页换内容，不是另开一页：否则当前页会停在「没有改动」上。
	assert.ok(!/openResource\(gitDiffAddress/.test(source), '切侧不得另开新页');
	// 动作方向跟着实际显示的一侧走。
	assert.match(source, /const staged = followedSide \?\? stagedScope;/, '动作方向取实际显示的一侧');
	assert.match(source, /emptiedSide\.current = true/, '暂存动作记下来源');
	assert.match(source, /if \(!emptiedSide\.current\) return;/, '只在本次动作搬空时才切');
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

test('取数跟随实际显示侧，不把正文拉回地址所指的一侧', () => {
	const source = readFileSync(join(root, 'src', 'client', 'index.ts'), 'utf8');
	// staged 若进 load 的依赖，切侧会再触发一次取数把内容清掉；因此改读 ref。
	const loadStart = source.indexOf('const load = React.useCallback(');
	assert.ok(loadStart >= 0, '应有 load');
	const body = source.slice(loadStart, source.indexOf('const loadOtherSide', loadStart));
	assert.match(body, /const side = stagedRef\.current;/, '取数读当前显示侧');
	assert.match(body, /fileDiffContent\(gitCwd, commitHash, currentPath, side, baseHash\)/, '按显示侧取数');
	const deps = /\}, \[([^\]]*)\]\);/.exec(body);
	assert.ok(deps !== null, '应有依赖列表');
	assert.ok(!deps[1].includes('staged'), 'staged 不得进依赖，否则切侧会被重取清掉');
	assert.match(source, /stagedRef\.current = staged;/, '每次渲染同步 ref');
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

test('量落位时用等价判断写回状态', () => {
	const source = readFileSync(join(root, 'src', 'client', 'index.ts'), 'utf8');
	assert.match(source, /setSlots\(\(previous\) => \(sameSlots\(previous, next\) \? previous : next\)\)/, '同值时不写状态');
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

test('分段列刚好放得下按钮，只有带标记时才让宽', () => {
	const lane = readFileSync(join(root, 'src', 'client', 'css', 'hunk-bar.module.css'), 'utf8');
	const width = /^\.lane\{[^}]*width:(\d+)px/m.exec(lane);
	assert.ok(width !== null, '应有轨道宽度');
	// 这列只放一个 18px 的图标按钮，宽度取按钮边长 + 两侧各 1px，不多占正文。
	assert.equal(width[1], '20', '轨道宽度只够放下按钮');
	assert.match(lane, /width:18px;height:18px/, '按钮是 18px 方形');
	assert.match(lane, /margin-left:-10px/, '轨道以中线居中');
	// 按钮在区间里垂直居中，而不是贴在上沿。
	assert.match(lane, /\.slot\{[^}]*align-items:center/, '按钮在区间内垂直居中');
	const page = readFileSync(join(root, 'src', 'client', 'css', 'index.module.css'), 'utf8');
	const gap = /\[data-sc-lane\] :global\(\[data-diff-pair\]\)\{column-gap:(\d+)px\}/.exec(page);
	assert.ok(gap !== null, '应有让宽的规则');
	assert.equal(gap[1], '20', '让出的宽度与轨道宽度一致');
	assert.ok(!/^\.diffBody :global\(\[data-diff-pair\]\)/m.test(page), '让宽规则必须挂在标记下');
});
