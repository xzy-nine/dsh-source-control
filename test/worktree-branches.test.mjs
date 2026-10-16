/**
 * 工作树占用分支的判定测试。
 *
 * 背景：被工作树检出的分支照样出现在 `git branch` 里，于是会被 `git log --branches`
 * 带进图形区、渲染成右侧标签，并进入「删除分支」候选；而 git 拒绝删除它们
 * （`cannot delete branch ... used by worktree at ...`）。规则是排除「别的工作树」
 * 占用的分支，保留当前查看工作树自己的分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseWorktreeList, foreignWorktreeBranches, parseHeadRef, readHeadRef, resolveGitDir } from '../src/source-control/worktree-branches.ts';

/**
 * 路径规范化：宿主 nodeId 的替身，统一分隔符并小写。
 *
 * 不调用 resolve：Windows 形态的固件路径在别的平台上不会被当作绝对路径，
 * 而这里要验证的是「比较前两边都过了规范化」这条规则。
 */
const lower = (path) => path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
/** 列表固件：主工作树在 feature 分支，链接工作树在 review 分支。 */
const PORCELAIN = [
	'worktree E:/repo/main',
	'HEAD b30f0aea1152c21ace799c3428f922f8e069c834',
	'branch refs/heads/feature',
	'',
	'worktree E:/repo/main/.agents/worktrees/review',
	'HEAD 2646a501c52d07bab7b1161cca2f3ea7d99ab0d4',
	'branch refs/heads/review',
	'',
].join('\n');

test('解析工作树列表的路径、分支与短哈希', () => {
	const entries = parseWorktreeList(PORCELAIN);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].path, 'E:/repo/main');
	assert.equal(entries[0].branch, 'feature', 'branch 应去掉 refs/heads/ 前缀');
	assert.equal(entries[0].head, 'b30f0ae', 'HEAD 应取短哈希');
	assert.equal(entries[1].branch, 'review');
});

test('裸仓库被标记出来', () => {
	const entries = parseWorktreeList('worktree E:/repo/bare\nbare\n');
	assert.equal(entries[0].bare, true);
});

test('查看主工作树时排除链接工作树的分支', () => {
	const foreign = foreignWorktreeBranches(parseWorktreeList(PORCELAIN), 'E:/repo/main', lower);
	assert.deepEqual([...foreign], ['review'], '应排除 review，保留当前分支');
});

test('查看链接工作树时排除其它工作树的分支', () => {
	const path = 'E:/repo/main/.agents/worktrees/review';
	const foreign = foreignWorktreeBranches(parseWorktreeList(PORCELAIN), path, lower);
	assert.deepEqual([...foreign], ['feature']);
});

test('路径大小写与分隔符不同也认定为同一工作树', () => {
	const foreign = foreignWorktreeBranches(parseWorktreeList(PORCELAIN), 'e:\\REPO\\MAIN\\', lower);
	assert.deepEqual([...foreign], ['review'], '规范化后主工作树不应排除自己的分支');
});

test('分离头指针的工作树不贡献分支名', () => {
	const detached = [
		'worktree E:/repo/main', 'HEAD b30f0ae', 'branch refs/heads/main', '',
		'worktree E:/repo/wt-detached', 'HEAD 2646a50', 'detached', '',
	].join('\n');
	const foreign = foreignWorktreeBranches(parseWorktreeList(detached), 'E:/repo/main', lower);
	assert.deepEqual([...foreign], [], '分离头指针没有分支，不应产生排除项');
});

test('单个工作树时没有任何分支被排除', () => {
	const only = 'worktree E:/repo/main\nHEAD b30f0ae\nbranch refs/heads/main\n';
	assert.deepEqual([...foreignWorktreeBranches(parseWorktreeList(only), 'E:/repo/main', lower)], []);
});

/* --- HEAD 文件解析 --- */

test('HEAD 指向分支时给出分支名', () => {
	assert.deepEqual(parseHeadRef('ref: refs/heads/main\n'), { branch: 'main', hash: null });
	assert.deepEqual(parseHeadRef('ref: refs/heads/feat/x'), { branch: 'feat/x', hash: null });
});

test('分离头指针时给出提交哈希', () => {
	const sha = 'b30f0aea1152c21ace799c3428f922f8e069c834';
	assert.deepEqual(parseHeadRef(`${sha}\n`), { branch: null, hash: sha });
});

test('HEAD 内容不可识别时分支与哈希皆为 null', () => {
	// 符号引用指向非分支（如标签）时不当作分支名。
	assert.deepEqual(parseHeadRef('ref: refs/tags/v1'), { branch: null, hash: null });
	assert.deepEqual(parseHeadRef(''), { branch: null, hash: null });
	assert.deepEqual(parseHeadRef('garbage'), { branch: null, hash: null });
});

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
