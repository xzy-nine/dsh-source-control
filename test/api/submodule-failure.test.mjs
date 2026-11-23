/**
 * 损坏的子模块登记：模块目录缺失时 git 会把整条 status / diff 判成失败，仓库本身却仍可用。
 *
 * 判据与降级参数都是纯函数，因此先直接测它们；再用真实 git 与真实路由验证取数确实恢复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 本文件的用例串行执行：每个用例起真实 git 子进程与临时仓库。 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');

const { isBrokenSubmoduleFailure, withIgnoredSubmoduleDirt, hasIgnoreSubmodulesFlag } =
	await import('../../src/source-control/submodule-failure.ts');

/** 临时仓库登记表。 */
const temps = [];

test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** 在目录里跑 git，返回标准输出。 */
function git(repo, ...args) {
	return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/**
 * 损坏子模块时 git 的诊断文案，Windows 与 Linux 不同。
 *
 * Windows 报 `not a git repository: <gitdir>`，Linux 报 `gitfile does not point to a
 * valid repository: <子模块>/.git`。夹具的前置断言按平台接受对应形态。
 */
const BROKEN_MODULE_ERROR = /not a git repository|gitfile does not point to a valid repository/;

/**
 * 建一个带子模块的父仓库，并把子模块的模块目录改成损坏状态。
 *
 * 损坏形态取自实测：模块目录里只剩 config 与 objects，HEAD、refs 与 index 都不在，
 * 子模块工作树里也只剩一个指向它的 .git 指针文件。此时 git 报
 * `fatal: not a git repository: <路径>/.git/modules/<名>`。
 *
 * 给出 `withMovedGitlink` 时另加一个**正常**子模块，并把它检出到更早的提交：索引里记的
 * gitlink 因此与工作区实际检出的提交不同，而这一条改动必须在降级之后仍然读出。
 *
 * @param prefix - 临时目录前缀。
 * @param options - `withMovedGitlink` 为真时追加正常子模块并移动它的 gitlink。
 * @returns 父仓库路径。
 */
function makeBrokenSubmoduleRepo(prefix, options = {}) {
	const base = mkdtempSync(join(tmpdir(), prefix));
	temps.push(base);
	const child = join(base, 'child');
	git(base, 'init', '-q', '-b', 'main', child);
	git(child, 'config', 'user.email', 'a@b.c');
	git(child, 'config', 'user.name', 'A');
	writeFileSync(join(child, 'a.txt'), 'one\n');
	git(child, 'add', '-A');
	git(child, 'commit', '-qm', 'c1');

	const parent = join(base, 'parent');
	git(base, 'init', '-q', '-b', 'main', parent);
	git(parent, 'config', 'user.email', 'a@b.c');
	git(parent, 'config', 'user.name', 'A');
	// 本地 pathspec 克隆需要显式放行。
	git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'googletest');
	/*
	 * 第二个子模块保持完好：它检出到更早的提交后，索引里的 gitlink 与工作区实际检出的
	 * 提交不同，git 把它报成一条普通的子模块改动（` M <名>`）。
	 */
	if (options.withMovedGitlink === true) {
		// 第二个提交让子模块有可回退的父提交：检出到它即产生一次真实的 gitlink 移动。
		writeFileSync(join(child, 'a.txt'), 'two\n');
		git(child, 'add', '-A');
		git(child, 'commit', '-qm', 'c2');
		git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'goodlib');
	}
	git(parent, 'commit', '-qm', 'addsub');
	if (options.withMovedGitlink === true) {
		git(join(parent, 'goodlib'), 'checkout', '-q', 'HEAD~1');
	}

	// 一条本仓库自己的改动，用来验证降级之后它仍在。先提交一次再改，改动才落在工作区列。
	writeFileSync(join(parent, 'own.txt'), 'first\n');
	git(parent, 'add', 'own.txt');
	git(parent, 'commit', '-qm', 'own');
	writeFileSync(join(parent, 'own.txt'), 'changed\n');

	// 弄坏模块目录：只留 config 与 objects。此后的 git 写命令同样会失败，因此放在最后。
	const moduleDir = join(parent, '.git', 'modules', 'googletest');
	for (const name of ['HEAD', 'index', 'refs']) {
		const target = join(moduleDir, name);
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	}
	return parent;
}

/**
 * 经真实路由发一条命令。
 *
 * @param repo - 仓库路径。
 * @returns 调用函数。
 */
async function makeCaller(repo) {
	const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
	const routes = new Map();
	registerGgRoutes({ register(spec) { routes.set(spec.path, spec.handler); return () => {}; } });
	const handler = routes.get('/dsh-source-control/gg/api');
	return (message) => new Promise((resolve, reject) => {
		const body = JSON.stringify({ repo, ...message });
		const req = {
			method: 'POST',
			on(event, callback) { if (event === 'data') callback(Buffer.from(body, 'utf8')); if (event === 'end') callback(); return req; },
		};
		const res = { writeHead() {}, end(text) { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } } };
		Promise.resolve(handler(req, res)).catch(reject);
	});
}

test('识别 git 的损坏子模块失败文本', () => {
	assert.equal(isBrokenSubmoduleFailure('fatal: not a git repository: lib/googletest/../../.git/modules/lib/googletest'), true);
	assert.equal(isBrokenSubmoduleFailure('fatal: not a git repository: ../.git/modules/sub'), true);
	assert.equal(isBrokenSubmoduleFailure('fatal: not a git repository (or any of the parent directories): .git'), false);
	assert.equal(isBrokenSubmoduleFailure('fatal: not a git repository: /somewhere/else'), false);
	assert.equal(isBrokenSubmoduleFailure('fatal: gitfile does not point to a valid repository: googletest/.git'), true);
	assert.equal(isBrokenSubmoduleFailure('fatal: gitfile does not point to a valid repository: lib/sub/.git'), true);
	assert.equal(isBrokenSubmoduleFailure('fatal: unable to access remote'), false);
	assert.equal(isBrokenSubmoduleFailure(''), false);
});

test('降级参数落在 -- 之前，已有口径时不重复追加', () => {
	assert.deepEqual(withIgnoredSubmoduleDirt(['status', '--porcelain']), ['status', '--porcelain', '--ignore-submodules=dirty']);
	assert.deepEqual(
		withIgnoredSubmoduleDirt(['diff', '--', 'a.txt']),
		['diff', '--ignore-submodules=dirty', '--', 'a.txt'],
		'选项不能插到 -- 之后，那里一律按路径解释',
	);
	assert.deepEqual(
		withIgnoredSubmoduleDirt(['status', '--ignore-submodules=all', '--porcelain']),
		['status', '--ignore-submodules=all', '--porcelain'],
		'已有口径时原样保留',
	);
	assert.equal(hasIgnoreSubmodulesFlag(['status', '--ignore-submodules', 'dirty']), true);
	assert.equal(hasIgnoreSubmodulesFlag(['status']), false);
});

test('损坏的子模块下工作区快照仍能读出本仓库的改动', async () => {
	const repo = makeBrokenSubmoduleRepo('gg-submodule-broken-');
	// 先确认这个仓库确实处于损坏状态：不加任何口径时 git 直接失败。
	assert.throws(() => git(repo, 'status', '--porcelain'), BROKEN_MODULE_ERROR);
	const call = await makeCaller(repo);
	const result = await call({ command: 'loadWorkingTreeSnapshot', noCache: true });
	assert.equal(result.error ?? null, null, '降级之后不应再报错');
	assert.ok(Array.isArray(result.entries), '应给出条目列表');
	const paths = result.entries.map((entry) => entry.path);
	assert.ok(paths.includes('own.txt'), '本仓库自己的改动要读出来，实际：' + JSON.stringify(paths));
	assert.equal(typeof result.head, 'string', 'HEAD 仍要读到');
});

test('降级不会把子模块内部已提交的 gitlink 移动吞掉', async () => {
	const repo = makeBrokenSubmoduleRepo('gg-submodule-broken-move-', { withMovedGitlink: true });
	// 先确认前提：那里确实有一条正常的子模块改动，而普通 status 因另一个子模块损坏整体失败。
	const degradedStatus = git(repo, 'status', '--porcelain', '--ignore-submodules=dirty');
	assert.ok(degradedStatus.split('\n').includes(' M goodlib'), '降级口径下应报出子模块改动，实际：' + JSON.stringify(degradedStatus));
	assert.throws(() => git(repo, 'status', '--porcelain'), BROKEN_MODULE_ERROR);
	const call = await makeCaller(repo);
	const before = await call({ command: 'loadWorkingTreeSnapshot', noCache: true });
	assert.equal(before.error ?? null, null);
	const paths = before.entries.map((entry) => entry.path);
	// 本仓库自己的改动必须出现在条目里：这是降级之后仍要保证的那部分事实。
	assert.ok(paths.includes('own.txt'), '本仓库改动要读出来，实际：' + JSON.stringify(paths));
	/*
	 * 正常子模块的 gitlink 移动同样必须在：降级只放宽子模块的脏判定（`dirty`），
	 * 已提交的 gitlink 变化不属于脏内容，因此仍要列出。放宽成 `all` 会把它一并吞掉。
	 */
	assert.ok(paths.includes('goodlib'), '正常子模块的 gitlink 移动要读出来，实际：' + JSON.stringify(paths));
});