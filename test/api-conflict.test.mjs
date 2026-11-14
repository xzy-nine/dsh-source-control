/**
 * 冲突取数与解决的实机契约：真实路由、真实仓库。
 *
 * 冲突条目没有 stage 0，取内容要指到具体阶段、解决动作也要按种类落到不同命令，
 * 因此这里对每种冲突构造真实历史，断言经过路由后的实际结局。
 *
 * 被测模块有内部 `.js` 相对导入，因此从 `lib/` 产物导入；`pretest` 会先重建产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与临时仓库 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');

/**
 * 建一个临时仓库。
 *
 * @returns 仓库路径与 git 辅助函数。
 */
function makeRepo(prefix) {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const write = (name, content) => writeFileSync(join(repo, name), content);
	const read = (name) => readFileSync(join(repo, name), 'utf8');
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'conflict@example.com');
	git('config', 'user.name', 'Conflict');
	return { repo, git, write, read };
}

/**
 * 经真实路由发一条命令。
 *
 * @param repo - 仓库路径。
 * @returns 发送命令并解析响应的函数。
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

/**
 * 造一个双方修改（UU）的冲突。
 *
 * @returns 仓库与 git 辅助函数。
 */
function bothModifiedRepo() {
	const { repo, git, write, read } = makeRepo('gg-conflict-uu-');
	write('a.txt', 'base\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
	git('checkout', '-q', '-b', 'side');
	write('a.txt', 'theirs\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'theirs');
	git('checkout', '-q', 'main');
	write('a.txt', 'ours\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'ours');
	try { git('merge', 'side'); } catch { /* 冲突是预期结果 */ }
	return { repo, git, write, read };
}

test('双方修改：差异给 hunk 与冲突种类，正文含标记', async () => {
	const { repo } = bothModifiedRepo();
	try {
		const call = await makeCaller(repo);
		const result = await call({ command: 'fileDiffContent', commitHash: '*', filePath: 'a.txt', staged: false, baseHash: '' });
		assert.equal(result.error ?? null, null);
		assert.equal(result.conflict, true);
		assert.equal(result.conflictKind, 'both-modified');
		assert.deepEqual(result.conflictStages, { base: true, ours: true, theirs: true });
		assert.ok(result.hunks.length > 0, '冲突差异也要给出 hunk');
		assert.match(result.newText, /<<<<<<< /, '新侧取工作区文件，带冲突标记');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('冲突未解决时 git restore 与 show :path 都会失败，因此解决动作不能复用丢弃', async () => {
	const { repo, git } = bothModifiedRepo();
	try {
		assert.throws(() => git('restore', '--', 'a.txt'), /unmerged/, '丢弃对未合并路径不成立');
		assert.throws(() => git('show', ':a.txt'), /not at stage 0/, '未合并路径没有 stage 0，取内容必须指到阶段');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('冲突阶段查询：只回未合并条目', async () => {
	const { repo, write, git } = bothModifiedRepo();
	try {
		write('plain.txt', 'x');
		git('add', 'plain.txt');
		const call = await makeCaller(repo);
		const result = await call({ command: 'conflictStages', paths: ['a.txt', 'plain.txt', 'missing.txt'] });
		assert.equal(result.error ?? null, null);
		assert.deepEqual(result.stages.map((item) => item.path), ['a.txt'], '只有未合并条目有阶段');
		assert.deepEqual(
			{ base: result.stages[0].base, ours: result.stages[0].ours, theirs: result.stages[0].theirs },
			{ base: true, ours: true, theirs: true },
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('采用我方：写回我方内容并解除未合并', async () => {
	const { repo, git, read } = bothModifiedRepo();
	try {
		const call = await makeCaller(repo);
		const result = await call({ command: 'resolveConflict', paths: ['a.txt'], action: 'ours' });
		assert.deepEqual(result.errors, []);
		assert.deepEqual(result.resolved, ['a.txt']);
		assert.equal(read('a.txt').replace(/\r\n/g, '\n'), 'ours\n');
		// 我方内容就是 HEAD 的内容，因此解决后索引与 HEAD 一致、工作区干净。
		assert.equal(git('status', '--porcelain').trim(), '', '采用我方后条目消失');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('采用对方：写回对方内容', async () => {
	const { repo, read } = bothModifiedRepo();
	try {
		const call = await makeCaller(repo);
		const result = await call({ command: 'resolveConflict', paths: ['a.txt'], action: 'theirs' });
		assert.deepEqual(result.errors, []);
		assert.equal(text(repo, 'a.txt'), 'theirs\n');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('我方删除（DU）：采用对方写回对方内容，删除则移除文件', async () => {
	const { repo, git, write } = makeRepo('gg-conflict-du-');
	try {
		write('d.txt', 'base\n');
		write('e.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('checkout', '-q', '-b', 'side');
		write('d.txt', 'theirs\n');
		write('e.txt', 'theirs\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'theirs');
		git('checkout', '-q', 'main');
		git('rm', '-q', 'd.txt', 'e.txt');
		git('commit', '-q', '-m', 'ours delete');
		try { git('merge', 'side'); } catch { /* 冲突是预期结果 */ }

		const call = await makeCaller(repo);
		const kinds = await call({ command: 'fileDiffContent', commitHash: '*', filePath: 'd.txt', staged: false, baseHash: '' });
		assert.equal(kinds.conflictKind, 'deleted-by-us', '我方删除的类型');
		assert.deepEqual(kinds.conflictStages, { base: true, ours: false, theirs: true });

		const taken = await call({ command: 'resolveConflict', paths: ['d.txt'], action: 'theirs' });
		assert.deepEqual(taken.errors, []);
		assert.equal(text(repo, 'd.txt'), 'theirs\n', '采用对方后工作区是对方内容');

		const removed = await call({ command: 'resolveConflict', paths: ['e.txt'], action: 'delete' });
		assert.deepEqual(removed.errors, []);
		assert.equal(git('ls-files', '--', 'e.txt').trim(), '', '删除后索引里不再有该条目');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('对方删除（UD）：采用我方保留我方内容', async () => {
	const { repo, git, write } = makeRepo('gg-conflict-ud-');
	try {
		write('u.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('checkout', '-q', '-b', 'side');
		git('rm', '-q', 'u.txt');
		git('commit', '-q', '-m', 'theirs delete');
		git('checkout', '-q', 'main');
		write('u.txt', 'ours\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'ours modify');
		try { git('merge', 'side'); } catch { /* 冲突是预期结果 */ }

		const call = await makeCaller(repo);
		const kinds = await call({ command: 'fileDiffContent', commitHash: '*', filePath: 'u.txt', staged: false, baseHash: '' });
		assert.equal(kinds.conflictKind, 'deleted-by-them');

		const result = await call({ command: 'resolveConflict', paths: ['u.txt'], action: 'ours' });
		assert.deepEqual(result.errors, []);
		assert.equal(text(repo, 'u.txt'), 'ours\n');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('双方新增（AA）：没有基线阶段，仍给出差异与采用动作', async () => {
	const { repo, git, write } = makeRepo('gg-conflict-aa-');
	try {
		write('seed.txt', 'x\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('checkout', '-q', '-b', 'side');
		write('n.txt', 'theirs\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'theirs add');
		git('checkout', '-q', 'main');
		write('n.txt', 'ours\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'ours add');
		try { git('merge', 'side'); } catch { /* 冲突是预期结果 */ }

		const call = await makeCaller(repo);
		const kinds = await call({ command: 'fileDiffContent', commitHash: '*', filePath: 'n.txt', staged: false, baseHash: '' });
		assert.equal(kinds.conflictKind, 'both-added');
		assert.deepEqual(kinds.conflictStages, { base: false, ours: true, theirs: true }, '双方新增没有基线');
		assert.ok(kinds.hunks.length > 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('已解决的路径再解决时报错而不是静默成功', async () => {
	const { repo } = bothModifiedRepo();
	try {
		const call = await makeCaller(repo);
		await call({ command: 'resolveConflict', paths: ['a.txt'], action: 'ours' });
		const again = await call({ command: 'resolveConflict', paths: ['a.txt'], action: 'ours' });
		assert.deepEqual(again.resolved, []);
		assert.equal(again.errors.length, 1);
		assert.match(again.errors[0], /未找到未合并条目/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('单条失败不影响同批其它路径', async () => {
	const { repo } = bothModifiedRepo();
	try {
		const call = await makeCaller(repo);
		const result = await call({ command: 'resolveConflict', paths: ['a.txt', 'nope.txt'], action: 'ours' });
		assert.deepEqual(result.resolved, ['a.txt']);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0], /nope\.txt/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('未知解决方式与空路径被拒绝', async () => {
	const { repo } = bothModifiedRepo();
	try {
		const call = await makeCaller(repo);
		const bad = await call({ command: 'resolveConflict', paths: ['a.txt'], action: 'nonsense' });
		assert.match(String(bad.error), /未知的冲突解决方式/);
		const empty = await call({ command: 'resolveConflict', paths: [], action: 'ours' });
		assert.match(String(empty.error), /缺少 paths/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

/**
 * 读一个工作区文件内容，并把换行归一成 LF。
 *
 * Windows 上 `core.autocrlf` 会让落盘的行尾是 CRLF，内容判据与行尾无关。
 *
 * @param repo - 仓库路径。
 * @param name - 文件名。
 * @returns 归一换行后的内容。
 */
function text(repo, name) {
	return readFileSync(join(repo, name), 'utf8').replace(/\r\n/g, '\n');
}
