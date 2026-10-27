/**
 * 仓库事实层契约：布局缓存的有效期、祖先与后代失效、打包引用的整读次数与守卫。
 *
 * 断言以真实临时仓库为对象，并在导入被测模块之前包裹 `readFile` / `stat`，按路径统计读取次数。
 * 宿主模块带内部 `.js` 相对导入，一律从 `lib/` 产物导入，`pretest` 会先重建产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importHostModule } from './lib-import.mjs';

/** 文件读取与 stat 的调用记录。 */
const readPaths = [];
const statPaths = [];
const originalReadFile = fs.readFile;
const originalStat = fs.stat;
fs.readFile = (...args) => { readPaths.push(String(args[0])); return originalReadFile(...args); };
fs.stat = (...args) => { statPaths.push(String(args[0])); return originalStat(...args); };
syncBuiltinESMExports();

const facts = await importHostModule('source-control/repo-facts.js');
const { runGit } = await importHostModule('source-control/working-tree.js');

/** 临时目录登记表；文件级 after 统一删除。 */
const temps = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** 清空调用记录。 */
function resetCounts() {
	readPaths.length = 0;
	statPaths.length = 0;
}

/**
 * 统计路径以给定后缀结尾的调用次数。
 *
 * @param list - 调用记录。
 * @param suffix - 路径后缀，如 `packed-refs`。
 * @returns 次数。
 */
function countOf(list, suffix) {
	return list.filter((path) => path.split('\\').join('/').endsWith(suffix)).length;
}

/**
 * 建一个已提交的临时仓库。
 *
 * @param prefix - 目录名前缀。
 * @returns 仓库路径与执行 git 的辅助函数。
 */
function makeRepo(prefix) {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	temps.push(repo);
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'facts@example.com');
	git('config', 'user.name', 'Facts');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
	return { repo, git };
}

test('parsePackedRefs 跳过注释与剥离行', () => {
	const refs = facts.parsePackedRefs([
		'# pack-refs with: peeled fully-peeled sorted',
		'aaaa refs/heads/main',
		'^bbbb',
		'cccc refs/tags/v1',
		'',
	].join('\n'));
	assert.deepEqual([...refs.keys()], ['refs/heads/main', 'refs/tags/v1']);
	assert.equal(refs.get('refs/heads/main'), 'aaaa');
});

test('repoHeadHash 与 git rev-parse 一致，打包引用只整读一次', async () => {
	const { repo, git } = makeRepo('gg-facts-head-');
	git('pack-refs', '--all');
	facts.setRepoFactsTtlForTest(10_000);
	const expected = git('rev-parse', 'HEAD').trim();

	resetCounts();
	assert.equal(await facts.repoHeadHash(repo), expected);
	assert.equal(countOf(readPaths, 'packed-refs'), 1, '首次读整份打包引用');

	// 二次调用命中 mtime 与大小守卫：只 stat 一次，不再整读。
	resetCounts();
	assert.equal(await facts.repoHeadHash(repo), expected);
	assert.equal(countOf(readPaths, 'packed-refs'), 0, '二次调用不整读打包引用');
});

test('打包引用被重写后守卫失配并重读', async () => {
	const { repo, git } = makeRepo('gg-facts-packed-');
	git('pack-refs', '--all');
	facts.setRepoFactsTtlForTest(10_000);
	const commonDir = join(repo, '.git');
	const head = git('rev-parse', 'HEAD').trim();

	resetCounts();
	assert.equal(await facts.readPackedRef(commonDir, 'refs/heads/main'), head);
	assert.equal(countOf(readPaths, 'packed-refs'), 1);

	// 多一条引用后打包：内容变长，守卫的大小不匹配。
	git('update-ref', 'refs/heads/extra', head);
	git('pack-refs', '--all');
	resetCounts();
	assert.equal(await facts.readPackedRef(commonDir, 'refs/heads/extra'), head);
	assert.equal(countOf(readPaths, 'packed-refs'), 1, '守卫失配后重读');
});

test('提交走执行层后布局缓存被作废', async () => {
	const { repo } = makeRepo('gg-facts-write-');
	facts.setRepoFactsTtlForTest(10_000);
	assert.notEqual(await facts.repoLayout(repo), null);

	// 命中缓存：不再逐级 stat `.git`。
	resetCounts();
	assert.notEqual(await facts.repoLayout(repo), null);
	assert.equal(countOf(statPaths, '.git'), 0, '命中布局缓存');

	assert.equal((await runGit(['commit', '--allow-empty', '-m', 'w'], repo)).code, 0);
	resetCounts();
	assert.notEqual(await facts.repoLayout(repo), null);
	assert.ok(countOf(statPaths, '.git') > 0, '写命令后重新解析布局');
});

test('失效按祖先与后代前缀生效', async () => {
	const { repo } = makeRepo('gg-facts-prefix-');
	const nested = join(repo, 'nested');
	mkdirSync(nested, { recursive: true });
	facts.setRepoFactsTtlForTest(10_000);
	assert.notEqual(await facts.repoLayout(repo), null);
	assert.notEqual(await facts.repoLayout(nested), null);

	// 作废祖先：后代条目一并失效。
	facts.invalidateRepoFacts(repo);
	resetCounts();
	assert.notEqual(await facts.repoLayout(nested), null);
	assert.ok(countOf(statPaths, '.git') > 0, '祖先失效后后代重新解析');

	// 作废后代：祖先条目同样失效。
	assert.notEqual(await facts.repoLayout(repo), null);
	facts.invalidateRepoFacts(nested);
	resetCounts();
	assert.notEqual(await facts.repoLayout(repo), null);
	assert.ok(countOf(statPaths, '.git') > 0, '后代失效后祖先重新解析');
});

test('有效期归零等于关闭缓存', async () => {
	const { repo } = makeRepo('gg-facts-ttl-');
	facts.setRepoFactsTtlForTest(10_000);
	assert.notEqual(await facts.repoLayout(repo), null);

	facts.setRepoFactsTtlForTest(0);
	resetCounts();
	assert.notEqual(await facts.repoLayout(repo), null);
	assert.notEqual(await facts.repoLayout(repo), null);
	assert.equal(countOf(statPaths, '.git'), 2, '关闭缓存后每次调用都重新解析');
});

test('未命中仓库的结果同样进缓存', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gg-facts-none-'));
	temps.push(dir);
	facts.setRepoFactsTtlForTest(10_000);
	facts.clearRepoFacts();
	const first = await facts.repoLayout(dir);
	resetCounts();
	assert.deepEqual(await facts.repoLayout(dir), first);
	assert.equal(statPaths.length, 0, '未命中的结果同样命中缓存');
});
