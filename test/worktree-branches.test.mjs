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
import { parseWorktreeList, foreignWorktreeBranches } from '../src/git-graph/worktree-branches.ts';
import { resolve } from 'node:path';

/** 与宿主 nodeId 一致：绝对化、统一 `/` 分隔、小写。 */
const lower = (path) => resolve(path).split('\\').join('/').toLowerCase();

/** 本仓库真实结构：主工作树在 dsh原生仿vscode，链接工作树在 main-worktree。 */
const PORCELAIN = [
	'worktree E:/repo/main',
	'HEAD b30f0aea1152c21ace799c3428f922f8e069c834',
	'branch refs/heads/dsh原生仿vscode',
	'',
	'worktree E:/repo/main/.agents/worktrees/main-worktree',
	'HEAD 2646a501c52d07bab7b1161cca2f3ea7d99ab0d4',
	'branch refs/heads/main-worktree',
	'',
].join('\n');

test('解析工作树列表的路径、分支与短哈希', () => {
	const entries = parseWorktreeList(PORCELAIN);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].path, 'E:/repo/main');
	assert.equal(entries[0].branch, 'dsh原生仿vscode', 'branch 应去掉 refs/heads/ 前缀');
	assert.equal(entries[0].head, 'b30f0ae', 'HEAD 应取短哈希');
	assert.equal(entries[1].branch, 'main-worktree');
});

test('裸仓库被标记出来', () => {
	const entries = parseWorktreeList('worktree E:/repo/bare\nbare\n');
	assert.equal(entries[0].bare, true);
});

test('查看主工作树时排除链接工作树的分支', () => {
	const foreign = foreignWorktreeBranches(parseWorktreeList(PORCELAIN), 'E:/repo/main', lower);
	assert.deepEqual([...foreign], ['main-worktree'], '应排除 main-worktree，保留当前分支');
});

test('查看链接工作树时排除其它工作树的分支', () => {
	const path = 'E:/repo/main/.agents/worktrees/main-worktree';
	const foreign = foreignWorktreeBranches(parseWorktreeList(PORCELAIN), path, lower);
	assert.deepEqual([...foreign], ['dsh原生仿vscode']);
});

test('路径大小写与分隔符不同也认定为同一工作树', () => {
	const foreign = foreignWorktreeBranches(parseWorktreeList(PORCELAIN), 'e:\\REPO\\MAIN\\', lower);
	assert.deepEqual([...foreign], ['main-worktree'], '规范化后主工作树不应排除自己的分支');
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
