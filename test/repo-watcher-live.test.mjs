/**
 * 仓库结构监视的实机契约：在真实仓库上新建与移除工作树、初始化子模块，监视必须报告该仓库；
 * 在工作区里新建与删除仓库，工作区级监视必须报告该工作区。
 *
 * 依赖文件系统事件，因此只在真实仓库上验证；事件合并窗口 250ms（工作区级 400ms），这里留足余量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importHostModule } from './lib-import.mjs';

const watcher = await importHostModule('source-control/repo-watcher.js');
const { closeRepositoryWatchers, onRepositoryTreeChange, watchRepositories, watchWorkspace } = watcher;

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * 等条件成立。
 *
 * @param predicate - 判定函数。
 * @param timeoutMs - 超时毫秒数。
 * @returns 成立时为 true。
 */
async function waitFor(predicate, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((done) => setTimeout(done, 50));
	}
	return false;
}

/**
 * 建一个带提交的仓库。
 *
 * @param dir - 目录；省略时新建临时目录。
 * @returns 仓库路径。
 */
function makeRepo(dir = mkdtempSync(join(tmpdir(), 'gg-watch-'))) {
	mkdirSync(dir, { recursive: true });
	gitIn(dir, 'init', '-q', '-b', 'main');
	gitIn(dir, 'config', 'user.email', 'watch@example.com');
	gitIn(dir, 'config', 'user.name', 'Watch');
	writeFileSync(join(dir, 'a.txt'), 'a');
	gitIn(dir, 'add', '-A');
	gitIn(dir, 'commit', '-q', '-m', 'first');
	return dir;
}

test('新建与移除链接工作树都会报告该仓库', async () => {
	const repo = makeRepo();
	const worktreePath = mkdtempSync(join(tmpdir(), 'gg-watch-wt-'));
	rmSync(worktreePath, { recursive: true, force: true });
	const seen = [];
	const unsubscribe = onRepositoryTreeChange((changed) => { seen.push(changed); });
	try {
		watchRepositories([repo]);
		// 等监视挂载完成：挂载是异步的。
		await new Promise((done) => setTimeout(done, 300));

		gitIn(repo, 'worktree', 'add', '-q', '-b', 'linked', worktreePath);
		assert.ok(await waitFor(() => seen.length > 0), '新建工作树应触发结构事件');

		seen.length = 0;
		gitIn(repo, 'worktree', 'remove', '--force', worktreePath);
		assert.ok(await waitFor(() => seen.length > 0), '移除工作树应触发结构事件');
		assert.ok(seen.every((path) => path.toLowerCase() === repo.toLowerCase()), '事件给出仓库路径');
	} finally {
		unsubscribe();
		closeRepositoryWatchers();
		rmSync(worktreePath, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test('普通 git 操作不触发结构事件', async () => {
	const repo = makeRepo();
	const seen = [];
	const unsubscribe = onRepositoryTreeChange((changed) => { seen.push(changed); });
	try {
		watchRepositories([repo]);
		await new Promise((done) => setTimeout(done, 300));

		/*
		 * 一轮完整的读写操作：每次写都会在仓库根以 `.git` 名字冒泡数十次事件。
		 * 若监视目标含 `.git`，这里会持续报告结构变化，进而重扫、再起 git、再报事件。
		 */
		for (const name of ['b.txt', 'c.txt']) {
			writeFileSync(join(repo, name), name);
			gitIn(repo, 'status', '--porcelain');
			gitIn(repo, 'add', '-A');
			gitIn(repo, 'commit', '-q', '-m', `add ${name}`);
			gitIn(repo, 'worktree', 'list', '--porcelain');
		}
		// 留足合并窗口与事件投递时间。
		await new Promise((done) => setTimeout(done, 1200));
		assert.deepEqual(seen, [], '普通 git 操作不产生结构事件');
	} finally {
		unsubscribe();
		closeRepositoryWatchers();
		rmSync(repo, { recursive: true, force: true });
	}
});

test('新增 .gitmodules 声明会报告该仓库', async () => {
	const repo = makeRepo();
	const seen = [];
	const unsubscribe = onRepositoryTreeChange((changed) => { seen.push(changed); });
	try {
		watchRepositories([repo]);
		await new Promise((done) => setTimeout(done, 300));

		writeFileSync(join(repo, '.gitmodules'), '[submodule "dep"]\n\tpath = dep\n\turl = https://example.com/dep.git\n');
		assert.ok(await waitFor(() => seen.length > 0), '新增 .gitmodules 应触发结构事件');
	} finally {
		unsubscribe();
		closeRepositoryWatchers();
		rmSync(repo, { recursive: true, force: true });
	}
});

/* --- 工作区级监视 --- */

test('工作区里新建仓库会报告该工作区', async () => {
	const root = mkdtempSync(join(tmpdir(), 'gg-watch-ws-'));
	const seen = [];
	const unsubscribe = onRepositoryTreeChange((changed) => { seen.push(changed); });
	try {
		watchWorkspace(root);
		await new Promise((done) => setTimeout(done, 400));

		const nested = join(root, 'nested', 'new-repo');
		mkdirSync(nested, { recursive: true });
		makeRepo(nested);
		assert.ok(await waitFor(() => seen.length > 0), '新建的仓库目录此前没有句柄，只能由工作区级监视发现');
		assert.ok(
			seen.every((path) => resolve(path).toLowerCase() === resolve(root).toLowerCase()),
			'事件给出工作区根',
		);
	} finally {
		unsubscribe();
		closeRepositoryWatchers();
		rmSync(root, { recursive: true, force: true });
	}
});

test('工作区里删除仓库会报告该工作区', async () => {
	const root = mkdtempSync(join(tmpdir(), 'gg-watch-ws-rm-'));
	const repo = makeRepo(join(root, 'gone-repo'));
	const seen = [];
	const unsubscribe = onRepositoryTreeChange((changed) => { seen.push(changed); });
	try {
		watchRepositories([repo]);
		watchWorkspace(root);
		await new Promise((done) => setTimeout(done, 400));
		seen.length = 0;

		rmSync(repo, { recursive: true, force: true });
		assert.ok(await waitFor(() => seen.length > 0), '仓库目录被整体删除应触发结构事件');
	} finally {
		unsubscribe();
		closeRepositoryWatchers();
		rmSync(root, { recursive: true, force: true });
	}
});

test('工作区里的文件读写与普通 git 操作不触发工作区级事件', async () => {
	const root = mkdtempSync(join(tmpdir(), 'gg-watch-ws-quiet-'));
	const repo = makeRepo(join(root, 'repo'));
	const seen = [];
	const unsubscribe = onRepositoryTreeChange((changed) => { seen.push(changed); });
	try {
		watchRepositories([repo]);
		watchWorkspace(root);
		await new Promise((done) => setTimeout(done, 400));
		seen.length = 0;

		writeFileSync(join(root, 'notes.md'), 'n');
		mkdirSync(join(root, 'plain-dir'));
		for (const name of ['b.txt', 'c.txt']) {
			writeFileSync(join(repo, name), name);
			gitIn(repo, 'status', '--porcelain');
			gitIn(repo, 'add', '-A');
			gitIn(repo, 'commit', '-q', '-m', `add ${name}`);
			gitIn(repo, 'branch', `topic-${name}`);
			gitIn(repo, 'checkout', '-q', `topic-${name}`);
			gitIn(repo, 'checkout', '-q', 'main');
		}
		await new Promise((done) => setTimeout(done, 1500));
		assert.deepEqual(seen, [], '已知仓库内部的普通 git 操作与工作区里的普通文件改动都不产生结构事件');
	} finally {
		unsubscribe();
		closeRepositoryWatchers();
		rmSync(root, { recursive: true, force: true });
	}
});
