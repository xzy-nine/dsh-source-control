/**
 * 仓库发现契约回归（子模块边界）：越界路径拒绝与路径边界判定。
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempPath } from '../harness.mjs';
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

test('子模块声明的越界路径被拒绝，仓库内的声明照常列出', async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const rootDir = makeTemp('gg-disc-escape-');
	const repo = makeRepoAt(rootDir, 'repo');
	const outside = makeRepoAt(rootDir, 'outside');

	// `.gitmodules` 是仓库内可改写的普通文件，其中的路径不保证相对仓库根。
	writeFileSync(join(repo, '.gitmodules'), [
		'[submodule "evil"]',
		'\tpath = ../outside',
		'\turl = https://example.com/evil.git',
		'[submodule "deep"]',
		'\tpath = a/../../escape',
		'\turl = https://example.com/deep.git',
		'[submodule "abs"]',
		'\tpath = /etc/passwd',
		'\turl = https://example.com/abs.git',
		'[submodule "ok"]',
		'\tpath = libs/dep',
		'\turl = https://example.com/ok.git',
	].join('\n'));
	mkdirSync(join(repo, 'libs', 'dep'), { recursive: true });
	gitIn(repo, 'add', '-A');
	gitIn(repo, 'commit', '-q', '-m', 'add gitmodules');

	const result = await discoverRepositories(repo, { maxDepth: 1 });
	const repoNode = result.nodes.find((node) => node.kind === 'repo');
	assert.ok(repoNode !== undefined, '仓库节点存在');
	const subs = submodulesOf(repoNode);
	assert.deepEqual(
		subs.map((node) => resolve(node.path)),
		[resolve(join(repo, 'libs', 'dep'))],
		'只列出仓库内的声明，越界的声明被拒绝',
	);
	assert.ok(
		!subs.some((node) => resolve(node.path) === resolve(outside)),
		'仓库外的路径不得成为节点',
	);
});

test('子模块路径的边界判定：相对路径按仓库根核对，绝对路径一律拒绝', async () => {
	const { isSubmodulePathWithin, submodulePathsWithin } = await import(
		pathToFileURL(join(root, 'lib', 'src', 'source-control', 'submodule-parse.js')).href
	);
	const boundRoot = tempPath('gg-disc-bound-repo-');
	temps.push(boundRoot);
	const repoRoot = resolve(boundRoot);
	for (const [path, within] of [
		['libs/dep', true],
		['a/b/c', true],
		['dep', true],
		['../outside', false],
		['a/../../escape', false],
		['../../etc/passwd', false],
		['/etc/passwd', false],
		['C:/Windows/System32', false],
		['..', false],
		['.', false],
		['', false],
	]) {
		assert.equal(
			isSubmodulePathWithin(repoRoot, path),
			within,
			`${JSON.stringify(path)} 的边界判定`,
		);
	}
	assert.deepEqual(
		submodulePathsWithin(repoRoot, ['libs/dep', '../outside', 'a/../../escape', 'other']),
		['libs/dep', 'other'],
		'过滤后只留仓库内的路径，保持入参顺序',
	);
	assert.deepEqual(
		submodulePathsWithin(repoRoot, ['libs/dep', 'libs/dep', 'other', 'libs/dep']),
		['libs/dep', 'other'],
		'同一路径的多次声明只留首次出现',
	);
});
