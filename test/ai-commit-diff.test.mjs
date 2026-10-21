/**
 * AI 提交信息的 diff 收集：修补上一次提交时超长文件不得让整份差异被丢弃。
 *
 * 被测模块有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importHostModule } from './lib-import.mjs';

const { collectDiff, splitDiffBlocks, fitSingleDiff, SINGLE_DIFF_MAX, DIFF_TOTAL_MAX } = await importHostModule('source-control/commit-diff.js');

/**
 * 建一个已配置身份的临时仓库。
 *
 * @returns 仓库路径与 git / 写文件辅助函数。
 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-aidiff-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	const write = (name, content) => writeFileSync(join(repo, name), content);
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'aidiff@example.com');
	git('config', 'user.name', 'AiDiff');
	git('config', 'core.autocrlf', 'false');
	return { repo, git, write };
}

test('修补路径：上一次提交只有超长文件时仍返回截断后的 diff', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('base.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		// 超过总量上限的单文件，旧实现会因此整份丢弃。
		write('huge.txt', 'x\n'.repeat(DIFF_TOTAL_MAX + 1));
		git('add', '-A');
		git('commit', '-q', '-m', 'second');

		const diff = execFileSync('git', ['diff', '--no-color', 'HEAD~1'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
		assert.ok(diff.length > DIFF_TOTAL_MAX, '夹具的整份差异应超过总量上限');

		const collected = await collectDiff(repo, true);
		assert.notEqual(collected.trim(), '', '修补路径不应返回空 diff');
		assert.ok(collected.includes('huge.txt'), '超长文件应出现在 diff 中');
		assert.ok(collected.length <= SINGLE_DIFF_MAX + 200, '超长文件应按单文件上限截断');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('修补路径：超长文件存在时小改动仍然进入 diff', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('base.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('huge.txt', 'x\n'.repeat(DIFF_TOTAL_MAX + 1));
		write('small.txt', 'small\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'second');

		const collected = await collectDiff(repo, true);
		assert.ok(collected.includes('small.txt'), '小文件应被保留');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('按文件块切分统一差异', () => {
	assert.deepEqual(splitDiffBlocks(''), []);
	const one = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
	assert.equal(splitDiffBlocks(one).length, 1);
	const two = one + 'diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n';
	assert.deepEqual(splitDiffBlocks(two), [one, two.slice(one.length)]);
	// 正文行以 +/-/空格 开头，块首分隔行不会被误判。
	assert.equal(splitDiffBlocks('diff --git a/z b/z\n+diff --git a/fake b/fake\n').length, 1);
});

test('单文件差异按上限截断并追加标记', () => {
	const short = 'diff --git a/x b/x\n';
	assert.equal(fitSingleDiff(short, SINGLE_DIFF_MAX), short);
	const long = 'a'.repeat(SINGLE_DIFF_MAX + 100);
	const fitted = fitSingleDiff(long, SINGLE_DIFF_MAX);
	assert.ok(fitted.length <= SINGLE_DIFF_MAX);
	assert.ok(fitted.endsWith('差异过长，以下内容已截断 ...\n'));
});

test('普通路径：暂存区为空时退回工作区与未跟踪文件', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('tracked.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('tracked.txt', 'one\ntwo\n');
		write('untracked.txt', 'new\n');

		const collected = await collectDiff(repo, false);
		assert.ok(collected.includes('tracked.txt'));
		assert.ok(collected.includes('untracked.txt'));
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('普通路径：暂存区非空时只取暂存内容', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('tracked.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('tracked.txt', 'staged\n');
		git('add', 'tracked.txt');
		write('tracked.txt', 'staged\nunstaged\n');
		write('untracked.txt', 'new\n');

		const collected = await collectDiff(repo, false);
		assert.ok(collected.includes('+staged'), '暂存内容应在 diff 中');
		assert.ok(!collected.includes('+unstaged'), '未暂存改动不应混入');
		assert.ok(!collected.includes('untracked.txt'), '未跟踪文件不应混入');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});
