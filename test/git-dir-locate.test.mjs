import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importHostModule } from './lib-import.mjs';

const mod = await importHostModule('source-control/worktree-branches.js');
const {
	parseCoreConfig, worktreeRootOf, readWorktrees, foreignWorktreeBranches,
	parseHeadRef, readHeadRef, resolveGitDir, resolveGitCommonDir,
} = mod;

/**
 * 路径规范化：宿主 nodeId 的替身，统一分隔符并小写。
 *
 * 不调用 resolve：Windows 形态的固件路径在别的平台上不会被当作绝对路径，
 * 而这里要验证的是「比较前两边都过了规范化」这条规则。
 */
const lower = (path) => path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();

/** 登记记录固件：主工作树在 feature 分支，链接工作树在 review 分支。 */
const RECORDS = [
	{ path: 'E:/repo/main', branch: 'feature', head: 'b30f0ae', bare: false },
	{ path: 'E:/repo/main/.agents/worktrees/review', branch: 'review', head: '2646a50', bare: false },
];

/* --- git 目录定位：与 git 的向上查找同语义 --- */

/** 建一个临时目录树并执行 git。 */
function makeGitFixture() {
	const root = mkdtempSync(join(tmpdir(), 'gg-gitdir-'));
	const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
	const init = (dir) => {
		mkdirSync(dir, { recursive: true });
		git(dir, 'init', '-q', '-b', 'main');
		git(dir, 'config', 'user.email', 'a@b.c');
		git(dir, 'config', 'user.name', 'a');
		writeFileSync(join(dir, 'a.txt'), '1\n');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-q', '-m', 'c1');
	};
	return { root, git, init };
}

/** 取 `git worktree list --porcelain` 里的工作树路径，作为读取结果的对照。 */
function porcelainWorktreePaths(repo) {
	const output = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
	return output.split(/\r?\n/)
		.filter((line) => line.startsWith('worktree '))
		.map((line) => resolve(line.slice('worktree '.length)));
}

test('工作树登记读取结果与 git worktree list 逐条一致', async () => {
	const { root, git, init } = makeGitFixture();
	const main = join(root, 'main');
	try {
		init(main);
		const wt = join(root, 'wt-feature');
		git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
		const detached = join(root, 'wt-detached');
		git(main, 'worktree', 'add', '-q', '--detach', detached, 'main');

		const commonDir = await resolveGitCommonDir(main);
		assert.equal(resolve(commonDir), resolve(join(main, '.git')), '主工作树的公共目录即 .git');

		const records = await readWorktrees(commonDir);
		assert.deepEqual(
			records.map((record) => resolve(record.path)).sort(),
			porcelainWorktreePaths(main).sort(),
			'记录集合与 git 一致',
		);
		const byPath = new Map(records.map((record) => [resolve(record.path), record]));
		assert.equal(byPath.get(resolve(main)).branch, 'main');
		assert.equal(byPath.get(resolve(wt)).branch, 'feature');
		assert.equal(byPath.get(resolve(detached)).branch, null, '分离头指针没有分支');
		assert.match(byPath.get(resolve(detached)).head ?? '', /^[0-9a-f]{7}$/, '分离头指针给出短哈希');
		assert.ok(records.every((record) => record.bare === false), '普通仓库没有裸记录');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('链接工作树与子模块的 .git 文件：经 gitdir 指向解析出各自的 HEAD', async () => {
	const { root, git, init } = makeGitFixture();
	const main = join(root, 'main');
	const subSrc = join(root, 'subsrc');
	try {
		init(main);
		init(subSrc);
		// 链接工作树：.git 为文件，指向主仓库 .git/worktrees/<名>，HEAD 与主仓库不同。
		const wt = join(root, 'wt-feature');
		git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
		assert.equal(readFileSync(join(wt, '.git'), 'utf8').startsWith('gitdir:'), true, '链接工作树的 .git 应为文件');

		// 子模块：.git 为文件，指向主仓库 .git/modules/<名>。
		git(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc, 'modsub');
		const sub = join(main, 'modsub');
		assert.equal(readFileSync(join(sub, '.git'), 'utf8').startsWith('gitdir:'), true, '子模块的 .git 应为文件');

		// 三者的 HEAD 各自由自己的 git 目录解析，互不串用。
		const [m, w, s] = await Promise.all([readHeadRef(main), readHeadRef(wt), readHeadRef(sub)]);
		assert.equal(m.branch, 'main');
		assert.equal(w.branch, 'feature', '链接工作树应读自己的 HEAD，而不是主仓库的');
		assert.equal(s.branch, 'main', '子模块应读自己的 HEAD');
		assert.notEqual(git(main, 'symbolic-ref', '--short', '-q', 'HEAD'), git(wt, 'symbolic-ref', '--short', '-q', 'HEAD'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('子模块的公共目录是自身，不是外层仓库', async () => {
	const { root, git, init } = makeGitFixture();
	const main = join(root, 'main');
	const subSrc = join(root, 'subsrc');
	try {
		init(main);
		init(subSrc);
		git(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc, 'modsub');
		const sub = join(main, 'modsub');

		const commonDir = await resolveGitCommonDir(sub);
		assert.equal(resolve(commonDir), resolve(join(main, '.git', 'modules', 'modsub')), '子模块的公共目录是自己的 git 目录');
		const records = await readWorktrees(commonDir);
		assert.equal(records.length, 1, '子模块只有自身一条记录');
		assert.equal(resolve(records[0].path), resolve(sub), '主工作树由 core.worktree 推导为子模块目录');
		assert.equal(records[0].branch, 'main');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('裸仓库只有一条 bare 记录', async () => {
	const { root, git, init } = makeGitFixture();
	const source = join(root, 'source');
	const bare = join(root, 'bare.git');
	try {
		init(source);
		git(root, 'clone', '-q', '--bare', source, bare);
		const commonDir = await resolveGitCommonDir(bare);
		const records = await readWorktrees(commonDir);
		assert.equal(records.length, 1);
		assert.equal(records[0].bare, true, '裸仓库标记为 bare');
		assert.equal(resolve(records[0].path), resolve(bare), '裸记录的 path 是 git 目录本身');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('工作树目录已删除时登记项仍在，标记指向已不存在的路径', async () => {
	const { root, git, init } = makeGitFixture();
	const main = join(root, 'main');
	try {
		init(main);
		const wt = join(root, 'wt-gone');
		git(main, 'worktree', 'add', '-q', '-b', 'gone', wt);
		rmSync(wt, { recursive: true, force: true });

		const records = await readWorktrees(await resolveGitCommonDir(main));
		const found = records.find((record) => resolve(record.path) === resolve(wt));
		assert.ok(found !== undefined, '登记项仍在，与 git worktree list 一致');
		assert.equal(found.branch, 'gone');
		assert.deepEqual(porcelainWorktreePaths(main).map((path) => resolve(path)), records.map((record) => resolve(record.path)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('没有 worktrees 目录时只给出主工作树', async () => {
	const { root, init } = makeGitFixture();
	const repo = join(root, 'repo');
	try {
		init(repo);
		const records = await readWorktrees(await resolveGitCommonDir(repo));
		assert.equal(records.length, 1);
		assert.equal(resolve(records[0].path), resolve(repo));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('仓库的子目录同样能定位到 git 目录（与 git 一样逐级向上）', async () => {
	const { root, init } = makeGitFixture();
	const repo = join(root, 'repo');
	try {
		init(repo);
		const deep = join(repo, 'src', 'deep');
		mkdirSync(deep, { recursive: true });

		const gitDir = await resolveGitDir(deep);
		assert.notEqual(gitDir, null, '子目录应向上找到仓库的 .git');
		assert.equal(await readHeadRef(deep).then((head) => head?.branch), 'main');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('裸仓库没有 .git，按 HEAD + objects + refs 判定', async () => {
	const { root } = makeGitFixture();
	const bare = join(root, 'bare.git');
	try {
		mkdirSync(bare, { recursive: true });
		execFileSync('git', ['-C', bare, 'init', '-q', '--bare', '-b', 'main'], { encoding: 'utf8' });

		assert.equal(await resolveGitDir(bare), resolve(bare));
		assert.equal((await readHeadRef(bare))?.branch, 'main');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('不是仓库的目录向上找不到 git 目录', async () => {
	const root = mkdtempSync(join(tmpdir(), 'gg-notrepo-'));
	try {
		assert.equal(await resolveGitDir(join(root, 'nothing')), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
