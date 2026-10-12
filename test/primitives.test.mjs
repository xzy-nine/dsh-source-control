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

test('新增文件走普通文件地址', () => {
	// 新增文件没有旧侧内容，必须走 dsh-resource://file/… 而不是 git-diff 地址。
	const indexPath = join(clientDir, 'index.ts');
	const source = readFileSync(indexPath, 'utf8');
	assert.match(source, /diffFileAddress/, 'index.ts 应使用普通文件地址构造函数');
	assert.match(source, /diff\.kind === 'file'/, '应按 file 类型分支处理');
	const panelSource = readFileSync(join(clientDir, 'panel.ts'), 'utf8');
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
	const css = readFileSync(join(clientDir, 'file-diff.module.css'), 'utf8');
	assert.match(css, /\.columns/, '并排布局依赖 columns 样式');
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

test('文件差异视图为复制自 DSH 的实现', () => {
	// ui-deliverables 的 FileDiff 未从 ui-primitives 导出，插件无法引用，故按 MIT 许可复制。
	const viewSource = readFileSync(join(clientDir, 'file-diff.tsx'), 'utf8');
	assert.match(viewSource, /MIT 许可/, '应标明来源与许可');
	assert.match(viewSource, /ui-deliverables/, '应写明来源路径');
	assert.match(viewSource, /export function FileDiff/, '应导出 FileDiff');
	assert.match(viewSource, /export function hunkRows/, '应保留原实现的行号计算');
	assert.match(viewSource, /from '\.\/file-diff\.module\.css'/, '应通过 CSS 模块引用样式');
	const cssSource = readFileSync(join(clientDir, 'file-diff.module.css'), 'utf8');
	assert.match(cssSource, /\.number/, 'CSS 模块应含行号列样式');
	assert.match(cssSource, /\.hunkHeader/, 'CSS 模块应含 hunk 头样式');
	const indexSource = readFileSync(join(clientDir, 'index.ts'), 'utf8');
	assert.match(indexSource, /from '\.\/file-diff\.tsx'/, '差异页应引用复制的视图');
	assert.ok(!indexSource.includes('DiffBlock'), '不应再使用 ui-primitives 的 DiffBlock');
	const routes = readFileSync(join(root, 'src', 'git-graph', 'routes.ts'), 'utf8');
	assert.match(routes, /parseUnifiedDiffHunks/, '宿主应解析 git 的统一差异');
	assert.match(routes, /--unified=3/, '宿主应请求带上下文的统一差异');
});

test('构建脚本把 CSS 模块的样式内联进包', () => {
	// esbuild 的 local-css 只产出类名映射；样式文本必须显式内联，否则视图无样式。
	const script = readFileSync(join(root, 'scripts', 'build-client.mjs'), 'utf8');
	assert.match(script, /'\.css': 'local-css'/, 'CSS 应作为模块处理');
	assert.match(script, /endsWith\('\.css'\)/, '应收集 esbuild 产出的样式');
	assert.match(script, /dsh-dev-git-graph-module-style/, '应把样式内联为一段 style');
	assert.match(script, /jsx: 'automatic'/, '复制的视图使用自动 JSX 运行时');
});

test('宿主 hunk 形状与视图一致', () => {
	// 视图按 DSH 的 WorkspaceDiffHunk 取字段（含行数），宿主必须给出同样的形状。
	const source = readFileSync(join(root, 'src', 'git-graph', 'diff-hunks.ts'), 'utf8');
	for (const field of ['oldStart', 'oldLines', 'newStart', 'newLines', 'lines']) {
		assert.match(source, new RegExp(field), `hunk 应含 ${field}`);
	}
	assert.match(source, /HUNK_HEADER/, '应解析 hunk 头取得行号区间');
});

test('未提交行的文案译为中文', () => {
	// 数据层给出的 message 是 `Uncommitted Changes (2)`，界面须显示中文。
	const source = readFileSync(join(clientDir, 'graph.ts'), 'utf8');
	assert.match(source, /UNCOMMITTED_MESSAGE/, '应有未提交文案的匹配规则');
	assert.match(source, /'未提交的更改'/, '无数量时应显示中文');
	assert.match(source, /未提交的更改（\$\{match\[1\]\}）/, '带数量时应显示中文');
	assert.match(source, /displayMessage\(commit\)/, '行文本应经翻译函数');
});

test('未提交行不触发浮窗与右键', () => {
	// 未提交行不对应真实提交：不给右键菜单，也不套悬停卡片。
	const source = readFileSync(join(clientDir, 'graph.ts'), 'utf8');
	assert.match(source, /onContextMenu: isUncommitted \? undefined/, '未提交行不给右键菜单');
	assert.match(source, /if \(!isUncommitted\) onHover\?\.\(commit\.hash\)/, '未提交行不预取悬停数据');
	assert.match(source, /if \(isUncommitted\) return anchor;/, '未提交行不套 HoverCard');
});

test('未提交行用虚线且不画节点', () => {
	const source = readFileSync(join(clientDir, 'graph.ts'), 'utf8');
	assert.match(source, /const node = isUncommitted \? null : \{ x: cx, radius: nodeOuterRadius\(nodeKind\) \}/, '未提交行不传节点，线因此贯穿');
	assert.match(source, /strokeDasharray: '2 2'/, '未提交行的线应是虚线');
	assert.match(source, /const nodes = isUncommitted/, '未提交行不渲染任何节点元素');
});

test('浮窗显示完整提交信息', () => {
	// 列表的 message 来自 `%s`（只有标题），完整正文按需取回后传给卡片。
	const graphSource = readFileSync(join(clientDir, 'graph.ts'), 'utf8');
	assert.match(graphSource, /const fullMessage = typeof message === 'string'/, '卡片优先使用完整提交信息');
	const apiSource = readFileSync(join(clientDir, 'api.ts'), 'utf8');
	assert.match(apiSource, /export async function loadCommitMessage/, '应有取完整信息的函数');
	assert.match(apiSource, /details\.body/, '应取 commitDetails 的 body');
	const hookSource = readFileSync(join(panelDir, 'use-commit-stats.ts'), 'utf8');
	assert.match(hookSource, /messageByHash/, 'hook 应缓存完整信息');
	assert.match(hookSource, /requestCommitMessage\(hash\)/, '悬停时应拉取完整信息');
});

test('卡片正文更紧凑且不留空行', () => {
	// 只有正文收紧：标题（首行）沿用卡片自身字号。
	const graphSource = readFileSync(join(clientDir, 'graph.ts'), 'utf8');
	assert.match(graphSource, /variant: 'compact'/, 'markdown 应用 compact 变体');
	assert.match(graphSource, /const \[titleLine, \.\.\.bodyLines\] = fullMessage\.split\('\\n'\)/, '首行作标题、其余作正文');
	assert.match(graphSource, /bodyLines\.filter\(\(line\) => line\.trim\(\) !== ''\)/, '正文应滤掉空行');
	assert.match(graphSource, /className: 'ggg-card-title'/, '标题单独渲染');
	assert.match(graphSource, /className: 'ggg-card-body'/, '正文单独渲染');
	const styles = readFileSync(join(clientDir, 'styles.ts'), 'utf8');
	// 标题不改字号。
	const title = /\.ggg-card-title\{([^}]*)\}/.exec(styles);
	assert.ok(title !== null, '未找到 .ggg-card-title');
	assert.ok(!/font-size/.test(title[1]), '标题不应改字号');
	// 正文更小、更紧。
	const body = /\.ggg-card-body\{([^}]*)\}/.exec(styles);
	assert.ok(body !== null, '未找到 .ggg-card-body');
	assert.match(body[1], /font-size:11px/, '正文字号应更小');
	assert.match(body[1], /line-height:1\.35/, '正文行距应更紧');
	// 卡片自身字号不变。
	const card = /\.ggg-card\{([^}]*)\}/.exec(styles);
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

test('删除分支按包含关系列出候选', () => {
	// 分支只由尖端提交标识：中间提交的 heads 为空，只看 heads 会让删除分支在非尖端不可用。
	const menu = readFileSync(join(panelDir, 'commit-menu.ts'), 'utf8');
	assert.match(menu, /branchesContaining/, '应向 git 查询包含该提交的分支');
	assert.match(menu, /containing\.local\.length > 0 \? containing\.local/, '查询结果优先，失败时退回自身引用');
	const api = readFileSync(join(clientDir, 'api.ts'), 'utf8');
	assert.match(api, /export async function branchesContaining/, 'API 客户端应有该命令');
	const routes = readFileSync(join(root, 'src', 'git-graph', 'routes.ts'), 'utf8');
	assert.match(routes, /'branch', '--contains'/, '宿主应执行 git branch --contains');
	assert.match(routes, /!remoteNames\.has\(line\)/, '应排除远程 HEAD 符号引用（短名为远程名本身）');
});

test('异步打开提交菜单前先取出事件字段', () => {
	// openCommitMenu 会 await 查询分支；React 的 currentTarget 在 await 之后已失效。
	const menu = readFileSync(join(panelDir, 'commit-menu.ts'), 'utf8');
	const syncIndex = menu.indexOf('const target = event.currentTarget');
	const awaitIndex = menu.indexOf('await branchesContaining');
	assert.ok(syncIndex !== -1, '应取出 currentTarget');
	assert.ok(awaitIndex !== -1, '应有 await 查询');
	assert.ok(syncIndex < awaitIndex, 'currentTarget 必须在 await 之前取出');
	assert.match(menu, /const \{ clientX, clientY \} = event/, '坐标也应提前取出');
});

test('工作树分支从图形区与删除候选中排除', () => {
	// 被工作树检出的分支会出现在 git branch 里，但 git 拒绝删除它们。
	const routes = readFileSync(join(root, 'src', 'git-graph', 'routes.ts'), 'utf8');
	assert.match(routes, /branchesOfOtherWorktrees\(repo\)/, '宿主应排除别的工作树占用的分支');
	assert.match(routes, /heads: \(commit\.heads \?\? \[\]\)\.filter/, 'loadCommits 应过滤分支标签');
	const discovery = readFileSync(join(root, 'src', 'git-graph', 'repo-discovery.ts'), 'utf8');
	assert.match(discovery, /'worktree', 'list', '--porcelain'/, '应枚举工作树');
	assert.match(discovery, /foreignWorktreeBranches\(parseWorktreeList/, '应复用纯函数判定');
});

test('工作树右键提供移除入口', () => {
	const panel = readFileSync(join(clientDir, 'panel.ts'), 'utf8');
	assert.match(panel, /isLinkedWorktree = node\.kind === 'worktree'/, '仅链接工作树可移除');
	assert.match(panel, /title: '移除工作树…'/, '菜单应有移除工作树');
	assert.match(panel, /await removeWorktree\(/, '应调用移除命令');
	const api = readFileSync(join(clientDir, 'api.ts'), 'utf8');
	assert.match(api, /export async function removeWorktree/, 'API 客户端应有移除工作树');
	assert.match(api, /command: 'removeWorktree'/, '命令名应与宿主一致');
	const host = readFileSync(join(root, 'src', 'git-graph', 'working-tree.ts'), 'utf8');
	assert.match(host, /'worktree', 'remove'/, '宿主应执行 git worktree remove');
});

test('删除当前分支时提示而非静默失败', () => {
	// 当前分支仍在候选里，但点击后说明原因。
	const menu = readFileSync(join(panelDir, 'commit-menu.ts'), 'utf8');
	assert.match(menu, /name === head/, '提交菜单应识别当前分支');
	assert.match(menu, /无法删除当前分支/, '应给出不可删除的提示');
	const refMenu = readFileSync(join(panelDir, 'ref-menu.ts'), 'utf8');
	assert.match(refMenu, /if \(isCurrent\)/, '引用菜单应同样拦截当前分支');
	// 只有删除项不再置灰；检出/重命名/合并/变基对当前分支仍应禁用。
	const deleteItem = /title: '删除分支…'[^}]*\}/.exec(refMenu);
	assert.ok(deleteItem !== null, '未找到删除分支项');
	assert.ok(!/disabled/.test(deleteItem[0]), '删除项不应置灰，改为点击后提示');
	const dialog = readFileSync(join(clientDir, 'dialog.ts'), 'utf8');
	assert.match(dialog, /export function showMessage/, '应提供仅告知的提示框');
});

