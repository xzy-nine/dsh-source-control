/**
 * 分段处理与分段暂存的实机契约：真实路由、真实仓库。
 *
 * 冲突按段取一侧、改动按块进索引，两者都是「只动命中的区间」，因此这里用两处相隔
 * 较远的改动来证明另一处不受影响。
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
 * @param prefix - 临时目录前缀。
 * @returns 仓库路径与辅助函数。
 */
function makeRepo(prefix) {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const write = (name, content) => writeFileSync(join(repo, name), content);
	const read = (name) => readFileSync(join(repo, name), 'utf8');
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'section@example.com');
	git('config', 'user.name', 'Section');
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
 * 造一个两处冲突的文件。
 *
 * @param sections - 冲突的处数。
 * @returns 仓库与辅助函数。
 */
function conflictRepo(sections) {
	const { repo, git, write, read } = makeRepo('gg-section-');
	const total = 12;
	const base = Array.from({ length: total }, (_, index) => `line${String(index + 1)}`).join('\n') + '\n';
	write('f.txt', base);
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
	git('checkout', '-q', '-b', 'side');
	const theirs = base.split('\n').slice();
	theirs[1] = 'line2-THEIRS';
	if (sections > 1) theirs[9] = 'line10-THEIRS';
	write('f.txt', theirs.join('\n'));
	git('add', '-A');
	git('commit', '-q', '-m', 'theirs');
	git('checkout', '-q', 'main');
	const ours = base.split('\n').slice();
	ours[1] = 'line2-OURS';
	if (sections > 1) ours[9] = 'line10-OURS';
	write('f.txt', ours.join('\n'));
	git('add', '-A');
	git('commit', '-q', '-m', 'ours');
	try { git('merge', 'side'); } catch { /* 冲突是预期结果 */ }
	return { repo, git, write, read };
}

test('两处冲突：只解决第一处，第二处原样保留', async () => {
	const { repo, read } = conflictRepo(2);
	try {
		const call = await makeCaller(repo);
		const first = await call({ command: 'resolveConflictSection', filePath: 'f.txt', index: 0, side: 'theirs' });
		assert.equal(first.error ?? null, null);
		assert.equal(first.hasMarkers, true, '还有第二处冲突');
		const text = read('f.txt');
		assert.ok(text.includes('line2-THEIRS'), '第一处取到对方内容');
		assert.ok(!text.includes('line2-OURS'), '第一处我方内容已被替换');
		assert.ok(text.includes('line10-OURS') && text.includes('line10-THEIRS'), '第二处的标记与两侧都还在');

		// 剩下的第一处（下标从 0 重新计数）取我方。
		const second = await call({ command: 'resolveConflictSection', filePath: 'f.txt', index: 0, side: 'ours' });
		assert.equal(second.hasMarkers, false, '两处都处理完');
		const done = read('f.txt');
		assert.ok(done.includes('line2-THEIRS'), '第一处保持对方内容');
		assert.ok(done.includes('line10-OURS'), '第二处取到我方');
		assert.ok(!/^<<<<<<</m.test(done), '不再有冲突标记');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('两边都保留与都不要', async () => {
	const { repo, read } = conflictRepo(2);
	try {
		const call = await makeCaller(repo);
		await call({ command: 'resolveConflictSection', filePath: 'f.txt', index: 0, side: 'both' });
		const text = read('f.txt');
		assert.ok(text.includes('line2-OURS') && text.includes('line2-THEIRS'), '两行都在');

		await call({ command: 'resolveConflictSection', filePath: 'f.txt', index: 0, side: 'none' });
		const pruned = read('f.txt');
		assert.ok(!pruned.includes('line10-OURS') && !pruned.includes('line10-THEIRS'), '第二处两侧都被删掉');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('整文件按同一侧解决全部冲突', async () => {
	const { repo, read } = conflictRepo(2);
	try {
		const call = await makeCaller(repo);
		const result = await call({ command: 'resolveAllConflictSections', filePath: 'f.txt', side: 'theirs' });
		assert.equal(result.error ?? null, null);
		assert.equal(result.hasMarkers, false);
		const text = read('f.txt');
		assert.ok(text.includes('line2-THEIRS') && text.includes('line10-THEIRS'));
		assert.ok(!text.includes('line2-OURS') && !text.includes('line10-OURS'));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('分段解决越界与未知侧被拒绝', async () => {
	const { repo } = conflictRepo(2);
	try {
		const call = await makeCaller(repo);
		const beyond = await call({ command: 'resolveConflictSection', filePath: 'f.txt', index: 9, side: 'ours' });
		assert.match(String(beyond.error), /没有第 10 处冲突/);
		const badSide = await call({ command: 'resolveConflictSection', filePath: 'f.txt', index: 0, side: 'nonsense' });
		assert.match(String(badSide.error), /未知的分段解决方式/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('分段暂存：只把选中的块写进索引，另一块留在工作区', async () => {
	const { repo, git, write } = makeRepo('gg-hunk-');
	try {
		const base = Array.from({ length: 20 }, (_, index) => `line${String(index + 1)}`).join('\n') + '\n';
		write('f.txt', base);
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		write('f.txt', base.replace('line2\n', 'line2-X\n').replace('line18\n', 'line18-Y\n'));

		const call = await makeCaller(repo);
		const listed = await call({ command: 'fileHunks', filePath: 'f.txt', staged: false });
		assert.equal(listed.hunks.length, 2, '两处相隔较远的改动各成一块');

		const staged = await call({ command: 'applyHunk', filePath: 'f.txt', indexes: [0], direction: 'stage' });
		assert.equal(staged.error ?? null, null);
		const cached = git('diff', '--cached');
		assert.ok(cached.includes('line2-X'), '选中的块进了索引');
		assert.ok(!cached.includes('line18-Y'), '未选中的块不在索引里');
		assert.ok(git('diff').includes('line18-Y'), '未选中的块仍在工作区');

		const unstaged = await call({ command: 'applyHunk', filePath: 'f.txt', indexes: [0], direction: 'unstage' });
		assert.equal(unstaged.error ?? null, null);
		assert.equal(git('diff', '--cached').trim(), '', '取消暂存后索引里没有这一块');
		assert.ok(git('diff').includes('line2-X'), '内容回到工作区');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('分段暂存：空下标表示全部块', async () => {
	const { repo, git, write } = makeRepo('gg-hunkall-');
	try {
		const base = Array.from({ length: 20 }, (_, index) => `line${String(index + 1)}`).join('\n') + '\n';
		write('f.txt', base);
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		write('f.txt', base.replace('line2\n', 'line2-X\n').replace('line18\n', 'line18-Y\n'));

		const call = await makeCaller(repo);
		const staged = await call({ command: 'applyHunk', filePath: 'f.txt', indexes: [], direction: 'stage' });
		assert.equal(staged.error ?? null, null);
		assert.equal(staged.hunks.length, 2, '两块都被处理');
		assert.equal(git('diff').trim(), '', '工作区已全部进索引');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
