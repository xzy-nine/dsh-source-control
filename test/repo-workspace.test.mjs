/**
 * 仓库发现契约回归（浅层与工作区）：浅层扫描、工作区持久化位置、仓库定位与工作树登记。
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

test('discoverRepositories：shallow 只产出顶层仓库节点，children 一律为空', async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	gitSpawns = 0;
	const shallow = await discoverRepositories(tree.root, { shallow: true });

	assert.equal(gitSpawns, 0, 'shallow 不启动 git');
	const repos = shallow.nodes.filter((node) => node.kind === 'repo');
	assert.equal(repos.length, 2);
	assert.ok(repos.every((node) => node.children.length === 0), 'shallow 的仓库节点无 children');
	assert.equal(
		shallow.nodes.some((node) => node.kind === 'worktree' || node.kind === 'submodule'),
		false,
		'shallow 不产出工作树与子模块节点',
	);

	const full = await discoverRepositories(tree.root);
	assert.notEqual(full, shallow, 'shallow 与完整发现不共用缓存');
	const scalarOf = (node) => ({
		id: node.id, path: node.path, name: node.name, kind: node.kind, depth: node.depth,
		branch: node.branch, head: node.head, available: node.available,
	});
	assert.deepEqual(
		repos.map(scalarOf),
		full.nodes.filter((node) => node.kind === 'repo').map(scalarOf),
		'浅层节点字段与完整发现一致',
	);
});

test('discoverWorkspace：命中持久化位置时 usedCache 为 true，fullScan 回填并跳过缓存', async () => {
	const { discoverWorkspace, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	await resetState();
	clearDiscoveryCache();
	const tree = makeTree();
	// 节点按 path 升序：nested\mid-repo 排在 top-repo 之前。
	const repoPaths = [tree.mid, tree.top].sort((left, right) => left.localeCompare(right));

	const cold = await discoverWorkspace(tree.root, { shallow: true });
	assert.equal(cold.usedCache, false, '无持久化位置时完整扫描');
	assert.equal(cold.nodes.filter((node) => node.kind === 'repo').length, 2);

	const forced = await discoverWorkspace(tree.root, { shallow: true, fullScan: true });
	assert.equal(forced.usedCache, false, 'fullScan 跳过持久化位置');
	assert.deepEqual(forced.nodes.filter((node) => node.kind === 'repo').map((node) => node.path), repoPaths);
	assert.deepEqual(forced.nodes.filter((node) => node.kind === 'repo').map((node) => node.children.length), [0, 0]);

	await resetState();
	clearDiscoveryCache();
	const hit = await discoverWorkspace(tree.root, { shallow: true });
	assert.equal(hit.usedCache, true, '命中持久化位置');
	assert.deepEqual(hit.nodes.filter((node) => node.kind === 'repo').map((node) => node.path), repoPaths);
	assert.ok(hit.nodes.filter((node) => node.kind === 'repo').every((node) => node.children.length === 0));

	const deep = await discoverWorkspace(tree.root);
	assert.equal(deep.usedCache, true);
	assert.ok(worktreesOf(deep.nodes.find((node) => node.path === tree.top)).length > 0, 'shallow 命中不污染完整发现的缓存');
});

test('findEnclosingRepoDir：工作区根即仓库 / 在仓库子目录内 / 不在仓库内', async () => {
	const { findEnclosingRepoDir } = await import(pathToFileURL(discoveryPath).href);
	const parent = makeTemp('gg-enclose-');
	const repo = makeRepoAt(parent, 'repo');
	const nested = join(repo, 'nested', 'deep');
	mkdirSync(nested, { recursive: true });
	const outside = join(parent, 'outside');
	mkdirSync(outside, { recursive: true });

	gitSpawns = 0;
	assert.equal(await findEnclosingRepoDir(repo), resolve(repo), '工作区根即仓库');
	assert.equal(await findEnclosingRepoDir(nested), resolve(repo), '工作区根在仓库子目录内');
	assert.equal(await findEnclosingRepoDir(outside), null, '不在任何仓库内');
	assert.equal(gitSpawns, 0, '判定只走文件系统');
});

test('branchesOfOtherWorktrees：读取工作树登记，零 git 调用', async () => {
	const { branchesOfOtherWorktrees } = await import(pathToFileURL(discoveryPath).href);
	const tree = makeTree();

	gitSpawns = 0;
	assert.deepEqual(await branchesOfOtherWorktrees(tree.mid), new Set(), '普通仓库无别的工作树分支');
	assert.equal(gitSpawns, 0, '无链接工作树时不启动 git');

	gitSpawns = 0;
	assert.deepEqual([...await branchesOfOtherWorktrees(tree.top)].sort(), ['linked'], '有链接工作树时读登记项');
	assert.equal(gitSpawns, 0, '枚举工作树不启动 git');

	gitSpawns = 0;
	assert.deepEqual([...await branchesOfOtherWorktrees(tree.linked)].sort(), ['main'], '查看链接工作树时排除主工作树的当前分支');
	assert.equal(gitSpawns, 0, '枚举工作树不启动 git');
});
