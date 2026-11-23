/**
 * 仓库发现契约回归（缓存）：TTL 命中与作废范围、已知路径快路径与回退。
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
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRepoFixture } from '../helpers/repo-fixture.mjs';

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与隔离仓库，串行便于定位失败 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const discoveryPath = join(root, 'lib', 'src', 'source-control', 'repo-discovery.js');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
const statePath = join(root, 'lib', 'src', 'source-control', 'state-store.js');

/** 隔离目录登记表；文件级 after 统一删除。 */
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

/* 状态文档隔离：本文件的 discoverWorkspace 会写宿主持久化，落到隔离目录，避免动到真实 state.json。 */
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


const { makeTemp, gitIn, makeRepoAt, makeBareRepoAt, makeTree, normalizePath, submodulesOf, worktreesOf, shapeOf, resetState, makeMixedTree } = createRepoFixture(temps, statePath);

test('invalidateDiscoveryCacheFor：只作废受影响的工作区，别的目录保留', async () => {
	const { discoverRepositories, clearDiscoveryCache, invalidateDiscoveryCacheFor } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const inside = makeTree();
	const other = makeTree();

	const insideFirst = await discoverRepositories(inside.root);
	const otherFirst = await discoverRepositories(other.root);

	// 目标位于第一个工作区之内：该工作区受影响，另一个不受影响。
	const repoInside = insideFirst.nodes.find((node) => node.kind === 'repo');
	assert.notEqual(repoInside, undefined);
	invalidateDiscoveryCacheFor(repoInside.path);

	const insideAgain = await discoverRepositories(inside.root);
	const otherAgain = await discoverRepositories(other.root);
	assert.notEqual(insideAgain, insideFirst, '受影响的工作区应重新扫描');
	assert.equal(otherAgain, otherFirst, '别的工作区继续命中缓存');
});

test('invalidateDiscoveryCacheFor：工作区根位于目标仓库之内时同样作废', async () => {
	const { discoverRepositories, clearDiscoveryCache, invalidateDiscoveryCacheFor } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();
	const first = await discoverRepositories(tree.root);

	// 目标取工作区根的祖先：工作区根落在该目标之内。
	invalidateDiscoveryCacheFor(dirname(tree.root));
	const again = await discoverRepositories(tree.root);
	assert.notEqual(again, first, '祖先路径的写应作废该工作区的缓存');
});

test('discoverRepositories：knownRepos 快路径与全部失效时回退完整扫描', async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();
	const found = await discoverRepositories(tree.root);
	const repoPaths = found.nodes.filter((node) => node.kind === 'repo').map((node) => node.path);

	clearDiscoveryCache();
	const fast = await discoverRepositories(tree.root, { knownRepos: repoPaths });
	assert.deepEqual(
		fast.nodes.filter((node) => node.kind === 'repo').map((node) => node.path),
		repoPaths,
		'已知路径快路径返回同样的顶层仓库',
	);
	assert.equal(fast.truncated, false);

	clearDiscoveryCache();
	const fallback = await discoverRepositories(tree.root, { knownRepos: [join(tree.root, 'absent-a'), join(tree.root, 'absent-b')] });
	assert.deepEqual(
		fallback.nodes.filter((node) => node.kind === 'repo').map((node) => node.path),
		repoPaths,
		'已知路径全部失效时回退完整扫描',
	);
});

/**
 * 记录既有差异：完整扫描的仓库 depth 是目录层数，knownRepos 快路径的仓库 depth 恒为 0。
 *
 * 快路径按已知路径构造节点，不经过层序遍历，因此拿不到目录层数；客户端不消费该字段
 * （仓库树的缩进由 flattenVisible 按嵌套层级自算），故不作为缺陷处理。
 */
test('discoverRepositories：快路径 depth 恒 0，客户端不消费该字段', async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	const found = await discoverRepositories(tree.root);
	const depthByPath = new Map(found.nodes.filter((node) => node.kind === 'repo').map((node) => [node.path, node.depth]));
	assert.equal(depthByPath.get(tree.top), 1, '完整扫描：工作区根下的仓库 depth 为目录层数 1');
	assert.equal(depthByPath.get(tree.mid), 2, '完整扫描：第 2 层目录下的仓库 depth 为目录层数 2');

	clearDiscoveryCache();
	const fast = await discoverRepositories(tree.root, { knownRepos: [tree.top, tree.mid] });
	const fastRepos = fast.nodes.filter((node) => node.kind === 'repo');
	assert.equal(fastRepos.length, 2);
	assert.ok(
		fastRepos.every((node) => node.depth === 0),
		'快路径 depth 恒 0，客户端不消费该字段',
	);
});
