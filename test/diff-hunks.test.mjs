/**
 * 统一差异的 hunk 解析测试：用真实 git 输出校验逐块切分。
 *
 * 重点是「改动量大时不再退化成整文件」——前端 DiffBlock 的本地 diff 在改动超过其
 * 搜索上限时会输出整份旧文件与整份新文件，因此逐块内容必须由 git 给出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedDiffHunks } from '../src/git-graph/diff-hunks.ts';

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
		const total = hunks.reduce((sum, hunk) => sum + hunk.oldText.split('\n').length, 0);
		assert.ok(total < 20, `逐块内容应只含改动附近，实际 ${total} 行`);
		assert.ok(hunks[0].newText.includes('CHANGED head'), '首个 hunk 应含头部改动');
		assert.ok(hunks[1].newText.includes('CHANGED tail'), '末个 hunk 应含尾部改动');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('上下文行同时进入新旧两侧', () => {
	const { repo, git } = makeRepo();
	try {
		writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n');

		const hunks = parseUnifiedDiffHunks(unifiedDiff(repo, '--', 'a.txt'));
		assert.equal(hunks.length, 1);
		assert.equal(hunks[0].oldText, 'one\ntwo\nthree', '旧侧含上下文与删除行');
		assert.equal(hunks[0].newText, 'one\nTWO\nthree', '新侧含上下文与新增行');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('新增文件的旧侧为空', () => {
	const { repo, git } = makeRepo();
	try {
		writeFileSync(join(repo, 'base.txt'), 'base\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		writeFileSync(join(repo, 'added.txt'), 'fresh\ncontent\n');
		git('add', '-A');

		const hunks = parseUnifiedDiffHunks(unifiedDiff(repo, '--cached', '--', 'added.txt'));
		assert.equal(hunks.length, 1);
		assert.equal(hunks[0].oldText, '', '新增文件没有旧侧内容');
		assert.equal(hunks[0].newText, 'fresh\ncontent');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('删除文件的旧侧保留、新侧为空', () => {
	const { repo, git } = makeRepo();
	try {
		writeFileSync(join(repo, 'gone.txt'), 'a\nb\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('rm', '-q', 'gone.txt');

		const hunks = parseUnifiedDiffHunks(unifiedDiff(repo, '--cached', '--', 'gone.txt'));
		assert.equal(hunks.length, 1);
		assert.equal(hunks[0].oldText, 'a\nb');
		assert.equal(hunks[0].newText, '');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('文件头不进入任何一侧', () => {
	const diff = [
		'diff --git a/x.ts b/x.ts',
		'index 1111111..2222222 100644',
		'--- a/x.ts',
		'+++ b/x.ts',
		'@@ -1,2 +1,2 @@',
		' keep',
		'-old',
		'+new',
		'',
	].join('\n');
	const hunks = parseUnifiedDiffHunks(diff);
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0].oldText, 'keep\nold');
	assert.equal(hunks[0].newText, 'keep\nnew');
});

test('无换行标记不进入内容', () => {
	const diff = [
		'@@ -1 +1 @@',
		'-old',
		'\\ No newline at end of file',
		'+new',
		'\\ No newline at end of file',
		'',
	].join('\n');
	const hunks = parseUnifiedDiffHunks(diff);
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0].oldText, 'old');
	assert.equal(hunks[0].newText, 'new');
});

test('二进制与空差异没有 hunk', () => {
	assert.deepEqual(parseUnifiedDiffHunks(''), []);
	assert.deepEqual(parseUnifiedDiffHunks('diff --git a/b.bin b/b.bin\nBinary files differ\n'), []);
});

test('多个 hunk 按出现顺序返回', () => {
	const diff = [
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
	].join('\n');
	const hunks = parseUnifiedDiffHunks(diff);
	assert.deepEqual(hunks.map((hunk) => hunk.newText), ['A', 'B', 'C']);
});
