/**
 * 提交差异取旧侧的契约：根提交与「父提交里没有该路径」都不产生注定失败的子进程。
 *
 * 判据取自日志：对根提交取 `show <hash>~1:<path>` 必然以退出码 128 失败一次，并把这行
 * `fatal:` 写进日志。这里用真实路由与真实仓库验证旧侧为空、差异仍给出 hunk。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与临时仓库 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');

/** 临时仓库登记表。 */
const temps = [];

/** 记录被启动的 git 参数数组。 */
const spawned = [];
const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
	spawned.push([command, ...(Array.isArray(args) ? args : [])].map(String));
	return originalSpawn(command, args, options);
};
syncBuiltinESMExports();

test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	cp.spawn = originalSpawn;
	syncBuiltinESMExports();
});

/** 建一个临时仓库。 */
function makeRepo(prefix) {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	temps.push(repo);
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'diff@example.com');
	git('config', 'user.name', 'Diff');
	return { repo, git };
}

/** 经真实路由发一条命令。 */
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

test('根提交的差异：旧侧为空，且仍给出逐块内容', async () => {
	const { repo, git } = makeRepo('gg-diff-root-');
	writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'root');
	const head = git('rev-parse', 'HEAD').trim();
	const call = await makeCaller(repo);

	spawned.length = 0;
	const result = await call({ command: 'fileDiffContent', commitHash: head, filePath: 'a.txt', staged: false, baseHash: '' });
	assert.equal(result.error ?? null, null, '根提交不应产生失败');
	assert.deepEqual(
		spawned.filter(([command, ...args]) => command === 'git' && args.includes('rev-parse')).map(([, ...args]) => args.at(-1)),
		[`${head}^`],
		'先问父提交是否存在，替代一条注定失败的 show',
	);
	assert.equal(result.oldText, null, '没有父提交时旧侧为空');
	assert.equal(result.newText, 'one\ntwo\n', '新侧为该提交的内容');
	assert.equal(result.binary, false);
});

test('父提交里没有该路径时旧侧为空，不产生失败', async () => {
	const { repo, git } = makeRepo('gg-diff-added-');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
	writeFileSync(join(repo, 'b.txt'), 'brand new\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'add b');
	const head = git('rev-parse', 'HEAD').trim();
	const call = await makeCaller(repo);

	spawned.length = 0;
	const result = await call({ command: 'fileDiffContent', commitHash: head, filePath: 'b.txt', staged: false, baseHash: '' });
	assert.equal(result.error ?? null, null, '新增文件不应让整个取数失败');
	assert.equal(result.oldText, null, '父提交里没有该路径，旧侧为空');
	assert.equal(result.newText, 'brand new\n');
	assert.ok(result.hunks.length > 0, '仍是新增差异，应给出 hunk');
});

	test('两提交对比不受父提交判定影响', async () => {
		const { repo, git } = makeRepo('gg-diff-compare-');
		writeFileSync(join(repo, 'a.txt'), 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		const base = git('rev-parse', 'HEAD').trim();
		writeFileSync(join(repo, 'a.txt'), 'two\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'next');
		const head = git('rev-parse', 'HEAD').trim();
		const call = await makeCaller(repo);
		const result = await call({ command: 'fileDiffContent', commitHash: head, filePath: 'a.txt', staged: false, baseHash: base });
		assert.equal(result.error ?? null, null);
		assert.equal(result.oldText, 'one\n', '旧侧取 baseHash');
		assert.equal(result.newText, 'two\n', '新侧取 commitHash');
	});
