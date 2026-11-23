/**
 * 分段暂存的粒度：块只含红绿本身，不含未改动的上下文行。
 *
 * 走真实路由与隔离仓库：`-U3` 会把上下文并进块里，相邻改动也容易被并成一块；这里锁住
 * 零上下文切块的两个可观察后果——块的范围等于改动范围，且单独重放一块只把那一处写进索引。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与隔离仓库，串行便于定位失败 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');

/** 建一个隔离仓库并给出 git 辅助函数。 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-hunk-apply-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'hunk@example.com');
	git('config', 'user.name', 'Hunk');
	return { repo, git };
}

/**
 * 造一个真实路由调用器。
 *
 * @param repo - 仓库路径。
 * @returns 发消息的函数。
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
				try { resolve(JSON.parse(text)); } catch { reject(new Error(`非 JSON 响应：${String(text).slice(0, 200)}`)); }
			},
		};
		Promise.resolve(handler(req, res)).catch(reject);
	});
}

/** 一份 20 行的文件，改第 3、4、15 行（三处改动、两段相隔较远）。 */
function baseLines() {
	return Array.from({ length: 20 }, (_, at) => `line ${String(at + 1)}`);
}

test('块的范围等于改动范围，不含未改动的上下文', async () => {
	const { repo, git } = makeRepo();
	try {
		const lines = baseLines();
		writeFileSync(join(repo, 'f.txt'), `${lines.join('\n')}\n`);
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		lines[2] = 'line 3 CHANGED';
		lines[3] = 'line 4 CHANGED';
		lines[14] = 'line 15 CHANGED';
		writeFileSync(join(repo, 'f.txt'), `${lines.join('\n')}\n`);

		const call = await makeCaller(repo);
		const payload = await call({ command: 'fileHunks', filePath: 'f.txt', staged: false });
		assert.equal(payload.error, null);
		const hunks = payload.hunks;
		assert.equal(hunks.length, 2, '相邻的两处算一块，远处的一处另算一块');
		// 零上下文：块的行数就是改动行数，前后各多出来的上下文行不允许存在。
		assert.equal(hunks[0].oldStart, 3, '首块从第一处改动的上一行号开始');
		assert.equal(hunks[0].oldLines, 2, '首块只含被改的两行');
		assert.equal(hunks[0].newLines, 2);
		assert.equal(hunks[1].oldStart, 15, '次块从第二处改动的行号开始');
		assert.equal(hunks[1].oldLines, 1, '次块只含被改的一行');
		// -U3 会让首块的行数变成 4（含上下各一行上下文），这里断言它没发生。
		assert.ok(hunks.every((hunk) => hunk.oldLines === hunk.newLines), '替换型改动两侧行数一致');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('单独暂存一块只把那一处写进索引', async () => {
	const { repo, git } = makeRepo();
	try {
		const lines = baseLines();
		writeFileSync(join(repo, 'f.txt'), `${lines.join('\n')}\n`);
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		lines[2] = 'line 3 CHANGED';
		lines[14] = 'line 15 CHANGED';
		writeFileSync(join(repo, 'f.txt'), `${lines.join('\n')}\n`);

		const call = await makeCaller(repo);
		const applied = await call({ command: 'applyHunk', filePath: 'f.txt', indexes: [0], direction: 'stage' });
		assert.equal(applied.error, null, `暂存应成功：${String(applied.error)}`);

		// 索引里只有第一处改动。
		const staged = git('diff', '--cached', '--no-color', '--', 'f.txt');
		assert.match(staged, /line 3 CHANGED/, '首块应进了索引');
		assert.doesNotMatch(staged, /line 15 CHANGED/, '次块不应进索引');
		// 工作区仍保留两处改动。
		const worktree = git('diff', '--no-color', '--', 'f.txt');
		assert.match(worktree, /line 15 CHANGED/, '未暂存的那处仍在工作区');
		assert.doesNotMatch(worktree, /line 3 CHANGED/, '已暂存的那处不再出现在工作区差异里');

		// 取消暂存同一块，索引回到 HEAD。
		const undone = await call({ command: 'applyHunk', filePath: 'f.txt', indexes: [0], direction: 'unstage' });
		assert.equal(undone.error, null, `取消暂存应成功：${String(undone.error)}`);
		assert.equal(git('diff', '--cached', '--no-color', '--', 'f.txt'), '', '索引里不再有该文件的改动');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
