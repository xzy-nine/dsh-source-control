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

test('提交框在滚动区之外', () => {
	// 滚动必须只发生在变更列表上：提交框若落在滚动容器内会随列表一起滚走。
	const source = readFileSync(join(panelDir, 'sections.ts'), 'utf8');
	const box = source.indexOf("'ggg-commit-box'");
	const scroll = source.indexOf("'ggg-changes-scroll'");
	assert.ok(box !== -1 && scroll !== -1, '未找到提交框或滚动容器标记');
	assert.ok(box < scroll, '提交框必须排在滚动容器之前');
	// 两个变更分组都必须在滚动容器内。
	const stagedGroup = source.indexOf('staged: true', scroll);
	const unstagedGroup = source.indexOf('staged: false', scroll);
	assert.ok(stagedGroup !== -1 && unstagedGroup !== -1, '两个变更分组都应在滚动容器内');
});

test('工作区主体自身不滚动', () => {
	const source = readFileSync(join(clientDir, 'styles.ts'), 'utf8');
	const body = /\.ggg-workspace-body\{([^}]*)\}/.exec(source);
	assert.ok(body !== null, '未找到 .ggg-workspace-body');
	assert.match(body[1], /overflow:hidden/, '工作区主体不得自身滚动，否则提交框会跟着滚');
	const scroll = /\.ggg-changes-scroll\{([^}]*)\}/.exec(source);
	assert.ok(scroll !== null, '未找到 .ggg-changes-scroll');
	assert.match(scroll[1], /overflow-y:auto/, '变更列表容器应纵向滚动');
});

test('文件行整行点击即打开', () => {
	// 文件行不再有「查看差异」按钮：点击行本身即打开。
	const source = readFileSync(join(panelDir, 'changes.ts'), 'utf8');
	assert.ok(!source.includes('IconCompareSplitOutlineRegular'), '不应再引用差异按钮图标');
	assert.ok(!source.includes("'查看差异'"), '不应再有查看差异按钮');
	assert.ok(!source.includes("'打开差异'"), '右键菜单不应再写打开差异');
	const openable = source.match(/ggg-change-openable/g) ?? [];
	assert.ok(openable.length >= 2, '变更行与提交改动行都应带整行可点标记');
});

test('未跟踪新文件走普通文件地址', () => {
	// U（未跟踪）没有可比差异，必须走 dsh-resource://file/… 而不是 git-diff 地址。
	const indexPath = join(clientDir, 'index.ts');
	const source = readFileSync(indexPath, 'utf8');
	assert.match(source, /diffFileAddress/, 'index.ts 应使用普通文件地址构造函数');
	assert.match(source, /diff\.kind === 'file'/, '应按 file 类型分支处理');
	const panelSource = readFileSync(join(clientDir, 'panel.ts'), 'utf8');
	assert.match(panelSource, /untracked \? 'file'/, '未跟踪文件应生成 file 类型目标');
});

test('普通文件地址按仓库根换算', () => {
	// 会话工作区根未必是仓库根：路径要用仓库根拼绝对路径后再相对工作区根取地址。
	const source = readFileSync(join(clientDir, 'resource-path.ts'), 'utf8');
	assert.match(source, /relativeTo\(workspaceRoot, absolute\)/, '应先换算成相对工作区根的路径');
	assert.match(source, /repoRoot/, '仓库根参与绝对路径拼接');
});

test('状态字符与文件夹数量同处最右一列', () => {
	// 两者必须共用同一个尾部列，否则文件行与文件夹行的右边界参差。
	const source = readFileSync(join(panelDir, 'changes.ts'), 'utf8');
	const tails = source.match(/ggg-row-tail/g) ?? [];
	assert.ok(tails.length >= 2, `文件状态与文件夹数量都应使用尾部列，实际 ${tails.length} 处`);
	// 状态字符排在文件名之后，即最右侧。
	const nameAt = source.indexOf("'ggg-change-name' }, name)");
	const statusAt = source.indexOf("ggg-row-tail ggg-status");
	assert.ok(nameAt !== -1 && statusAt !== -1 && nameAt < statusAt, '状态字符必须排在文件名之后');
	const styles = readFileSync(join(clientDir, 'styles.ts'), 'utf8');
	const tail = /\.ggg-row-tail\{([^}]*)\}/.exec(styles);
	assert.ok(tail !== null, '未找到 .ggg-row-tail 样式');
	assert.match(tail[1], /width:24px/, '尾部列应定宽，使状态字符与数量对齐');
	// 文件夹数量不再用 margin-left:auto 单独靠右。
	assert.ok(!/\.ggg-folder \.ggg-count\{[^}]*margin-left:auto/.test(styles), '数量应由尾部列定位');
});

test('差异按 git 算出的 hunk 渲染', () => {
	// 整份内容交给 DiffBlock 时，超过其本地 diff 搜索上限的改动会退化成整文件全删全加。
	const indexSource = readFileSync(join(clientDir, 'index.ts'), 'utf8');
	assert.match(indexSource, /diffData\.hunks\.length > 0/, '应优先使用逐块内容');
	assert.match(indexSource, /\.map\(\(hunk\)/, '每个 hunk 各自成为一条 diffs 条目');
	const apiSource = readFileSync(join(clientDir, 'api.ts'), 'utf8');
	assert.match(apiSource, /hunks/, 'API 客户端应透出 hunks');
	const routes = readFileSync(join(root, 'src', 'git-graph', 'routes.ts'), 'utf8');
	assert.match(routes, /parseUnifiedDiffHunks/, '宿主应解析 git 的统一差异');
	assert.match(routes, /--unified=3/, '宿主应请求带上下文的统一差异');
});
