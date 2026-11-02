/**
 * 工作树登记读取与占用分支判定的测试。
 *
 * 背景：被工作树检出的分支照样出现在 `git branch` 里，于是会被 `git log --branches`
 * 带进图形区、渲染成右侧标签，并进入「删除分支」候选；而 git 拒绝删除它们
 * （`cannot delete branch ... used by worktree at ...`）。规则是排除「别的工作树」
 * 占用的分支，保留当前查看工作树自己的分支。
 *
 * 工作树登记直接读公共目录下的 `worktrees/<名>/{gitdir,HEAD}`，因此这里既验证解析纯函数，
 * 也在真实仓库上验证读取结果与 `git worktree list --porcelain` 一致。
 */
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

test('查看主工作树时排除链接工作树的分支', () => {
	const foreign = foreignWorktreeBranches(RECORDS, 'E:/repo/main', lower);
	assert.deepEqual([...foreign], ['review'], '应排除 review，保留当前分支');
});

test('查看链接工作树时排除其它工作树的分支', () => {
	const path = 'E:/repo/main/.agents/worktrees/review';
	const foreign = foreignWorktreeBranches(RECORDS, path, lower);
	assert.deepEqual([...foreign], ['feature']);
});

test('路径大小写与分隔符不同也认定为同一工作树', () => {
	const foreign = foreignWorktreeBranches(RECORDS, 'e:\\REPO\\MAIN\\', lower);
	assert.deepEqual([...foreign], ['review'], '规范化后主工作树不应排除自己的分支');
});

test('分离头指针的工作树不贡献分支名', () => {
	const detached = [
		{ path: 'E:/repo/main', branch: 'main', head: 'b30f0ae', bare: false },
		{ path: 'E:/repo/wt-detached', branch: null, head: '2646a50', bare: false },
	];
	assert.deepEqual([...foreignWorktreeBranches(detached, 'E:/repo/main', lower)], [], '分离头指针没有分支，不应产生排除项');
});

test('单个工作树时没有任何分支被排除', () => {
	const only = [{ path: 'E:/repo/main', branch: 'main', head: 'b30f0ae', bare: false }];
	assert.deepEqual([...foreignWorktreeBranches(only, 'E:/repo/main', lower)], []);
});

/* --- git 配置的 core 段解析 --- */

test('core.bare 与 core.worktree 按 git 的写法解析', () => {
	assert.deepEqual(parseCoreConfig('[core]\n\tbare = false\n'), { bare: false, worktree: null });
	assert.deepEqual(parseCoreConfig('[core]\n\tbare = true\n'), { bare: true, worktree: null });
	assert.deepEqual(parseCoreConfig('[core]\n\tbare = yes\n'), { bare: true, worktree: null }, '布尔值按 git 的写法求值');
	assert.deepEqual(parseCoreConfig('[core]\n\tbare = 0\n'), { bare: false, worktree: null });
	assert.deepEqual(
		parseCoreConfig('[core]\n\tbare = false\n\tworktree = ../../../modsub\n'),
		{ bare: false, worktree: '../../../modsub' },
		'子模块的 core.worktree 记相对路径',
	);
});

test('core 段名与键名大小写不敏感，其它段忽略', () => {
	const source = '[Core]\n\tBare = true\n[remote "origin"]\n\tbare = false\n';
	assert.deepEqual(parseCoreConfig(source), { bare: true, worktree: null }, '子段里的同名键不算 core 段');
	assert.deepEqual(parseCoreConfig('[core "x"]\n\tbare = true\n'), { bare: false, worktree: null }, '子段不是 core 段');
	assert.deepEqual(parseCoreConfig(''), { bare: false, worktree: null });
});

test('配置值可带引号与转义', () => {
	assert.deepEqual(
		parseCoreConfig('[core]\n\tworktree = "C:\\\\repo root\\\\wt"\n'),
		{ bare: false, worktree: 'C:\\repo root\\wt' },
	);
});

/* --- 工作树根的还原 --- */

test('工作树登记里的 gitdir 还原成工作树根', () => {
	assert.equal(worktreeRootOf('E:/repo/wt/.git'), 'E:/repo/wt');
	assert.equal(worktreeRootOf('E:\\repo\\wt\\.git'), 'E:/repo/wt', '分隔符统一');
	assert.equal(worktreeRootOf('E:/repo/wt/.git/'), 'E:/repo/wt', '尾分隔符忽略');
	assert.equal(worktreeRootOf('E:/repo/wt'), null, '不以 .git 结尾时不认');
	assert.equal(worktreeRootOf('.git'), null, '相对路径无根');
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
