/**
 * 宿主命令集回归（子模块）：未检出子模块的初始化与丢弃条目。
 *
 * 被测模块有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入；
 * `pretest` 会先重建宿主与客户端产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempPath } from './harness.mjs';

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与临时仓库，串行便于定位失败 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');

/**
 * 写入一个可执行的 git 钩子文件。
 *
 * 钩子必须带执行位才会被 git 运行；umask 会影响创建时的权限，写入后再显式补一次。
 *
 * @param {string} directory - 钩子目录。
 * @param {string} name - 钩子文件名。
 * @param {string} content - 文件内容。
 */
function writeHook(directory, name, content) {
	const path = join(directory, name);
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
}

/** 建一个含分支、标签、贮藏、重命名与未跟踪文件的仓库，并返回其路径与 git 辅助函数。 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-api-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const write = (name, content) => writeFileSync(join(repo, name), content);

	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'api@example.com');
	git('config', 'user.name', 'Api');

	write('a.txt', 'one\ntwo\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'first commit');
	git('tag', '-a', 'v1', '-m', 'release one');
	git('tag', 'light');

	write('a.txt', 'one\ntwo\nthree\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'second commit\n\nbody text here');

	git('branch', 'feature');
	git('mv', 'a.txt', 'renamed.txt');
	git('commit', '-q', '-m', 'rename a to renamed');

	write('renamed.txt', 'one\ntwo\nthree\nfour\n');
	write('untracked.txt', 'new file');
	git('stash', 'push', '-u', '-m', 'work in progress');

	write('renamed.txt', 'one\ntwo\nthree\nfour\nfive\n');
	return { repo, git, write };
}

/**
 * 取一条经真实路由 handler 发请求的调用函数。
 *
 * @param repo - 仓库路径。
 * @returns 发送命令并解析响应的函数。
 */
async function makeCaller(repo) {
	const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
	const routes = new Map();
	registerGgRoutes({
		register(spec) {
			routes.set(spec.path, spec.handler);
			return () => {};
		},
	});
	const handler = routes.get('/dsh-source-control/gg/api');
	return (message) => new Promise((resolve, reject) => {
		const body = JSON.stringify({ repo, ...message });
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
}

test('初始化未检出的子模块：路径可给相对仓库根，也可给绝对路径', async () => {
	const parent = mkdtempSync(join(tmpdir(), 'gg-api-sub-'));
	const source = mkdtempSync(join(tmpdir(), 'gg-api-subsrc-'));
	const bare = mkdtempSync(join(tmpdir(), 'gg-api-subbare-'));
	const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	try {
		gitIn(source, 'init', '-q', '-b', 'main');
		gitIn(source, 'config', 'user.email', 'sub@example.com');
		gitIn(source, 'config', 'user.name', 'Sub');
		writeFileSync(join(source, 'dep.txt'), 'dep');
		gitIn(source, 'add', '-A');
		gitIn(source, 'commit', '-q', '-m', 'dep');
		gitIn(tmpdir(), 'clone', '-q', '--bare', source, bare);

		gitIn(parent, 'init', '-q', '-b', 'main');
		gitIn(parent, 'config', 'user.email', 'api@example.com');
		gitIn(parent, 'config', 'user.name', 'Api');
		writeFileSync(join(parent, 'a.txt'), 'a');
		gitIn(parent, 'add', '-A');
		gitIn(parent, 'commit', '-q', '-m', 'first');
		gitIn(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', bare, 'lib/dep');
		gitIn(parent, 'commit', '-q', '-m', 'add submodule');

		// 模拟未检出的子模块：删掉工作区目录，登记项仍在索引里。
		rmSync(join(parent, 'lib', 'dep'), { recursive: true, force: true });

		const call = await makeCaller(parent);
		assert.equal((await call({ command: 'initSubmodule', submodulePath: 'lib/dep' })).error, null);
		assert.ok(existsSync(join(parent, 'lib', 'dep', 'dep.txt')), '相对路径初始化出工作区');

		// 再删一次，按绝对路径初始化：宿主向上找到声明它的父仓库。
		rmSync(join(parent, 'lib', 'dep'), { recursive: true, force: true });
		const absolute = await makeCaller(join(parent, 'lib', 'dep'));
		assert.equal((await absolute({ command: 'initSubmodule', submodulePath: join(parent, 'lib', 'dep') })).error, null);
		assert.ok(existsSync(join(parent, 'lib', 'dep', 'dep.txt')), '绝对路径初始化出工作区');
	} finally {
		for (const dir of [parent, source, bare]) rmSync(dir, { recursive: true, force: true });
	}
});

test('丢弃子模块条目：只移动其指向的提交，不清理内部改动', async () => {
	const source = mkdtempSync(join(tmpdir(), 'gg-api-subdiscard-src-'));
	const parent = mkdtempSync(join(tmpdir(), 'gg-api-subdiscard-'));
	const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const read = (path) => readFileSync(path, 'utf8');
	try {
		gitIn(source, 'init', '-q', '-b', 'main');
		gitIn(source, 'config', 'user.email', 'sub@example.com');
		gitIn(source, 'config', 'user.name', 'Sub');
		writeFileSync(join(source, 'dep.txt'), 'one');
		writeFileSync(join(source, 'other.txt'), 'stable');
		gitIn(source, 'add', '-A');
		gitIn(source, 'commit', '-q', '-m', 'first');
		const older = gitIn(source, 'rev-parse', 'HEAD').trim();
		writeFileSync(join(source, 'dep.txt'), 'two');
		gitIn(source, 'add', '-A');
		gitIn(source, 'commit', '-q', '-m', 'second');
		const recorded = gitIn(source, 'rev-parse', 'HEAD').trim();

		gitIn(parent, 'init', '-q', '-b', 'main');
		gitIn(parent, 'config', 'user.email', 'api@example.com');
		gitIn(parent, 'config', 'user.name', 'Api');
		writeFileSync(join(parent, 'a.txt'), 'a');
		gitIn(parent, 'add', '-A');
		gitIn(parent, 'commit', '-q', '-m', 'first');
		gitIn(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'lib/dep');
		gitIn(parent, 'commit', '-q', '-m', 'add submodule');

		const sub = join(parent, 'lib', 'dep');
		const subHead = () => gitIn(sub, 'rev-parse', 'HEAD').trim();
		const call = await makeCaller(parent);
		const discard = (paths) => call({ command: 'discardPaths', paths, untracked: false });

		// 1. 子模块 HEAD 被移动到别的提交：丢弃后应回到索引记录的提交。
		gitIn(sub, 'checkout', '-q', older);
		assert.notEqual(subHead(), recorded, '前置条件：子模块 HEAD 已偏离');
		const moved = await discard(['lib/dep']);
		assert.equal(moved.error, null);
		assert.equal(subHead(), recorded, '子模块 HEAD 应回到索引记录的提交');
		assert.deepEqual(moved.discarded, ['lib/dep'], '该条目应随后消失');
		assert.equal(moved.submodules[0].status, 'moved');
		assert.equal(moved.submodules[0].dirty, false);
		assert.deepEqual((await call({ command: 'loadWorkingTree' })).entries, [], '工作区应干净');

		// 2. 只有内部未提交改动（HEAD 未动）：不清理，条目保留。
		writeFileSync(join(sub, 'other.txt'), 'local edit');
		const unchanged = await discard(['lib/dep']);
		assert.equal(read(join(sub, 'other.txt')), 'local edit', '子模块内部的改动不得被清理');
		assert.equal(unchanged.submodules[0].status, 'unchanged');
		assert.equal(unchanged.submodules[0].dirty, true);
		assert.deepEqual(unchanged.discarded, [], '条目应留在列表里');
		assert.equal((await call({ command: 'loadWorkingTree' })).entries.length, 1, '子模块条目仍在变更列表');

		// 3. HEAD 需要移动且内部改动不冲突：移动成功，改动保留。
		gitIn(sub, 'checkout', '-q', older);
		writeFileSync(join(sub, 'other.txt'), 'kept');
		const kept = await discard(['lib/dep']);
		assert.equal(subHead(), recorded, '不冲突时仍应移动 HEAD');
		assert.equal(read(join(sub, 'other.txt')), 'kept', '内部改动应原样保留');
		assert.equal(kept.submodules[0].status, 'moved');
		assert.equal(kept.submodules[0].dirty, true);
		assert.deepEqual(kept.discarded, [], '仍有内部改动时条目保留');

		// 4. 内部改动会被覆盖：git 拒绝移动，按 blocked 回报原文。
		writeFileSync(join(sub, 'dep.txt'), 'conflict');
		const blocked = await discard(['lib/dep']);
		assert.equal(subHead(), recorded, '前置条件：HEAD 已与索引一致');
		assert.equal(blocked.submodules[0].status, 'unchanged');
		assert.equal(blocked.submodules[0].dirty, true);
		// 先清掉本地改动再退到旧提交，随后在旧提交上制造会被覆盖的改动。
		gitIn(sub, 'checkout', '-q', '--', '.');
		gitIn(sub, 'checkout', '-q', older);
		writeFileSync(join(sub, 'dep.txt'), 'conflict');
		const conflict = await discard(['lib/dep']);
		assert.equal(subHead(), older, '被拒绝时 HEAD 不得移动');
		assert.equal(conflict.submodules[0].status, 'blocked');
		assert.match(conflict.submodules[0].reason, /would be overwritten|local changes/i, '应回报 git 原文');
		assert.deepEqual(conflict.discarded, []);

		// 5. 文件夹路径：同目录普通文件照常还原，子模块 HEAD 一并移动。
		gitIn(sub, 'checkout', '-q', '--', '.');
		gitIn(sub, 'checkout', '-q', older);
		writeFileSync(join(parent, 'a.txt'), 'changed');
		const folder = await discard(['a.txt', 'lib/dep']);
		assert.equal(read(join(parent, 'a.txt')), 'a', '普通文件应还原');
		assert.equal(subHead(), recorded, '文件夹丢弃同样移动子模块 HEAD');
		assert.deepEqual(folder.discarded.sort(), ['a.txt', 'lib/dep']);

		// 5b. 目录型 pathspec：命中的子模块同样处置，不留静默残留。
		gitIn(sub, 'checkout', '-q', older);
		const directory = await discard(['lib']);
		assert.equal(subHead(), recorded, '目录型 pathspec 命中的子模块也要移动 HEAD');
		assert.deepEqual(directory.discarded, ['lib/dep']);

		// 6. 未初始化（工作区目录不存在）：不动，也不隐式初始化。
		rmSync(sub, { recursive: true, force: true });
		const uninitialized = await discard(['lib/dep']);
		assert.equal(uninitialized.submodules[0].status, 'uninitialized');
		assert.equal(existsSync(sub), false, '未初始化的子模块不得被隐式检出');
		assert.deepEqual(uninitialized.discarded, []);

		// 7. 未跟踪的嵌套仓库：git clean 会跳过，回报为未删除。
		const nested = mkdtempSync(join(parent, 'nested-repo-'));
		gitIn(nested, 'init', '-q', '-b', 'main');
		writeFileSync(join(nested, 'inner.txt'), 'inner');
		const nestedName = nested.slice(parent.length + 1);
		const untracked = await call({ command: 'discardPaths', paths: [nestedName], untracked: true });
		assert.ok(untracked.skippedRepositories.includes(nestedName), '嵌套仓库应回报为未删除');
		assert.ok(existsSync(nested), '嵌套仓库不得被删除');
		assert.deepEqual(untracked.discarded, []);
	} finally {
		for (const dir of [parent, source]) rmSync(dir, { recursive: true, force: true });
	}
});
