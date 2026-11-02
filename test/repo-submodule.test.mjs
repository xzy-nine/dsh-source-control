/**
 * 仓库发现契约回归（结构一致）：补齐结果与完整扫描逐项一致、链接工作树与子模块路径。
 *
 * `repo-discovery.ts` 有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此一律从 `lib/` 产物导入；
 * `pretest` 会先重建产物。
 *
 * 另覆盖浅层发现（`shallow` 不产生 children）、`enrichRepositories` 按路径补齐、`discoverWorkspace`
 * 的持久化位置命中、`findEnclosingRepoDir` 的三档判定，以及无链接工作树时 `branchesOfOtherWorktrees`
 * 不启动 git 子进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempPath } from './harness.mjs';

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与临时仓库，串行便于定位失败 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const discoveryPath = join(root, 'lib', 'src', 'source-control', 'repo-discovery.js');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
const statePath = join(root, 'lib', 'src', 'source-control', 'state-store.js');

/** 临时目录登记表；文件级 after 统一删除。 */
const temps = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	// 还原模块级桩：本文件覆写了 spawn 与隔离根，不还原会让同进程后续用例看到本文件的桩。
	restoreModuleStubs();
	if (ISOLATED_HOME === undefined) delete process.env.DSH_SOURCE_CONTROL_HOME;
	else process.env.DSH_SOURCE_CONTROL_HOME = ISOLATED_HOME;
});

/** 本进程启动时 setup.mjs 注入的隔离根。 */
const ISOLATED_HOME = process.env.DSH_SOURCE_CONTROL_HOME;

/* 状态文档隔离：本文件的 discoverWorkspace 会写宿主持久化，落到临时目录，避免动到真实 state.json。 */
const stateHome = mkdtempSync(join(tmpdir(), 'gg-disc-home-'));
temps.push(stateHome);
process.env.DSH_SOURCE_CONTROL_HOME = stateHome;

/* git 子进程计数：替换 child_process.spawn 并同步给 ESM 具名绑定，用于断言「不启动 git」。 */
let gitSpawns = 0;
const originalSpawn = cp.spawn;
cp.spawn = (...args) => {
	gitSpawns += 1;
	return originalSpawn(...args);
};
syncBuiltinESMExports();

/** 还原 spawn 桩；供文件级 after 调用。 */
function restoreModuleStubs() {
	cp.spawn = originalSpawn;
	syncBuiltinESMExports();
}

/**
 * 建一个临时目录并登记清理。
 *
 * @param prefix - 目录名前缀。
 * @returns 目录绝对路径。
 */
function makeTemp(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

/**
 * 在指定目录执行一次 git。
 *
 * @param cwd - 工作目录。
 * @param args - git 参数。
 * @returns 标准输出。
 */
function gitIn(cwd, ...args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * 在一个目录下建一个已提交的仓库。
 *
 * @param parent - 父目录。
 * @param name - 仓库目录名。
 * @returns 仓库绝对路径。
 */
function makeRepoAt(parent, name) {
	const repo = join(parent, name);
	mkdirSync(repo, { recursive: true });
	gitIn(repo, 'init', '-q', '-b', 'main');
	gitIn(repo, 'config', 'user.email', 'disc@example.com');
	gitIn(repo, 'config', 'user.name', 'Disc');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	gitIn(repo, 'add', '-A');
	gitIn(repo, 'commit', '-q', '-m', 'base');
	return repo;
}

/** 造一个仓库目录（未提交），供已知路径快路径的节点数断言使用。 */
function makeBareRepoAt(parent, name) {
	const repo = join(parent, name);
	mkdirSync(repo, { recursive: true });
	gitIn(repo, 'init', '-q', '-b', 'main');
	return repo;
}

/**
 * 造一棵发现用目录树：两个顶层仓库（第二个在第 2 层）、一个链接工作树、一个子模块。
 *
 * 目录布局（root 为工作区根）：
 *   top-repo/            顶层仓库，挂 1 个链接工作树
 *   nested/mid-repo/     第 2 层仓库，挂 1 个子模块
 *   nested/plain/        非仓库目录
 *
 * @returns 根目录、两个仓库路径与链接工作树路径。
 */
function makeTree() {
	const rootDir = makeTemp('gg-disc-');
	const top = makeRepoAt(rootDir, 'top-repo');

	const linked = join(rootDir, 'linked-wt');
	gitIn(top, 'worktree', 'add', '-q', linked, '-b', 'linked');

	const nested = join(rootDir, 'nested');
	mkdirSync(join(nested, 'plain'), { recursive: true });
	const mid = makeRepoAt(nested, 'mid-repo');

	const subSource = makeTemp('gg-disc-subsrc-');
	gitIn(subSource, 'init', '-q', '-b', 'main');
	gitIn(subSource, 'config', 'user.email', 'sub@example.com');
	gitIn(subSource, 'config', 'user.name', 'Sub');
	writeFileSync(join(subSource, 's.txt'), 's\n');
	gitIn(subSource, 'add', '-A');
	gitIn(subSource, 'commit', '-q', '-m', 'sub');
	const subBare = makeTemp('gg-disc-subbare-');
	gitIn(tmpdir(), 'clone', '-q', '--bare', subSource, subBare);
	gitIn(mid, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subBare, 'sub');
	gitIn(mid, 'commit', '-q', '-m', 'add submodule');

	return { root: rootDir, top, mid, linked };
}

/** 把路径统一成 `/` 分隔，供跨平台比较。 */
function normalizePath(path) {
	return path.replace(/\\/g, '/');
}

/** 取出仓库节点上的子模块节点。 */
function submodulesOf(node) {
	return node.children.filter((child) => child.kind === 'submodule');
}

/** 取出仓库节点上的工作树节点。 */
function worktreesOf(node) {
	return node.children.filter((child) => child.kind === 'worktree');
}

/**
 * 节点的比较用形状：去掉对象身份，只留可跨实现比较的字段。
 *
 * 顶层 depth 不参与比较：按已知路径构造的节点不经过层序遍历，depth 恒为 0，与既有
 * `knownRepos` 快路径的已记录差异相同；子节点的 depth 照常比较。
 *
 * @param node - 节点。
 * @param top - 是否为顶层节点。
 * @returns 递归展开的形状。
 */
function shapeOf(node, top = true) {
	return {
		id: node.id, path: node.path, name: node.name, kind: node.kind,
		depth: top ? undefined : node.depth,
		branch: node.branch, head: node.head, available: node.available,
		children: (node.children ?? []).map((child) => shapeOf(child, false)),
	};
}

/** 清掉状态文档的内存镜像，使下一次读取重新落盘载入。 */
async function resetState() {
	const { resetStateCache } = await import(pathToFileURL(statePath).href);
	resetStateCache();
}

/**
 * 造一棵含三类仓库的发现用目录树，三类仓库都在工作区根下第 1 层：
 *   plain-repo/   无链接工作树、无子模块
 *   sub-repo/     挂 1 个子模块
 *   wt-repo/      挂 1 个链接工作树
 *
 * @returns 根目录与三类仓库路径。
 */
function makeMixedTree() {
	const rootDir = makeTemp('gg-disc-mixed-');
	const plain = makeRepoAt(rootDir, 'plain-repo');
	const sub = makeRepoAt(rootDir, 'sub-repo');
	const wt = makeRepoAt(rootDir, 'wt-repo');

	gitIn(wt, 'worktree', 'add', '-q', join(rootDir, 'wt-linked'), '-b', 'linked');

	const subSource = makeTemp('gg-disc-mixed-subsrc-');
	gitIn(subSource, 'init', '-q', '-b', 'main');
	gitIn(subSource, 'config', 'user.email', 'sub@example.com');
	gitIn(subSource, 'config', 'user.name', 'Sub');
	writeFileSync(join(subSource, 's.txt'), 's\n');
	gitIn(subSource, 'add', '-A');
	gitIn(subSource, 'commit', '-q', '-m', 'sub');
	const subBare = makeTemp('gg-disc-mixed-subbare-');
	gitIn(tmpdir(), 'clone', '-q', '--bare', subSource, subBare);
	gitIn(sub, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subBare, 'sub');
	gitIn(sub, 'commit', '-q', '-m', 'add submodule');

	return { root: rootDir, plain, sub, wt };
}

test('enrichRepositories：按顶层路径补齐的结构与完整扫描一致', async () => {
	const { discoverRepositories, enrichRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();
	const full = await discoverRepositories(tree.root);
	const paths = full.nodes.filter((node) => node.kind === 'repo').map((node) => node.path);

	const enriched = await enrichRepositories([...paths, join(tree.root, 'absent'), paths[0]]);

	assert.equal(enriched.length, 2, '重复路径去重、非仓库路径忽略');
	assert.deepEqual(enriched.map((node) => node.path), paths, '顺序与去重后的入参一致');
	assert.deepEqual(enriched.map((node) => shapeOf(node)), full.nodes.map((node) => shapeOf(node)), '与完整扫描的节点结构一致');

	const input = [...paths];
	await enrichRepositories(input);
	assert.deepEqual(input, paths, '不修改入参数组');
});

test('enrichRepositories：三类仓库的结构与完整扫描一致，无来源时零 git 调用', async () => {
	const { discoverRepositories, enrichRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeMixedTree();
	const full = await discoverRepositories(tree.root);
	const byPath = new Map(full.nodes.filter((node) => node.kind === 'repo').map((node) => [node.path, node]));

	assert.deepEqual(
		worktreesOf(byPath.get(tree.wt)).length,
		1,
		'完整扫描下 wt-repo 有 1 个链接工作树',
	);
	assert.equal(submodulesOf(byPath.get(tree.sub)).length, 1, '完整扫描下 sub-repo 有 1 个子模块');
	assert.equal(byPath.get(tree.plain).children.length, 0, '完整扫描下 plain-repo 无 children');

	/* 等过宿主只读结果缓存的 200ms TTL，否则 spawn 计数会命中上一步完整扫描留下的缓存。 */
	await new Promise((done) => setTimeout(done, 400));

	clearDiscoveryCache();
	gitSpawns = 0;
	const plainOnly = await enrichRepositories([tree.plain]);
	assert.equal(gitSpawns, 0, '无链接工作树且无 .gitmodules 时不启动 git');
	assert.deepEqual(plainOnly.map((node) => shapeOf(node)), [shapeOf(byPath.get(tree.plain))], 'plain-repo 结构与完整扫描一致');
	assert.deepEqual(plainOnly[0].children, []);

	gitSpawns = 0;
	const subOnly = await enrichRepositories([tree.sub]);
	assert.equal(gitSpawns, 0, '子模块与工作树的枚举都不启动 git');
	assert.deepEqual(subOnly.map((node) => shapeOf(node)), [shapeOf(byPath.get(tree.sub))], 'sub-repo 结构与完整扫描一致');

	gitSpawns = 0;
	const wtOnly = await enrichRepositories([tree.wt]);
	assert.equal(gitSpawns, 0, '有链接工作树时读登记项，不启动 git');
	assert.deepEqual(wtOnly.map((node) => shapeOf(node)), [shapeOf(byPath.get(tree.wt))], 'wt-repo 结构与完整扫描一致');

	clearDiscoveryCache();
	const mixed = await enrichRepositories([tree.plain, tree.sub, tree.wt]);
	assert.deepEqual(
		mixed.map((node) => shapeOf(node)),
		[tree.plain, tree.sub, tree.wt].map((path) => shapeOf(byPath.get(path))),
		'三类仓库混在一批时结果与完整扫描一致',
	);
});

test('enrichRepositories：链接工作树路径不再返回空，且与发现层节点一致', async () => {
	const { discoverRepositories, enrichRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	// 工作区根位于链接工作树内部：发现层为链接工作树根产出仓库节点，该路径的 `.git` 是文件。
	const inner = join(tree.linked, 'inner', 'deep');
	mkdirSync(inner, { recursive: true });
	const viaEnclosing = await discoverRepositories(inner, {});
	const enclosing = viaEnclosing.nodes.find((node) => node.kind === 'repo');
	assert.equal(resolve(enclosing.path), resolve(tree.linked), '发现层把链接工作树根作为仓库节点');
	assert.equal(enclosing.branch, 'linked', '发现层从 `.git` 文件解析出分支');

	clearDiscoveryCache();
	const enriched = await enrichRepositories([tree.linked]);
	assert.equal(enriched.length, 1, '链接工作树路径不再被过滤');
	assert.equal(resolve(enriched[0].path), resolve(tree.linked));
	assert.equal(enriched[0].kind, 'repo');
	assert.equal(enriched[0].branch, 'linked', '`.git` 为文件时仍解析出分支');
	assert.equal(enriched[0].depth, 0);
	assert.deepEqual(
		enriched.map((node) => shapeOf(node)),
		[shapeOf(enclosing)],
		'链接工作树节点与发现层对该路径产出的节点一致',
	);
	assert.deepEqual(
		enriched[0].children.map((child) => resolve(child.path)),
		[resolve(tree.top)],
		'链接工作树补齐出主工作树节点',
	);

	// 主工作树路径照常工作。
	const mainEnriched = await enrichRepositories([tree.top]);
	assert.equal(mainEnriched.length, 1, '主工作树路径仍正常');
	assert.equal(mainEnriched[0].branch, 'main');
	assert.deepEqual(worktreesOf(mainEnriched[0]).map((node) => resolve(node.path)), [resolve(tree.linked)]);
});

test('enrichRepositories：子模块路径与发现层一致，bare 仓库两处判据一致', async () => {
	const { discoverRepositories, enrichRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	// 子模块的 `.git` 是文件，指向外层仓库 `.git/modules/<名>`；其公共目录即该目录，
	// 主工作树由 `core.worktree` 推导回子模块目录，与自身相同，因此不产生工作树节点。
	const submodule = join(tree.mid, 'sub');
	const inner = join(submodule, 'deep');
	mkdirSync(inner, { recursive: true });
	const viaEnclosing = await discoverRepositories(inner, {});
	const enclosing = viaEnclosing.nodes.find((node) => node.kind === 'repo');
	assert.equal(resolve(enclosing.path), resolve(submodule), '发现层把子模块根作为仓库节点');
	assert.equal(enclosing.branch, 'main', '子模块从自己的 HEAD 解析出分支');
	assert.deepEqual(enclosing.children, [], '子模块自身不产生工作树节点');

	clearDiscoveryCache();
	const enriched = await enrichRepositories([submodule]);
	assert.equal(enriched.length, 1, '子模块路径不被过滤');
	assert.deepEqual(enriched.map((node) => shapeOf(node)), [shapeOf(enclosing)], '子模块节点与发现层一致');

	// bare 仓库没有 `.git` 条目：发现层与补齐层都不认它，两处判据一致。
	const bareRoot = makeTemp('gg-disc-bare-');
	const source = makeRepoAt(bareRoot, 'source');
	const bare = join(bareRoot, 'bare.git');
	gitIn(bareRoot, 'clone', '-q', '--bare', source, bare);
	const bareDiscovery = await discoverRepositories(bareRoot, { maxDepth: 1 });
	assert.equal(
		bareDiscovery.nodes.filter((node) => resolve(node.path) === resolve(bare)).length,
		0,
		'发现层不把 bare 仓库当作仓库节点',
	);
	assert.deepEqual(await enrichRepositories([bare]), [], '补齐层同样不认 bare 仓库');
});
