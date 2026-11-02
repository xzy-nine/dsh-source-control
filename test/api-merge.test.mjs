/**
 * 宿主命令集回归（合并）：合并到选中分支的各方式、拒绝原因码与冲突处理。
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

test('合并到选中分支：检出、待合并、初始提交信息', async () => {
	const { repo, git } = makeRepo();
	try {
		/* 旧分支停在公共基础，新分支在其上多出提交：这是「合并到选中分支」的典型场景。 */
		git('branch', 'target-branch');
		git('checkout', '-q', '-b', 'work-branch');
		for (const name of ['w1', 'w2']) {
			writeFileSync(join(repo, `${name}.txt`), name);
			git('add', '-A');
			git('commit', '-q', '-m', `work ${name}`);
		}
		const targetTip = git('rev-parse', 'target-branch').trim();

		const call = await makeCaller(repo);
		const result = await call({ command: 'mergeIntoBranch', branchName: 'target-branch', commitHash: targetTip, message: '', mode: 'no-ff' });
		assert.equal(result.error, null);
		assert.equal(result.branchName, 'target-branch');
		assert.equal(result.conflicted, false);
		assert.match(result.mergeMessage, /^Merge branch 'work-branch' into target-branch$/);

		// 已检出到目标分支，且停在待合并状态：目标分支尖端未移动。
		assert.equal(git('branch', '--show-current').trim(), 'target-branch');
		assert.equal(git('rev-parse', 'target-branch').trim(), targetTip);
		assert.notEqual(git('rev-parse', '-q', '--verify', 'MERGE_HEAD').trim(), '');

		// 合并改动进入暂存区，提交按钮因此可用。
		const staged = git('status', '--short');
		assert.match(staged, /^A  w1\.txt$/m);
		assert.match(staged, /^A  w2\.txt$/m);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('合并到选中分支：默认方式允许快进，不留待合并状态', async () => {
	const { repo, git } = makeRepo();
	try {
		// 目标分支停在公共基础、工作分支在其之上：git 会直接快进。
		git('branch', 'target-branch');
		git('checkout', '-q', '-b', 'work-branch');
		writeFileSync(join(repo, 'w1.txt'), 'w1');
		git('add', '-A');
		git('commit', '-q', '-m', 'work w1');
		const targetTip = git('rev-parse', 'target-branch').trim();

		const call = await makeCaller(repo);
		const result = await call({ command: 'mergeIntoBranch', branchName: 'target-branch', commitHash: targetTip, message: '', mode: 'default' });
		assert.equal(result.error, null);
		// 快进不留 MERGE_HEAD，也没有合并提交信息。
		assert.equal(result.mergeMessage, null);
		assert.equal(git('branch', '--show-current').trim(), 'target-branch');
		assert.equal(git('rev-parse', 'target-branch').trim(), git('rev-parse', 'work-branch').trim(), '快进后目标分支移到工作分支');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('合并到选中分支：压缩方式只进暂存区，不建立合并关系', async () => {
	const { repo, git } = makeRepo();
	try {
		git('branch', 'target-branch');
		git('checkout', '-q', '-b', 'work-branch');
		for (const name of ['w1', 'w2']) {
			writeFileSync(join(repo, `${name}.txt`), name);
			git('add', '-A');
			git('commit', '-q', '-m', `work ${name}`);
		}
		const targetTip = git('rev-parse', 'target-branch').trim();
		const workTip = git('rev-parse', 'work-branch').trim();

		const call = await makeCaller(repo);
		const result = await call({ command: 'mergeIntoBranch', branchName: 'target-branch', commitHash: targetTip, message: '', mode: 'squash' });
		assert.equal(result.error, null);
		assert.equal(result.conflicted, false);
		// 压缩不写 MERGE_MSG，也不移动目标分支：改动只落在索引里等提交。
		assert.equal(result.mergeMessage, null);
		assert.equal(git('rev-parse', 'target-branch').trim(), targetTip, '目标分支不移动');
		assert.notEqual(git('rev-parse', 'work-branch').trim(), '', '工作分支仍在');
		assert.equal(git('rev-parse', 'work-branch').trim(), workTip);
		const staged = git('status', '--short');
		assert.match(staged, /^A  w1\.txt$/m);
		assert.match(staged, /^A  w2\.txt$/m);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('合并到选中分支：冲突仍保持待合并并给出信息', async () => {
	const { repo, git } = makeRepo();
	try {
		writeFileSync(join(repo, 'conflict.txt'), 'base');
		git('add', '-A');
		git('commit', '-q', '-m', 'conflict base');
		git('branch', 'target-branch');
		git('checkout', '-q', '-b', 'work-branch');
		writeFileSync(join(repo, 'conflict.txt'), 'from work');
		git('add', '-A');
		git('commit', '-q', '-m', 'work side');
		git('checkout', '-q', 'target-branch');
		writeFileSync(join(repo, 'conflict.txt'), 'from target');
		git('add', '-A');
		git('commit', '-q', '-m', 'target side');
		git('checkout', '-q', 'work-branch');
		const targetTip = git('rev-parse', 'target-branch').trim();

		const call = await makeCaller(repo);
		const result = await call({ command: 'mergeIntoBranch', branchName: 'target-branch', commitHash: targetTip, message: '' });
		// 冲突不是失败：检出与待合并状态都已建立。
		assert.equal(result.error, null);
		assert.equal(result.conflicted, true);
		assert.match(result.mergeMessage, /# Conflicts:/);
		assert.equal(git('branch', '--show-current').trim(), 'target-branch');
		assert.notEqual(git('rev-parse', '-q', '--verify', 'MERGE_HEAD').trim(), '');
		assert.match(git('status', '--short'), /^UU conflict\.txt$/m);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('合并到选中分支：非尖端与不存在的分支被拒绝且不检出', async () => {
	const { repo, git } = makeRepo();
	try {
		git('branch', 'target-branch');
		git('checkout', '-q', '-b', 'work-branch');
		writeFileSync(join(repo, 'w.txt'), 'w');
		git('add', '-A');
		git('commit', '-q', '-m', 'work');
		const targetTip = git('rev-parse', 'target-branch').trim();
		// work 分支的尖端不在 target-branch 上，用它触发尖端校验失败。
		const notTip = git('rev-parse', 'HEAD').trim();
		assert.notEqual(notTip, targetTip);

		const call = await makeCaller(repo);
		const mismatch = await call({ command: 'mergeIntoBranch', branchName: 'target-branch', commitHash: notTip, message: '' });
		assert.equal(mismatch.code, 'not-tip', '尖端不符按稳定原因码拒绝');
		assert.equal(git('branch', '--show-current').trim(), 'work-branch', '校验失败不得检出');

		const absent = await call({ command: 'mergeIntoBranch', branchName: 'no-such-branch', commitHash: targetTip, message: '' });
		assert.equal(absent.code, 'no-branch', '分支不存在按稳定原因码拒绝');

		const same = await call({ command: 'mergeIntoBranch', branchName: 'work-branch', commitHash: git('rev-parse', 'HEAD').trim(), message: '' });
		assert.equal(same.code, 'same-branch', '合并到当前分支按稳定原因码拒绝');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('合并到选中分支：空合并可用空提交信息结束，沿用 git 生成的合并信息', async () => {
	/*
	 * 无冲突合并停下后索引与 HEAD 可能没有差异：两个分支加了同样的内容时，合并结果与任一侧一致。
	 * 此时提交仍然必须成立 —— 它是结束合并的唯一动作，信息留空表示沿用 MERGE_MSG。
	 */
	const { repo, git } = makeRepo();
	try {
		writeFileSync(join(repo, 'base.txt'), 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('branch', 'target-branch');
		git('checkout', '-q', '-b', 'work-branch');
		writeFileSync(join(repo, 'same.txt'), 'same\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'work side');
		git('checkout', '-q', 'target-branch');
		writeFileSync(join(repo, 'same.txt'), 'same\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'target side');
		// 合并方向是「当前分支合并到选中分支」，因此由 work-branch 发起。
		git('checkout', '-q', 'work-branch');
		const targetTip = git('rev-parse', 'target-branch').trim();

		const call = await makeCaller(repo);
		const merged = await call({ command: 'mergeIntoBranch', branchName: 'target-branch', commitHash: targetTip, message: '' });
		assert.equal(merged.error, null);
		assert.equal(merged.conflicted, false);

		const snapshot = await call({ command: 'loadWorkingTreeSnapshot' });
		assert.equal(snapshot.merging, true, '应处于待合并状态');
		assert.deepEqual(snapshot.entries, [], '两侧内容一致时索引没有改动');

		const commit = await call({ command: 'commitStaged', message: '', amend: false });
		assert.equal(commit.error, null, '空提交信息应沿用 git 生成的合并信息');
		assert.equal(typeof commit.hash, 'string');
		assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false, '合并应已结束');
		assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3, '合并提交应有两个父提交');

		const after = await call({ command: 'loadWorkingTreeSnapshot' });
		assert.equal(after.merging, false, '提交后不再处于合并中');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
