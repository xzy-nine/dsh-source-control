/**
 * 校验客户端从 ui-primitives 导入的每个名字都真实存在，以及图形区的
 * 拖拽手柄位置与拖动方向。
 *
 * 背景：ui-primitives 的产品图标导出名带 `Regular` / `Medium` 权重后缀，
 * 写成裸名会得到 undefined，React 渲染时不报编译错误、只在运行时抛
 * 「元素类型无效」并让整个侧栏页变空白。此测试把这类拼写错误挡在构建前。
 *
 * 样式已从 TS 模板字符串改为 CSS 模块（`css/` 下按组件拆分）：组件经类名映射引用，
 * 源码里不再出现裸类名，因此结构断言改看映射键，样式规则断言按归属模块读取 CSS 文件。
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
const cssDir = join(clientDir, 'css');

/** ui-primitives 在源码检出中的位置；profile 安装版没有源码，此时跳过。 */
const PRIMITIVES_INDEX = 'E:/GitHubCode/02DSH/deepseek-harness/packages/client/ui-primitives/src/index.ts';
const PRIMITIVES_ICONS = 'E:/GitHubCode/02DSH/deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';

/** 客户端全部源码文件（递归含各子目录）。 */
function clientFiles() {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
		}
	};
	walk(clientDir);
	return files;
}

/** 收集 ui-primitives 的导出名（含 `export type` 与星号再导出的图标）。 */
function primitivesExports() {
	const names = new Set();
	const indexSource = readFileSync(PRIMITIVES_INDEX, 'utf8');
	for (const match of indexSource.matchAll(/export\s*(?:type\s*)?\{([^}]+)\}/g)) {
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

/** 读取某个 CSS 模块的源码。 */
function cssFile(name) {
	return readFileSync(join(cssDir, name), 'utf8');
}

test('图形区拖拽手柄在图形标题之前', () => {
	// 手柄画在工作区与图形的分界线上：它必须是图形区内的第一个元素，
	// 否则会出现在标题与图形之间。
	const source = readFileSync(join(panelDir, 'sections.ts'), 'utf8');
	const section = source.indexOf('cx(css.sec, css.graphSec)');
	const handle = source.indexOf('shared.secResize', section);
	const title = source.indexOf("'图形'");
	assert.ok(section !== -1 && handle !== -1 && title !== -1, '未找到图形区标记');
	assert.ok(handle > section && handle < title, '拖拽手柄必须排在图形标题之前');
});

test('图形区高度跟随拖动方向', () => {
	// 向上拖＝图形变高：位移取负号，写成加号会让拖拽方向反转。
	const panel = readFileSync(join(clientDir, 'panel', 'index.ts'), 'utf8');
	assert.match(panel, /const startGraphResize = useResizeHandler\(graphHeight, 'up', commitGraphHeight\)/, '图形区拖拽应向上变大');
	assert.match(panel, /const startRepoResize = useResizeHandler\(repoHeight, 'down', commitRepoHeight\)/, '存储库区拖拽应向下变大');
	const resize = readFileSync(join(clientDir, 'panel', 'use-resize.ts'), 'utf8');
	assert.match(resize, /commit\(startHeight \+ \(direction === 'up' \? -delta : delta\)\)/, '拖拽位移必须按方向取符号');
});

test('改动文件区在图形区内展开', () => {
	// 展开块由 CommitGraph 按选中行渲染，面板不再另起一块。
	const graphSource = readFileSync(join(clientDir, 'graph', 'index.ts'), 'utf8');
	assert.match(graphSource, /renderDetail/, 'CommitGraph 必须接收 renderDetail');
	assert.match(graphSource, /css\.detailInline/, '展开块必须由图形区渲染');
	const sectionSource = readFileSync(join(panelDir, 'sections.ts'), 'utf8');
	const section = sectionSource.indexOf('cx(css.sec, css.graphSec)');
	assert.ok(section !== -1, '未找到图形区标记');
	assert.ok(!/css\.detail(?![A-Za-z])/.test(sectionSource), '图形区不应渲染独立的 detail 区块');
});

test('展开块左内边距与提交行一致', () => {
	// 少了与 .row 相同的左内边距与列间距，泳道列会相对提交行左移。
	const source = cssFile('graph.module.css');
	const row = /\.row\{[^}]*gap:8px[^}]*padding:0 8px/.test(source);
	const inline = /\.detailInline\{[^}]*gap:8px[^}]*padding:0 8px/.test(source);
	assert.ok(row, '提交行应有 8px 列间距与 0 8px 内边距');
	assert.ok(inline, '展开块应有同样的 8px 列间距与 0 8px 内边距，与提交行对齐');
});

test('再次点击同一提交行收起展开', () => {
	// 点已选中的行必须收起（清空选中与详情），否则无法二次点击关闭。
	const source = readFileSync(join(clientDir, 'panel', 'index.ts'), 'utf8');
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
	const box = source.indexOf('css.commitBox');
	const scroll = source.indexOf('css.changesScroll');
	assert.ok(box !== -1 && scroll !== -1, '未找到提交框或滚动容器标记');
	assert.ok(box < scroll, '提交框必须排在滚动容器之前');
	// 两个变更分组都必须在滚动容器内。
	const stagedGroup = source.indexOf('staged: true', scroll);
	const unstagedGroup = source.indexOf('staged: false', scroll);
	assert.ok(stagedGroup !== -1 && unstagedGroup !== -1, '两个变更分组都应在滚动容器内');
});

test('工作区主体自身不滚动', () => {
	const source = cssFile('sections.module.css');
	const body = /\.workspaceBody\{([^}]*)\}/.exec(source);
	assert.ok(body !== null, '未找到 .workspaceBody');
	assert.match(body[1], /overflow:hidden/, '工作区主体不得自身滚动，否则提交框会跟着滚');
	const scroll = /\.changesScroll\{([^}]*)\}/.exec(source);
	assert.ok(scroll !== null, '未找到 .changesScroll');
	assert.match(scroll[1], /overflow-y:auto/, '变更列表容器应纵向滚动');
});

test('文件行整行点击即打开', () => {
	// 文件行不再有独立的差异按钮：点击行本身即打开。
	const source = readFileSync(join(panelDir, 'changes.ts'), 'utf8');
	assert.ok(!source.includes('IconCompareSplitOutlineRegular'), '不应再引用差异按钮图标');
	assert.match(source, /const handleClick = [\s\S]{0,200}?onOpen\(entry, isNew\)/, '整行点击应直接打开文件');
	assert.match(source, /onClick: handleClick/, '行元素应绑定整行点击');
	const openable = source.match(/css\.changeOpenable/g) ?? [];
	assert.ok(openable.length >= 2, '变更行与提交改动行都应带整行可点标记');
});

test('新增文件走普通文件地址', () => {
	// 新增文件没有旧侧内容，必须走 dsh-resource://file/… 而不是 git-diff 地址。
	const indexPath = join(clientDir, 'index.ts');
	const source = readFileSync(indexPath, 'utf8');
	assert.match(source, /diffFileAddress/, 'index.ts 应使用普通文件地址构造函数');
	assert.match(source, /diff\.kind === 'file'/, '应按 file 类型分支处理');
	const panelSource = readFileSync(join(clientDir, 'panel', 'index.ts'), 'utf8');
	assert.match(panelSource, /isNew \? 'file'/, '新增文件应生成 file 类型目标');
	// 已暂存的 A 与未跟踪的 ? 都算新增：只看 ? 会漏掉 A。
	const changesSource = readFileSync(join(panelDir, 'changes.ts'), 'utf8');
	const judge = /export function isNewFile\(entry: WorkingTreeEntry\): boolean \{([^}]*)\}/.exec(changesSource);
	assert.ok(judge !== null, '应有 isNewFile 判据');
	assert.match(judge[1], /index === 'A'/, '已暂存的新增 A 也算新增文件');
	assert.match(judge[1], /index === '\?'/, '未跟踪的 ? 也算新增文件');
});

test('差异页默认并排且可切换', () => {
	// 复制来的 FileDiff 支持统一 / 并排两种布局；差异页应默认并排并给出切换。
	const source = readFileSync(join(clientDir, 'index.ts'), 'utf8');
	assert.match(source, /useState\(true\)/, '默认应为并排');
	assert.match(source, /FileDiff, \{ state, split, wrap, retry: load \}/, '应把 split 传给 FileDiff');
	assert.match(source, /setSplit/, '应能切换布局');
	const css = readFileSync(join(cssDir, 'file-diff.module.css'), 'utf8');
	assert.match(css, /\.columns/, '并排布局依赖 columns 样式');
});

test('普通文件地址按仓库根换算', () => {
	// 会话工作区根未必是仓库根：路径要用仓库根拼绝对路径后再相对工作区根取地址。
	const source = readFileSync(join(clientDir, 'diff', 'resource-path.ts'), 'utf8');
	assert.match(source, /relativeTo\(workspaceRoot, absolute\)/, '应先换算成相对工作区根的路径');
	assert.match(source, /repoRoot/, '仓库根参与绝对路径拼接');
});

test('状态字符与文件夹数量同处最右一列', () => {
	// 两者必须共用同一个尾部列，否则文件行与文件夹行的右边界参差。
	const source = readFileSync(join(panelDir, 'changes.ts'), 'utf8');
	const tails = source.match(/css\.rowTail/g) ?? [];
	assert.ok(tails.length >= 2, `文件状态与文件夹数量都应使用尾部列，实际 ${tails.length} 处`);
	// 状态字符排在文件名之后，即最右侧。
	const nameAt = source.indexOf('css.changeText }, name)');
	const statusAt = source.indexOf('css.rowTail, css.status');
	assert.ok(nameAt !== -1 && statusAt !== -1 && nameAt < statusAt, '状态字符必须排在文件名之后');
	const styles = cssFile('changes.module.css');
	const tail = /\.rowTail\{([^}]*)\}/.exec(styles);
	assert.ok(tail !== null, '未找到 .rowTail 样式');
	assert.match(tail[1], /width:24px/, '尾部列应定宽，使状态字符与数量对齐');
	// 文件夹数量不再用 margin-left:auto 单独靠右。
	assert.ok(!/\.folder \.count\{[^}]*margin-left:auto/.test(styles), '数量应由尾部列定位');
});

test('文件差异视图为复制自 DSH 的实现', () => {
	// ui-deliverables 的 FileDiff 未从 ui-primitives 导出，插件无法引用，故按 MIT 许可复制。
	const viewSource = readFileSync(join(clientDir, 'diff', 'file-diff.tsx'), 'utf8');
	assert.match(viewSource, /MIT 许可/, '应标明来源与许可');
	assert.match(viewSource, /ui-deliverables/, '应写明来源路径');
	assert.match(viewSource, /export function FileDiff/, '应导出 FileDiff');
	assert.match(viewSource, /export function hunkRows/, '应保留原实现的行号计算');
	assert.match(viewSource, /from '[^']*\/file-diff\.module\.css'/, '应通过 CSS 模块引用样式');
	const cssSource = readFileSync(join(cssDir, 'file-diff.module.css'), 'utf8');
	assert.match(cssSource, /\.number/, 'CSS 模块应含行号列样式');
	assert.match(cssSource, /\.hunkHeader/, 'CSS 模块应含 hunk 头样式');
	const indexSource = readFileSync(join(clientDir, 'index.ts'), 'utf8');
	assert.match(indexSource, /from '[^']*\/file-diff\.tsx'/, '差异页应引用复制的视图');
	assert.ok(!indexSource.includes('DiffBlock'), '不应再使用 ui-primitives 的 DiffBlock');
	const routes = readFileSync(join(root, 'src', 'source-control', 'routes.ts'), 'utf8');
	assert.match(routes, /parseUnifiedDiffHunks/, '宿主应解析 git 的统一差异');
	assert.match(routes, /--unified=3/, '宿主应请求带上下文的统一差异');
});

test('构建脚本把 CSS 模块的样式内联进包', () => {
	// esbuild 的 local-css 只产出类名映射；样式文本必须显式内联，否则视图无样式。
	const script = readFileSync(join(root, 'scripts', 'build-client.mjs'), 'utf8');
	assert.match(script, /'\.css': 'local-css'/, 'CSS 应作为模块处理');
	assert.match(script, /endsWith\('\.css'\)/, '应收集 esbuild 产出的样式');
	assert.match(script, /dsh-source-control-module-style/, '应把样式内联为一段 style');
	assert.match(script, /jsx: 'automatic'/, '复制的视图使用自动 JSX 运行时');
});

test('样式经 CSS 模块引用且类名全部有映射', () => {
	// 组件不再写裸类名字符串；每个 <别名>.xxx 都必须能在对应模块里找到同名类。
	const defined = new Map();
	for (const file of readdirSync(cssDir).filter((n) => n.endsWith('.module.css'))) {
		const source = readFileSync(join(cssDir, file), 'utf8');
		const names = new Set();
		for (const match of source.matchAll(/\.([A-Za-z][\w-]*)/g)) names.add(match[1]);
		defined.set(file, names);
	}
	const total = [...defined.values()].reduce((n, s) => n + s.size, 0);
	assert.ok(total > 100, `样式类名过少（${total}），可能解析出错`);

	// 源文件里 `import <别名> from '.../<模块>.module.css'` 建立别名到模块的对应。
	for (const file of clientFiles()) {
		const source = readFileSync(file, 'utf8');
		const aliasToModule = new Map();
		for (const match of source.matchAll(/import\s+(\w+)\s+from\s+'[^']*\/([\w-]+)\.module\.css'/g)) {
			aliasToModule.set(match[1], `${match[2]}.module.css`);
		}
		if (aliasToModule.size === 0) continue;
		// 去掉 import 行，避免把模块路径本身当成类名引用。
		const body = source.split('\n').filter((line) => !/^\s*import\b/.test(line)).join('\n');
		for (const match of body.matchAll(/\b(\w+)\.([A-Za-z][\w]*)\b/g)) {
			const module = aliasToModule.get(match[1]);
			if (module === undefined) continue;
			assert.ok(
				defined.get(module)?.has(match[2]),
				`${file} 引用了 ${module} 里不存在的类名：${match[1]}.${match[2]}`,
			);
		}
	}
});

test('动态切换的状态类不经模块作用域', () => {
	// menuTarget 会加在变更行与提交行两种元素上，两者分属不同 CSS 模块：
	// 若随模块作用域化，另一侧的元素拿不到该类，样式即失效。
	const state = readFileSync(join(cssDir, 'state-classes.ts'), 'utf8');
	const name = /MENU_TARGET_CLASS = '([^']+)'/.exec(state)?.[1];
	assert.ok(name !== undefined && name !== '', '应给出状态类名');
	// 样式侧以 :global 引用同一名字。
	const changes = cssFile('changes.module.css');
	const graph = cssFile('graph.module.css');
	assert.match(changes, new RegExp(`\\.change:global\\(\\.${name}\\)`), '变更行的高亮应引用全局状态类');
	assert.match(graph, new RegExp(`\\.row:global\\(\\.${name}\\)`), '提交行的高亮应引用全局状态类');
});

test('宿主 hunk 形状与视图一致', () => {
	// 视图按 DSH 的 WorkspaceDiffHunk 取字段（含行数），宿主必须给出同样的形状。
	const source = readFileSync(join(root, 'src', 'source-control', 'diff-hunks.ts'), 'utf8');
	for (const field of ['oldStart', 'oldLines', 'newStart', 'newLines', 'lines']) {
		assert.match(source, new RegExp(field), `hunk 应含 ${field}`);
	}
	assert.match(source, /HUNK_HEADER/, '应解析 hunk 头取得行号区间');
});

test('未提交行的文本经翻译函数', () => {
	// 数据层给出的 message 是英文占位，界面须经 displayMessage 转换；具体文案不在测试内钉住。
	const source = readFileSync(join(clientDir, 'graph', 'index.ts'), 'utf8');
	assert.match(source, /UNCOMMITTED_MESSAGE/, '应有未提交文本的匹配规则');
	assert.match(source, /displayMessage\(commit\)/, '行文本应经翻译函数');
});

test('未提交行不触发浮窗与右键', () => {
	// 未提交行不对应真实提交：不给右键菜单，也不套悬停卡片。
	const source = readFileSync(join(clientDir, 'graph', 'index.ts'), 'utf8');
	assert.match(source, /onContextMenu: isUncommitted \? undefined/, '未提交行不给右键菜单');
	assert.match(source, /if \(!isUncommitted && stashSelector === null\) onHover\?\.\(commit\.hash\)/, '未提交行不预取悬停数据');
	assert.match(source, /if \(isUncommitted \|\| stashSelector !== null\) return anchor;/, '未提交行不套 HoverCard');
});

test('贮藏行不套提交浮窗，右键等同于其贮藏标记', () => {
	// 贮藏是标记而不是提交：与它的引用标记同源，右键走引用菜单，也不显示提交浮动卡片。
	const source = readFileSync(join(clientDir, 'graph', 'index.ts'), 'utf8');
	assert.match(source, /const stashSelector = commit\.stash\?\.selector \?\? null/, '应识别该行是否是贮藏');
	assert.match(source, /\{ type: 'stash', name: stashSelector \}/, '储藏行右键应等价于其贮藏标记');
	// 未点在标记上时回退为该行的贮藏选择器，两条路径因此产出同一份菜单。
	assert.match(source, /refElement\.getAttribute\('data-ref-name'\)[\s\S]{0,80}stashSelector/, '点在标记上取标记，否则取该行贮藏');
});

test('未提交行用虚线且不画节点', () => {
	const source = readFileSync(join(clientDir, 'graph', 'index.ts'), 'utf8');
	assert.match(source, /const node = isUncommitted \? null : \{ x: cx, radius: nodeOuterRadius\(nodeKind\) \}/, '未提交行不传节点，线因此贯穿');
	assert.match(source, /strokeDasharray: '2 2'/, '未提交行的线应是虚线');
	assert.match(source, /const nodes = isUncommitted/, '未提交行不渲染任何节点元素');
});

test('浮窗显示完整提交信息', () => {
	// 列表的 message 来自 `%s`（只有标题），完整正文按需取回后传给卡片。
	const graphSource = readFileSync(join(clientDir, 'graph', 'index.ts'), 'utf8');
	assert.match(graphSource, /const original = typeof message === 'string'/, '卡片优先使用完整提交信息');
	const apiSource = readFileSync(join(clientDir, 'api', 'commits.ts'), 'utf8');
	assert.match(apiSource, /export async function loadCommitMessage/, '应有取完整信息的函数');
	assert.match(apiSource, /details\.body/, '应取 commitDetails 的 body');
	const hookSource = readFileSync(join(panelDir, 'use-commit-stats.ts'), 'utf8');
	assert.match(hookSource, /messageByHash/, 'hook 应缓存完整信息');
	assert.match(hookSource, /requestCommitMessage\(hash\)/, '悬停时应拉取完整信息');
});

test('卡片正文更紧凑且不留空行', () => {
	// 只有正文收紧：标题（首行）沿用卡片自身字号。
	const graphSource = readFileSync(join(clientDir, 'graph', 'index.ts'), 'utf8');
	assert.match(graphSource, /variant: 'compact'/, 'markdown 应用 compact 变体');
	assert.match(graphSource, /const \[originalTitle, \.\.\.bodyLines\] = fullMessage\.split\('\\n'\)/, '首行作标题、其余作正文');
	assert.match(graphSource, /bodyLines\.filter\(\(line\) => line\.trim\(\) !== ''\)/, '正文应滤掉空行');
	assert.match(graphSource, /className: css\.cardTitle/, '标题单独渲染');
	assert.match(graphSource, /className: css\.cardBody/, '正文单独渲染');
	const styles = cssFile('graph.module.css');
	// 标题不改字号。
	const title = /\.cardTitle\{([^}]*)\}/.exec(styles);
	assert.ok(title !== null, '未找到 .cardTitle');
	assert.ok(!/font-size/.test(title[1]), '标题不应改字号');
	// 正文更小、更紧。
	const body = /\.cardBody\{([^}]*)\}/.exec(styles);
	assert.ok(body !== null, '未找到 .cardBody');
	assert.match(body[1], /font-size:11px/, '正文字号应更小');
	assert.match(body[1], /line-height:1\.35/, '正文行距应更紧');
	// 卡片自身字号不变。
	const card = /\.card\{([^}]*)\}/.exec(styles);
	assert.match(card[1], /font-size:12px/, '卡片字号不应改动');
	assert.match(styles, /data-markdown-variant='compact'\]\s*:is\(p, ul, ol, blockquote\)\{margin:0\}/, 'markdown 段距应压到 0');
});

test('差异面板默认自动换行', () => {
	// 长行不换行会被横向裁掉，需要横向滚动才能看全，因此默认开。
	const source = readFileSync(join(clientDir, 'index.ts'), 'utf8');
	const wrap = /const \[wrap, setWrap\] = React\.useState\((true|false)\)/.exec(source);
	assert.ok(wrap !== null, '未找到 wrap 初始值');
	assert.equal(wrap[1], 'true', '换行应默认开启');
});

test('删除分支只列以该提交为尖端的分支', () => {
	// 包含该提交的分支是它的后代，删除后不影响该提交：作为候选会让「删除分支」指向无关分支。
	const menu = readFileSync(join(panelDir, 'commit-menu.ts'), 'utf8');
	const build = menu.slice(menu.indexOf('deleteBranch: (ctx, meta) =>'), menu.indexOf('checkoutRemoteBranch: (ctx, meta) =>'));
	assert.match(build, /ctx\.tipBranches\.filter/, '本地候选取自尖端分支');
	assert.match(build, /ctx\.tipRemoteBranches/, '远程候选取自尖端远程分支');
	assert.ok(!/containing\.local/.test(build), '不得用包含关系当候选');
	// 远程分支名自带远程名前缀，不再另加后缀。
	assert.ok(!/（远程）/.test(build), '远程分支不另加后缀');

	const api = readFileSync(join(clientDir, 'api', 'commits.ts'), 'utf8');
	assert.match(api, /export async function branchesContaining/, 'API 客户端应有该命令');
	const routes = readFileSync(join(root, 'src', 'source-control', 'routes.ts'), 'utf8');
	assert.match(routes, /'branch', '--contains'/, '宿主应执行 git branch --contains');
	assert.match(routes, /!remoteNames\.has\(line\)/, '应排除远程 HEAD 符号引用（短名为远程名本身）');
});

test('异步打开提交菜单前先取出事件字段', () => {
	// openCommitMenu 会 await 查询分支；React 的 currentTarget 在 await 之后已失效。
	const menu = readFileSync(join(panelDir, 'commit-menu.ts'), 'utf8');
	const body = menu.slice(menu.indexOf('export async function openCommitMenu'));
	const syncIndex = body.indexOf('const target = event.currentTarget');
	const awaitIndex = body.indexOf('await makeContext');
	assert.ok(syncIndex !== -1, '应取出 currentTarget');
	assert.ok(awaitIndex !== -1, '应有 await 查询');
	assert.ok(syncIndex < awaitIndex, 'currentTarget 必须在 await 之前取出');
	assert.match(body, /const \{ clientX, clientY \} = event/, '坐标也应提前取出');
});

test('工作树占用的分支照常显示，只禁用检出、删除与重命名', () => {
	// 被工作树检出的分支会出现在 git branch 里，但 git 拒绝删除它们，也不能在本工作树检出。
	// 这类分支仍作为标签显示：它们确实指向该提交，隐藏会让图形区少一个真实存在的分支。
	const routes = readFileSync(join(root, 'src', 'source-control', 'routes.ts'), 'utf8');
	assert.match(routes, /branchesOfOtherWorktrees\(repo\)/, '宿主应判定别的工作树占用的分支');
	assert.match(routes, /foreignBranches: \[\.\.\.foreign\]/, 'loadCommits 应回投占用分支而不是过滤掉标签');
	assert.ok(!/heads: commit\.heads\.filter/.test(routes), '不得再从 heads 里删除占用分支');
	assert.match(routes, /foreign: \[\.\.\.foreign\]/, 'branchesContaining 应回投占用分支供禁用操作');

	const menu = readFileSync(join(panelDir, 'commit-menu.ts'), 'utf8');
	assert.match(menu, /function localBranchItem/, '本地分支操作应统一经占用判定');
	assert.match(menu, /const FOREIGN_BRANCH_HINT/, '占用分支的不可用原因应有说明');
	for (const builder of ['checkoutBranch', 'renameBranch', 'deleteBranch', 'mergeIntoBranch']) {
		const body = menu.slice(menu.indexOf(`${builder}: (ctx, meta) =>`));
		assert.ok(body.includes('localBranchItem') || body.includes('isForeignBranch'), `${builder} 应判定占用分支`);
	}

	const discovery = readFileSync(join(root, 'src', 'source-control', 'repo-discovery.ts'), 'utf8');
	assert.match(discovery, /'worktree', 'list', '--porcelain'/, '应枚举工作树');
	assert.match(discovery, /foreignWorktreeBranches\(parseWorktreeList/, '应复用纯函数判定');
});

test('工作树右键提供移除入口', () => {
	const panel = readFileSync(join(clientDir, 'panel', 'index.ts'), 'utf8');
	assert.match(panel, /isLinkedWorktree = node\.kind === 'worktree'/, '仅链接工作树可移除');
	assert.match(panel, /await removeWorktree\(/, '应调用移除命令');
	assert.match(panel, /showCheckbox\(\{[\s\S]{0,200}?danger: true/, '移除前应先经破坏性确认');
	// 移除目标可能正是当前选中的工作树：不能拿它当后续 git 调用的工作目录。
	assert.match(panel, /await removeWorktree\(node\.path, node\.path, true\)/, '以工作树路径为目标执行移除');
	assert.match(panel, /\}, node\.path\);\s*\n\s*\/\/ 该节点已不存在/, '移除后不对被删工作树做刷新');
	const api = readFileSync(join(clientDir, 'api', 'working-tree.ts'), 'utf8');
	assert.match(api, /export async function removeWorktree/, 'API 客户端应有移除工作树');
	assert.match(api, /command: 'removeWorktree'/, '命令名应与宿主一致');
	const host = readFileSync(join(root, 'src', 'source-control', 'working-tree.ts'), 'utf8');
	assert.match(host, /'worktree', 'remove'/, '宿主应执行 git worktree remove');
	assert.match(host, /removalCwd/, '移除时的工作目录应避开被删目录');
	assert.match(host, /resolveGitCommonDir/, '应退回 git 公共目录');
});

test('删除当前分支时提示而非静默失败', () => {
	// 当前分支仍在候选里，但点击后说明原因。
	const menu = readFileSync(join(panelDir, 'commit-menu.ts'), 'utf8');
	assert.match(menu, /name === deps\.head/, '删除分支应识别当前分支');
	assert.match(menu, /await deps\.notify\(/, '应给出不可删除的提示');
	// 删除项不再置灰，改为点击后提示。
	const deleteItem = /return \{ title: meta\.title, danger: meta\.danger, onClick/.exec(menu);
	assert.ok(deleteItem !== null, '未找到删除分支项');
	assert.ok(!/disabled/.test(deleteItem[0]), '删除项不应置灰，改为点击后提示');
	// 提示走顶部轻量横幅，不再使用需要关闭的模态弹窗。
	const toast = readFileSync(join(panelDir, 'toast.ts'), 'utf8');
	assert.match(toast, /export function showToast/, '应提供轻量提示');
	assert.match(toast, /from '@deepseek-ai\/dsh-client-ui-primitives'/, '提示应复用 ui-primitives 的 Toast');
});

test('提交菜单与引用菜单共用同一份操作注册表', () => {
	// 两处菜单由 ACTIONS 驱动：引用菜单按 refTypes 过滤，不再各自维护一份定义。
	const menu = readFileSync(join(panelDir, 'commit-menu.ts'), 'utf8');
	// 元数据（引用类型与菜单名称）在 JSON 数据源里，处理函数按 id 绑在本文件。
	const { actions } = JSON.parse(readFileSync(join(panelDir, 'menu-actions.json'), 'utf8'));
	assert.ok(Array.isArray(actions) && actions.length > 0, '注册表数据源应有操作');
	for (const action of actions) {
		assert.ok(Array.isArray(action.refTypes) && action.refTypes.length > 0, `${action.id} 应声明适用的引用类型`);
		assert.ok(typeof action.title === 'string' && action.title !== '', `${action.id} 应有菜单名称`);
		assert.match(menu, new RegExp(`${action.id}: \\(ctx, meta\\) =>`), `${action.id} 应有对应的处理函数`);
	}
	assert.match(menu, /export async function openCommitMenu/, '应导出提交菜单');
	assert.match(menu, /export async function openRefMenu/, '应导出引用菜单');
	assert.match(menu, /action\.refTypes\.includes\(refInfo\.type\)/, '引用菜单应按引用类型过滤');
	assert.ok(!existsSync(join(panelDir, 'ref-menu.ts')), '不应再保留独立的 ref-menu 模块');
	// 提交行右键应能直接发起「合并到选中分支」，无需命中分支标签。
	assert.match(menu, /ctx\.tipBranches/, '提交菜单应依据分支尖端列出合并目标');
	assert.match(menu, /mergeIntoBranch\(ctx\.repo, name, ctx\.commit\.hash\)/, '提交菜单应能直接合并到分支');
	// 作用于当前分支的操作在提交行右键也要有入口，不能只挂在分支标签的引用菜单上。
	assert.match(menu, /push\(items, byId\('createPullRequest'\)\)/, '提交菜单应列出创建 Pull Request 入口');
});

test('表单勾选项的文案只由 Checkbox 渲染', () => {
	// Checkbox 自身携带可见文案且根元素是 `<label>`：再包一层 label 或另加文案节点会让文案显示两次。
	const dialog = readFileSync(join(clientDir, 'ui', 'dialog.ts'), 'utf8');
	assert.ok(!/ggg-field-text(?!area)/.test(dialog), '不应再另加文案节点');
	assert.match(dialog, /label: field\.label \?\? ''/, '勾选字段应把文案交给 Checkbox');
	assert.match(dialog, /label: option\.label/, '多选字段应把每项文案交给 Checkbox');
	const styles = cssFile('dialog.module.css');
	assert.ok(!/\.fieldText(?!area)/.test(styles), '无用的文案节点样式应一并移除');
});
