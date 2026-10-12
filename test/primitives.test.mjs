/**
 * 校验客户端从 ui-primitives 导入的每个名字都真实存在，以及图形区的
 * 拖拽手柄位置与拖动方向。
 *
 * 背景：ui-primitives 的产品图标导出名带 `Regular` / `Medium` 权重后缀，
 * 写成裸名会得到 undefined，React 渲染时不报编译错误、只在运行时抛
 * 「元素类型无效」并让整个侧栏页变空白。此测试把这类拼写错误挡在构建前。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const clientDir = join(root, 'src', 'client');
const panelDir = join(clientDir, 'panel');

/** ui-primitives 在源码检出中的位置；profile 安装版没有源码，此时跳过。 */
const PRIMITIVES_INDEX = 'E:/GitHubCode/02DSH/deepseek-harness/packages/client/ui-primitives/src/index.ts';
const PRIMITIVES_ICONS = 'E:/GitHubCode/02DSH/deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';

/** 客户端全部源码文件（含 panel/ 子目录）。 */
function clientFiles() {
	const files = readdirSync(clientDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => join(clientDir, entry.name));
	for (const entry of readdirSync(panelDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith('.ts')) files.push(join(panelDir, entry.name));
	}
	return files;
}

/** 收集 ui-primitives 的导出名（含星号再导出的图标）。 */
function primitivesExports() {
	const names = new Set();
	const indexSource = readFileSync(PRIMITIVES_INDEX, 'utf8');
	for (const match of indexSource.matchAll(/export\s*\{([^}]+)\}/g)) {
		for (const piece of match[1].split(',')) {
			const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
			if (name !== undefined && name !== '') names.add(name);
		}
	}
	if (indexSource.includes("export * from './icons/index.tsx'")) {
		const iconsSource = readFileSync(PRIMITIVES_ICONS, 'utf8');
		for (const match of iconsSource.matchAll(/export const ([A-Za-z0-9_]+)/g)) names.add(match[1]);
	}
	return names;
}

/** 取一个客户端文件里从 ui-primitives 导入的名字。 */
function importedNames(file) {
	const source = readFileSync(file, 'utf8');
	const names = [];
	for (const block of source.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'@deepseek-ai\/dsh-client-ui-primitives'/g)) {
		for (const piece of block[1].split(',')) {
			const name = piece.trim().replace(/^type\s+/, '');
			if (name !== '') names.push(name);
		}
	}
	return names;
}

const available = existsSync(PRIMITIVES_INDEX) && existsSync(PRIMITIVES_ICONS);

test('ui-primitives 导入名全部存在', { skip: !available && '未找到 ui-primitives 源码检出' }, () => {
	const exported = primitivesExports();
	assert.ok(exported.size > 100, `导出表过小（${exported.size}），可能解析出错`);
	for (const file of clientFiles()) {
		for (const name of importedNames(file)) {
			assert.ok(exported.has(name), `${file} 导入了不存在的导出名：${name}`);
		}
	}
});

test('图形区拖拽手柄在图形标题之前', () => {
	// 手柄画在工作区与图形的分界线上：它必须是图形区内的第一个元素，
	// 否则会出现在标题与图形之间。
	const source = readFileSync(join(panelDir, 'sections.ts'), 'utf8');
	const section = source.indexOf("'ggg-sec ggg-graph-sec'");
	const handle = source.indexOf("'ggg-sec-resize'", section);
	const title = source.indexOf("'图形'");
	assert.ok(section !== -1 && handle !== -1 && title !== -1, '未找到图形区标记');
	assert.ok(handle > section && handle < title, '拖拽手柄必须排在图形标题之前');
});

test('图形区高度跟随拖动方向', () => {
	// 向上拖＝图形变高：位移取负号，写成加号会让拖拽方向反转。
	const source = readFileSync(join(clientDir, 'panel.ts'), 'utf8');
	const start = source.indexOf('const startGraphResize');
	const body = source.slice(start, source.indexOf("window.addEventListener('pointermove'", start));
	assert.match(body, /commitGraphHeight\(startHeight - \(moveEvent\.clientY - startY\)\)/, '拖拽位移必须取负号');
});

test('改动文件区在图形区内展开', () => {
	// 展开块由 CommitGraph 按选中行渲染，面板不再另起一块。
	const graphSource = readFileSync(join(clientDir, 'graph.ts'), 'utf8');
	assert.match(graphSource, /renderDetail/, 'CommitGraph 必须接收 renderDetail');
	assert.match(graphSource, /ggg-detail-inline/, '展开块必须由图形区渲染');
	const sectionSource = readFileSync(join(panelDir, 'sections.ts'), 'utf8');
	const section = sectionSource.indexOf("'ggg-sec ggg-graph-sec'");
	assert.ok(section !== -1, '未找到图形区标记');
	assert.ok(!sectionSource.includes("'ggg-detail'"), '图形区不应渲染独立的 ggg-detail 区块');
});

test('展开块左内边距与提交行一致', () => {
	// 少了与 .ggg-row 相同的左内边距与列间距，泳道列会相对提交行左移。
	const source = readFileSync(join(clientDir, 'styles.ts'), 'utf8');
	const row = /\.ggg-row\{[^}]*gap:8px[^}]*padding:0 8px/.test(source);
	const inline = /\.ggg-detail-inline\{[^}]*gap:8px[^}]*padding:0 8px/.test(source);
	assert.ok(row, '提交行应有 8px 列间距与 0 8px 内边距');
	assert.ok(inline, '展开块应有同样的 8px 列间距与 0 8px 内边距，与提交行对齐');
});

test('再次点击同一提交行收起展开', () => {
	// 点已选中的行必须收起（清空选中与详情），否则无法二次点击关闭。
	const source = readFileSync(join(clientDir, 'panel.ts'), 'utf8');
	const start = source.indexOf('const toggleCommit');
	assert.ok(start !== -1, '未找到 toggleCommit');
	const body = source.slice(start, source.indexOf('const stagedPaths', start));
	assert.match(body, /state\.selectedHash === hash/, '必须先判断是否已选中');
	assert.match(body, /selectedHash: null, detail: null/, '收起时必须清空选中与详情');
	assert.match(source, /onToggleCommit: toggleCommit/, '图形行点击必须走 toggleCommit');
});

test('图标导出名带权重后缀', { skip: !available && '未找到 ui-primitives 源码检出' }, () => {
	const exported = primitivesExports();
	// 产品图标一律以 Regular 或 Medium 结尾；裸名不存在，正是初版写错的地方。
	assert.ok(exported.has('IconBranchOutlineRegular'));
	assert.ok(!exported.has('IconBranchOutline'), '裸图标名不应存在，若上游改名需同步本测试');
});
