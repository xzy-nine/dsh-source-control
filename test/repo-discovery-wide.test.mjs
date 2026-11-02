/**
 * 仓库发现契约回归（同层多目录）：结果与串行语义一致。
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

test('discoverRepositories：同层目录多时结果与串行语义一致', async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	const wide = makeTemp('gg-disc-wide-');
	const expected = [];
	for (let i = 0; i < 30; i++) {
		const repo = makeRepoAt(wide, `r${String(i).padStart(2, '0')}`);
		expected.push(repo);
	}

	clearDiscoveryCache();
	const result = await discoverRepositories(wide, { maxDepth: 1 });

	const paths = result.nodes.map((node) => node.path);
	assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right)), '节点按 path 升序');
	assert.deepEqual(paths, expected, '同层 30 个仓库全部发现');
	assert.equal(result.truncated, false);
	assert.ok(result.nodes.every((node) => node.depth === 1 && node.kind === 'repo'), '同层仓库 depth 均为 1');
});
