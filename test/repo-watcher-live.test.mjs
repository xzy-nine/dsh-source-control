/**
 * 仓库结构监视的实机契约：在真实仓库上新建与移除工作树、初始化子模块，监视必须报告该仓库。
 *
 * 依赖文件系统事件，因此只在真实仓库上验证；事件合并窗口 250ms，这里留足余量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importHostModule } from './lib-import.mjs';

const watcher = await importHostModule('source-control/repo-watcher.js');
const { closeRepositoryWatchers, onRepositoryTreeChange, watchRepositories } = watcher;

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
 * @returns 仓库路径。
 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-watch-'));
	gitIn(repo, 'init', '-q', '-b', 'main');
	gitIn(repo, 'config', 'user.email', 'watch@example.com');
	gitIn(repo, 'config', 'user.name', 'Watch');
	writeFileSync(join(repo, 'a.txt'), 'a');
	gitIn(repo, 'add', '-A');
	gitIn(repo, 'commit', '-q', '-m', 'first');
	return repo;
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
