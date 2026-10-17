/**
 * 工作区快照解析：用真实 git 输出校验 `--porcelain=v2 --branch -z` 的条目与分支字段。
 *
 * `working-tree.ts` 有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入；
 * `pretest` 会先重建产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importHostModule } from './lib-import.mjs';

const { parseStatusSnapshot } = await importHostModule('source-control/working-tree.js');

/**
 * 建一个临时仓库。
 *
 * @returns 仓库路径与执行 git 的辅助函数。
 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-snapshot-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const write = (name, content) => writeFileSync(join(repo, name), content);
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'snap@example.com');
	git('config', 'user.name', 'Snap');
	return { repo, git, write };
}

/** 读取快照：参数与宿主命令一致。 */
function snapshot(repo) {
	const stdout = execFileSync('git', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return parseStatusSnapshot(stdout);
}

test('干净仓库只有分支信息', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		const snap = snapshot(repo);
		assert.deepEqual(snap.entries, []);
		assert.equal(snap.branch, 'main');
		assert.equal(snap.upstream, null);
		assert.equal(snap.ahead, 0);
		assert.equal(snap.behind, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('未跟踪、已修改、已暂存与重命名各自的 XY 状态', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\ntwo\n');
		write('b.txt', 'x\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('mv', 'a.txt', 'renamed.txt');
		write('b.txt', 'x\nmore\n');
		write('untracked.txt', 'new');
		git('add', 'b.txt');

		const snap = snapshot(repo);
		const byPath = new Map(snap.entries.map((entry) => [entry.path, entry]));
		assert.deepEqual(byPath.get('b.txt'), { path: 'b.txt', origPath: null, index: 'M', worktree: ' ' });
		assert.deepEqual(byPath.get('renamed.txt'), { path: 'renamed.txt', origPath: 'a.txt', index: 'R', worktree: ' ' });
		assert.deepEqual(byPath.get('untracked.txt'), { path: 'untracked.txt', origPath: null, index: '?', worktree: '?' });
		assert.equal(snap.entries.length, 3, '重命名的旧路径不作为独立条目');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('非 ASCII 路径原样取回', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('中文 文件.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		write('中文 文件.txt', 'two');
		const snap = snapshot(repo);
		assert.equal(snap.entries[0].path, '中文 文件.txt');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('分离头指针时分支为 null', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('checkout', '-q', '--detach', 'HEAD');
		assert.equal(snapshot(repo).branch, null);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('尚无提交时分支仍可取，未跟踪文件照常列出', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('n.txt', 'x');
		const snap = snapshot(repo);
		assert.equal(snap.branch, 'main');
		assert.deepEqual(snap.entries.map((entry) => entry.path), ['n.txt']);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('有上游时给出上游名与领先落后数', () => {
	const { repo, git, write } = makeRepo();
	const remote = mkdtempSync(join(tmpdir(), 'gg-snapshot-remote-'));
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
		git('remote', 'add', 'origin', remote);
		git('push', '-q', '--set-upstream', 'origin', 'main');
		write('a.txt', 'one\ntwo\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'second');

		const snap = snapshot(repo);
		assert.equal(snap.branch, 'main');
		assert.equal(snap.upstream, 'origin/main');
		assert.equal(snap.ahead, 1);
		assert.equal(snap.behind, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('上游引用被删除时按无上游处理', () => {
	const { repo, git, write } = makeRepo();
	const remote = mkdtempSync(join(tmpdir(), 'gg-snapshot-remote-'));
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
		git('remote', 'add', 'origin', remote);
		git('push', '-q', '--set-upstream', 'origin', 'main');
		// 配置仍在，引用被删：git 只给出 branch.upstream，不给 branch.ab。
		git('update-ref', '-d', 'refs/remotes/origin/main');

		const snap = snapshot(repo);
		assert.equal(snap.branch, 'main');
		assert.equal(snap.upstream, null);
		assert.equal(snap.ahead, 0);
		assert.equal(snap.behind, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('未合并记录按 XY 两列给出', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('c.txt', 'base');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('checkout', '-q', '-b', 'side');
		write('c.txt', 'side');
		git('add', '-A');
		git('commit', '-q', '-m', 'side');
		git('checkout', '-q', 'main');
		write('c.txt', 'main');
		git('add', '-A');
		git('commit', '-q', '-m', 'main');
		try { git('merge', 'side'); } catch { /* 冲突是预期结果 */ }

		const snap = snapshot(repo);
		const entry = snap.entries.find((item) => item.path === 'c.txt');
		assert.notEqual(entry, undefined);
		assert.equal(entry.index, 'U');
		assert.equal(entry.worktree, 'U');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('超出上限时截断条目但保留分支信息', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		write('a.txt', 'two');
		write('b.txt', 'b');
		const stdout = execFileSync('git', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
		const snap = parseStatusSnapshot(stdout, 1);
		assert.equal(snap.entries.length, 1);
		assert.equal(snap.branch, 'main');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
