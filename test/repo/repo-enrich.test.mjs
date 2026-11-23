/**
 * 仓库发现契约回归（批量同步）：按路径批量返回与补齐，含失败兜底与路由 handler。
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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
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

test('loadReposSync：大量仓库一次全部返回，顺序与入参一致', async () => {
	const { loadReposSync } = await import(pathToFileURL(discoveryPath).href);
	const rootDir = makeTemp('gg-sync-many-');
	const paths = [];
	for (let i = 0; i < 40; i++) paths.push(makeBareRepoAt(rootDir, `r${String(i).padStart(2, '0')}`));

	const results = await loadReposSync(paths);
	assert.equal(results.length, 40, '全部仓库一次返回');
	assert.deepEqual(results.map((entry) => entry.path), paths, '顺序与入参一致');
	assert.ok(results.every((entry) => entry.branch === 'main'));
});

test('enrichRepositories：大量仓库一次全部补齐，顺序与入参一致', async () => {
	const { enrichRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const rootDir = makeTemp('gg-enrich-many-');
	const paths = [];
	for (let i = 0; i < 40; i++) paths.push(makeBareRepoAt(rootDir, `r${String(i).padStart(2, '0')}`));

	const enriched = await enrichRepositories(paths);
	assert.equal(enriched.length, 40, '全部仓库一次补齐');
	assert.deepEqual(enriched.map((node) => node.path), paths, '顺序与入参一致');
	assert.ok(enriched.every((node) => node.children.length === 0), '无工作树与子模块时 children 为空');
});

test('loadReposSync：空数组返回空、path 原样回显、重复入参去重', async () => {
	const { loadReposSync, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	assert.deepEqual(await loadReposSync([]), []);

	const rootDir = makeTemp('gg-sync-');
	const repoA = makeBareRepoAt(rootDir, 'Alpha-Repo');
	const repoB = makeBareRepoAt(rootDir, 'beta');
	// 非规范写法：追加平台分隔符。该写法必须逐字回显，且仍能读到仓库。
	const spelled = repoA + sep;
	assert.notEqual(spelled, repoA, '入参多一个尾分隔符，验证逐字回显');

	const results = await loadReposSync([spelled, repoB, spelled]);
	assert.equal(results.length, 2, '重复入参去重');
	assert.deepEqual(results.map((entry) => entry.path), [spelled, repoB]);
	assert.equal(results[0].path, spelled, 'path 逐字回显（含尾分隔符）');
	assert.equal(results[0].branch, 'main');
	assert.equal(results[0].upstream, null);
	assert.equal(results[0].ahead, 0);
	assert.equal(results[0].behind, 0);

	// 大小写变体是另一个入参字符串，不得被去重或改写。
	const cased = spelled.toLowerCase() === spelled ? spelled.toUpperCase() : spelled.toLowerCase();
	const variants = await loadReposSync([spelled, cased]);
	assert.deepEqual(variants.map((entry) => entry.path), [spelled, cased], '大小写变体各自回显');
	assert.equal(variants[0].branch, 'main', '原样路径不受大小写影响');
	// 路径按字面读取：变体能否读到仓库取决于文件系统是否区分大小写，
	// 因此用同一路径实测可达性来定期望，而不是假定某一种平台行为。
	const reachable = existsSync(cased);
	assert.equal(variants[1].branch, reachable ? 'main' : null,
		reachable ? '变体在该文件系统上指向同一目录，应读到同一仓库' : '变体在该文件系统上不存在，应读不到仓库');
});

test('loadReposSync：单个仓库失败以空值兜底', async () => {
	const { loadReposSync } = await import(pathToFileURL(discoveryPath).href);
	const rootDir = makeTemp('gg-sync-miss-');
	const repo = makeBareRepoAt(rootDir, 'real');
	const absent = join(rootDir, 'no-such-repo');

	const results = await loadReposSync([repo, absent]);
	assert.equal(results.length, 2);
	assert.deepEqual(results.map((entry) => entry.path), [repo, absent]);
	assert.equal(results[0].branch, 'main');
	assert.deepEqual(
		{ branch: results[1].branch, upstream: results[1].upstream, ahead: results[1].ahead, behind: results[1].behind },
		{ branch: null, upstream: null, ahead: 0, behind: 0 },
	);
});

test('loadReposSync 命令：经真实路由 handler 的空列表与多仓库', async () => {
	const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
	const routes = new Map();
	registerGgRoutes({
		register(spec) {
			routes.set(spec.path, spec.handler);
			return () => {};
		},
	});
	const handler = routes.get('/dsh-source-control/gg/api');
	const call = (message) => new Promise((resolve, reject) => {
		const body = JSON.stringify(message);
		const req = {
			method: 'POST',
			on(event, callback) {
				if (event === 'data') callback(Buffer.from(body, 'utf8'));
				if (event === 'end') callback();
				return req;
			},
		};
		const res = {
			writeHead() {},
			end(text) {
				try { resolve(JSON.parse(text)); } catch { reject(new Error(`非 JSON 响应：${text}`)); }
			},
		};
		Promise.resolve(handler(req, res)).catch(reject);
	});

	const rootDir = makeTemp('gg-sync-cmd-');
	const repoA = makeBareRepoAt(rootDir, 'Alpha-Repo');
	const repoB = makeBareRepoAt(rootDir, 'beta');

	const empty = await call({ repo: rootDir, command: 'loadReposSync', repos: [] });
	assert.deepEqual(empty, { command: 'loadReposSync', repo: rootDir, results: [], error: null });

	const batch = await call({ repo: rootDir, command: 'loadReposSync', repos: [repoA, repoB] });
	assert.equal(batch.command, 'loadReposSync');
	assert.equal(batch.error, null);
	assert.equal(batch.results.length, 2);
	assert.deepEqual(batch.results.map((entry) => entry.path), [repoA, repoB], 'path 与入参逐字相同');
	for (const entry of batch.results) {
		assert.equal(entry.branch, 'main');
		assert.equal(entry.upstream, null);
		assert.equal(entry.ahead, 0);
		assert.equal(entry.behind, 0);
	}
});
