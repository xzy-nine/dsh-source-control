/**
 * 宿主 hunk 解析的测试：用真实 git 输出校验逐块切分与行号区间。
 *
 * 重点：改动量大时不再退化成整文件「全删全加」——逐块内容必须由 git 给出；
 * 输出形状与 DSH 的 WorkspaceDiffHunk 一致，供复制来的 FileDiff 直接使用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedDiffHunks } from '../src/source-control/diff-hunks.ts';

/** 建一个临时仓库并在其中执行 git。 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-hunk-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'hunk@example.com');
	git('config', 'user.name', 'Hunk');
	return { repo, git };
}

/** 取统一差异文本。 */
function unifiedDiff(repo, ...args) {
	return execFileSync('git', ['diff', '--no-color', '--unified=3', ...args], { cwd: repo, encoding: 'utf8' });
}

/** 取 hunk 中某一侧的行文本（去掉首字符前缀）。 */
const sideLines = (hunk, sign) => hunk.lines.filter((line) => line.startsWith(sign)).map((line) => line.slice(1));

test('相隔较远的两处改动切成两个 hunk', () => {
	// 400 行文件只改首尾：整文件退化会得到 400 删 + 400 加，逐块应只有两小段。
	const { repo, git } = makeRepo();
	try {
		const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
		writeFileSync(join(repo, 'big.txt'), `${lines.join('\n')}\n`);
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		lines[0] = 'CHANGED head';
		lines[399] = 'CHANGED tail';
		writeFileSync(join(repo, 'big.txt'), `${lines.join('\n')}\n`);

		const hunks = parseUnifiedDiffHunks(unifiedDiff(repo, '--', 'big.txt'));
		assert.equal(hunks.length, 2, '首尾两处改动应各成一个 hunk');
		const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
		assert.ok(total < 20, `逐块内容应只含改动附近，实际 ${total} 行`);
		assert.ok(sideLines(hunks[0], '+').includes('CHANGED head'), '首个 hunk 应含头部改动');
		assert.ok(sideLines(hunks[1], '+').includes('CHANGED tail'), '末个 hunk 应含尾部改动');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('hunk 头给出两侧行号区间与行数', () => {
	const hunks = parseUnifiedDiffHunks([
		'@@ -7,7 +9,8 @@',
		' keep',
		'-old',
		'+new',
		'',
	].join('\n'));
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0].oldStart, 7);
	assert.equal(hunks[0].oldLines, 7);
	assert.equal(hunks[0].newStart, 9);
	assert.equal(hunks[0].newLines, 8);
});

test('省略行数的 hunk 头按 1 行处理', () => {
	const hunks = parseUnifiedDiffHunks(['@@ -3 +5 @@', '-a', '+b', ''].join('\n'));
	assert.equal(hunks[0].oldStart, 3);
	assert.equal(hunks[0].oldLines, 1);
	assert.equal(hunks[0].newStart, 5);
	assert.equal(hunks[0].newLines, 1);
});

test('行保留首字符前缀，供视图判定种类', () => {
	const { repo, git } = makeRepo();
	try {
		writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n');

		const hunks = parseUnifiedDiffHunks(unifiedDiff(repo, '--', 'a.txt'));
		assert.equal(hunks.length, 1);
		// 视图按 line[0] 判种类：`+` 新增、`-` 删除、空格为上下文。
		assert.deepEqual(hunks[0].lines.map((line) => line[0]), [' ', '-', '+', ' ']);
		assert.deepEqual(sideLines(hunks[0], '-'), ['two']);
		assert.deepEqual(sideLines(hunks[0], '+'), ['TWO']);
		assert.deepEqual(hunks[0].lines.filter((line) => line.startsWith(' ')).map((line) => line.slice(1)), ['one', 'three']);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('新增文件只有新增行', () => {
	const { repo, git } = makeRepo();
	try {
		writeFileSync(join(repo, 'base.txt'), 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		writeFileSync(join(repo, 'added.txt'), 'fresh\ncontent\n');
		git('add', '-A');

		const hunks = parseUnifiedDiffHunks(unifiedDiff(repo, '--cached', '--', 'added.txt'));
		assert.equal(hunks.length, 1);
		assert.deepEqual(sideLines(hunks[0], '-'), [], '新增文件没有删除行');
		assert.deepEqual(sideLines(hunks[0], '+'), ['fresh', 'content']);
		assert.equal(hunks[0].oldStart, 0, '新文件旧侧从 0 起');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('删除文件只有删除行', () => {
	const { repo, git } = makeRepo();
	try {
		writeFileSync(join(repo, 'gone.txt'), 'a\nb\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('rm', '-q', 'gone.txt');

		const hunks = parseUnifiedDiffHunks(unifiedDiff(repo, '--cached', '--', 'gone.txt'));
		assert.equal(hunks.length, 1);
		assert.deepEqual(sideLines(hunks[0], '-'), ['a', 'b']);
		assert.deepEqual(sideLines(hunks[0], '+'), []);
		assert.equal(hunks[0].newLines, 0, '删除后新侧为 0 行');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('文件头不进入任何一行', () => {
	const hunks = parseUnifiedDiffHunks([
		'diff --git a/x.ts b/x.ts',
		'index 1111111..2222222 100644',
		'--- a/x.ts',
		'+++ b/x.ts',
		'@@ -1,2 +1,2 @@',
		' keep',
		'-old',
		'+new',
		'',
	].join('\n'));
	assert.equal(hunks.length, 1);
	assert.deepEqual(hunks[0].lines, [' keep', '-old', '+new']);
});

test('无换行标记不进入内容', () => {
	const hunks = parseUnifiedDiffHunks([
		'@@ -1 +1 @@',
		'-old',
		'\\ No newline at end of file',
		'+new',
		'\\ No newline at end of file',
		'',
	].join('\n'));
	assert.equal(hunks.length, 1);
	assert.deepEqual(hunks[0].lines, ['-old', '+new']);
});

test('二进制与空差异没有 hunk', () => {
	assert.deepEqual(parseUnifiedDiffHunks(''), []);
	assert.deepEqual(parseUnifiedDiffHunks('diff --git a/b.bin b/b.bin\nBinary files differ\n'), []);
});

test('多个 hunk 按出现顺序返回', () => {
	const hunks = parseUnifiedDiffHunks([
		'@@ -1,1 +1,1 @@',
		'-a',
		'+A',
		'@@ -10,1 +10,1 @@',
		'-b',
		'+B',
		'@@ -20,1 +20,1 @@',
		'-c',
		'+C',
		'',
	].join('\n'));
	assert.deepEqual(hunks.map((hunk) => sideLines(hunk, '+')), [['A'], ['B'], ['C']]);
	assert.deepEqual(hunks.map((hunk) => hunk.newStart), [1, 10, 20]);
});
