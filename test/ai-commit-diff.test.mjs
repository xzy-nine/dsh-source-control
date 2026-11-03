/**
 * AI 提交信息的改动收集：二进制、文档让位、合并提交与超长丢弃。
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

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与临时仓库，串行便于定位失败 */

const { collectDiff, splitDiffBlocks, fitSingleDiff, isDocPath, isBinaryBuffer, SINGLE_DIFF_MAX, DIFF_TOTAL_MAX, TRUNCATED_NOTE } = await importHostModule('source-control/commit-diff.js');

/**
 * 建一个已配置身份的临时仓库。
 *
 * @returns 仓库路径与 git / 写文件辅助函数。
 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-aidiff-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	const write = (name, content) => writeFileSync(join(repo, name), content);
	const writeBytes = (name, bytes) => writeFileSync(join(repo, name), Buffer.from(bytes));
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'aidiff@example.com');
	git('config', 'user.name', 'AiDiff');
	git('config', 'core.autocrlf', 'false');
	return { repo, git, write, writeBytes };
}

/** 一张含 NUL 字节的二进制内容。 */
const BINARY = [0, 1, 2, 0, 255, 254, 0, 7];

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
		assert.notEqual(collected.diff.trim(), '', '修补路径不应返回空 diff');
		assert.ok(collected.diff.includes('huge.txt'), '超长文件应出现在 diff 中');
		assert.ok(collected.diff.length <= SINGLE_DIFF_MAX + 200, '超长文件应按单文件上限截断');
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
		assert.ok(collected.diff.includes('small.txt'), '小文件应被保留');
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
	assert.ok(fitted.endsWith(TRUNCATED_NOTE), '截断标记应取自同一个常量');
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
		assert.ok(collected.diff.includes('tracked.txt'));
		assert.ok(collected.diff.includes('untracked.txt'));
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
		assert.ok(collected.diff.includes('+staged'), '暂存内容应在 diff 中');
		assert.ok(!collected.diff.includes('+unstaged'), '未暂存改动不应混入');
		assert.ok(!collected.diff.includes('untracked.txt'), '未跟踪文件不应混入');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('二进制文件：内容不进 diff，路径单独列出', async () => {
	const { repo, git, write, writeBytes } = makeRepo();
	try {
		write('text.txt', 'one\n');
		writeBytes('img.png', BINARY);
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('text.txt', 'two\n');
		writeBytes('img.png', [...BINARY, 42]);

		const collected = await collectDiff(repo, false);
		assert.deepEqual(collected.binary, ['img.png'], '二进制文件应单独列出');
		assert.ok(collected.diff.includes('text.txt'), '文本改动仍应进入 diff');
		assert.ok(!collected.diff.includes('img.png'), '二进制块不应进入 diff');
		assert.ok(!collected.diff.includes('Binary files'), 'git 的二进制提示行同样不进入 diff');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('二进制文件：未跟踪的二进制同样只列文件名', async () => {
	const { repo, git, write, writeBytes } = makeRepo();
	try {
		write('base.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		writeBytes('new.png', BINARY);

		const collected = await collectDiff(repo, false);
		assert.deepEqual(collected.binary, ['new.png']);
		assert.equal(collected.diff.trim(), '', '没有文本改动时 diff 为空');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('文档让位：预算充足时代码排在文档之前', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('base.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		// 文档块更短：若只按长度排序，文档会排在代码之前。
		write('code.ts', 'export const a = 1;\n'.repeat(5));
		write('doc.md', 'x\n');

		const collected = await collectDiff(repo, false);
		assert.ok(collected.diff.includes('code.ts'), '代码块应进入 diff');
		assert.ok(collected.diff.includes('doc.md'), '预算充足时文档同样进入 diff');
		assert.ok(
			collected.diff.indexOf('code.ts') < collected.diff.indexOf('doc.md'),
			'代码块应排在文档块之前，而不是按长度升序',
		);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('文档让位：超预算时文档与代码分别记入对应原因', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('base.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		/*
		 * 十个代码块各按单文件上限截断到五万字符，九个刚好填到四十五万，剩余预算装不下第十个；
		 * 文档块同样被截到五万，也装不下。文档排在代码之后，因此代码记 budget、文档记 document。
		 */
		for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts', 'j.ts']) {
			write(name, 'x\n'.repeat(30_000));
		}
		write('notes.md', 'y\n'.repeat(30_000));

		const collected = await collectDiff(repo, false);
		assert.ok(!collected.diff.includes('notes.md'), '预算吃紧时文档应让位');
		assert.ok(
			collected.dropped.some((file) => file.path === 'notes.md' && file.reason === 'document'),
			'让位的文档应记入 dropped 且原因为 document',
		);
		assert.ok(
			collected.dropped.some((file) => file.reason === 'budget'),
			'超出的代码块应记入 dropped 且原因为 budget',
		);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('合并提交：被合并入的提交信息与短哈希单独列出', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('base.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'root');
		git('checkout', '-q', '-b', 'feature');
		write('feature.txt', 'feature\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'feat: 被合并的分支提交');
		git('checkout', '-q', 'main');
		write('main.txt', 'main\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'main 侧改动');
		// 制造待提交的合并：--no-commit 让 MERGE_HEAD 留存。
		git('merge', '--no-commit', '--no-ff', 'feature');

		const collected = await collectDiff(repo, false);
		assert.equal(collected.merged.length, 1, '应取到一个被合并入的提交');
		assert.match(collected.merged[0].hash, /^[0-9a-f]{7,}$/, '短哈希应取自 git 的 %h');
		assert.ok(collected.merged[0].body.includes('feat: 被合并的分支提交'), '应取到被合并提交的完整信息');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('合并提交：修补一个合并提交时取其第二父提交', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('base.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'root');
		git('checkout', '-q', '-b', 'feature');
		write('feature.txt', 'feature\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'feat: 分支提交');
		git('checkout', '-q', 'main');
		write('main.txt', 'main\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'main 侧改动');
		git('merge', '--no-ff', '-m', 'merge feature', 'feature');
		write('after.txt', 'after\n');
		git('add', '-A');

		const collected = await collectDiff(repo, true);
		assert.equal(collected.merged.length, 1, '修补合并提交时应取到第二父提交');
		assert.ok(collected.merged[0].body.includes('feat: 分支提交'));
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('非合并提交不产生被合并入的提交段', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'a\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'root');
		write('a.txt', 'b\n');

		const collected = await collectDiff(repo, false);
		assert.deepEqual(collected.merged, []);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('超长丢弃：超出总预算的文件记入 dropped', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('base.txt', 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		// 每块都截到单文件上限，四块合计超过总量上限。
		for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts', 'j.ts', 'k.ts']) {
			write(name, 'x\n'.repeat(SINGLE_DIFF_MAX));
		}

		const collected = await collectDiff(repo, false);
		assert.ok(collected.dropped.length > 0, '超出总预算的文件应记入 dropped');
		for (const file of collected.dropped) {
			assert.ok(['document', 'budget'].includes(file.reason), '丢弃原因应取自固定集合');
			assert.ok(!collected.diff.includes('diff --git a/' + file.path), '丢弃的文件不应出现在 diff 里');
		}
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('文档路径按最后一个扩展名判定', () => {
	for (const path of ['a.md', 'a.txt', 'a.rst', 'a.adoc', 'a.org', 'dir.md/a.txt', 'A.MD']) {
		assert.equal(isDocPath(path), true, path + ' 应判为文档');
	}
	for (const path of ['a.ts', 'a.json', 'a.lock', 'Makefile', 'dir.md/a.ts', 'a.md.bak']) {
		assert.equal(isDocPath(path), false, path + ' 不应判为文档');
	}
});

test('二进制判定按文件头部的 NUL 字节', () => {
	assert.equal(isBinaryBuffer(Buffer.from(BINARY)), true);
	assert.equal(isBinaryBuffer(Buffer.from('纯文本\n', 'utf8')), false);
	assert.equal(isBinaryBuffer(Buffer.alloc(0)), false);
});