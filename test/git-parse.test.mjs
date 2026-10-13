/**
 * 解析层测试：用真实 git 输出校验各解析函数，覆盖 NUL 分隔、重命名记录、
 * 附注标签解引用、未提交伪提交与贮藏插入位置等边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DETAILS_FORMAT, LOG_FORMAT, REF_FORMAT, STASH_FORMAT, TAG_FORMAT,
	assembleCommits, generateFileChanges, parseCommitDetails, parseConfigList, parseLog,
	parseNameStatus, parseNumStat, parseRefs, parseStashReflog, parseTagInfo, parseTagSignature,
	splitRecords, UNCOMMITTED,
} from '../src/git-graph/git-parse.ts';

/**
 * 建一个临时仓库。
 *
 * @returns 仓库路径与执行 git 的辅助函数。
 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-parse-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const write = (name, content) => writeFileSync(join(repo, name), content);
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'parse@example.com');
	git('config', 'user.name', 'Parse');
	return { repo, git, write };
}

test('splitRecords 按固定字段数切分并丢弃末尾空字段', () => {
	assert.deepEqual(splitRecords('', 3), []);
	assert.deepEqual(splitRecords('a\0b\0c\0', 3), [['a', 'b', 'c']]);
	assert.deepEqual(splitRecords('a\0b\0c\0d\0e\0f\0', 3), [['a', 'b', 'c'], ['d', 'e', 'f']]);
	// 尾部残片不足一组时丢弃，不产生半条记录。
	assert.deepEqual(splitRecords('a\0b\0c\0d\0', 3), [['a', 'b', 'c']]);
});

test('提交信息含换行与 NUL 相邻字符时仍可解析', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'subject line\n\nbody with 换行 and more');
		const raw = git('-c', 'log.showSignature=false', 'log', '-z', `--format=${LOG_FORMAT}`, '-n', '1');
		const commits = parseLog(raw);
		assert.equal(commits.length, 1);
		// %s 只取标题：正文不进入 message。
		assert.equal(commits[0].message, 'subject line');
		assert.equal(commits[0].parents.length, 0);
		assert.equal(commits[0].email, 'parse@example.com');
		assert.ok(commits[0].date > 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('非 ASCII 路径在 -z 下原样取回', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('中文 文件.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		const raw = git('diff-tree', '--name-status', '-r', '--root', '--find-renames', '--diff-filter=AMDR', '-z', 'HEAD');
		const records = parseNameStatus(raw, { skipLeadingObjectName: true });
		assert.equal(records.length, 1);
		assert.equal(records[0].newFilePath, '中文 文件.txt');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('重命名在 name-status 与 numstat 下都带新旧两个路径', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('mv', 'a.txt', 'b.txt');
		git('commit', '-q', '-m', 'rename');

		const status = parseNameStatus(git('diff', '--name-status', '-z', '-M', 'HEAD~1', 'HEAD'));
		assert.deepEqual(status, [{ type: 'R', oldFilePath: 'a.txt', newFilePath: 'b.txt' }]);

		const numstat = parseNumStat(git('diff', '--numstat', '-z', '-M', 'HEAD~1', 'HEAD'));
		assert.equal(numstat.length, 1);
		assert.equal(numstat[0].filePath, 'b.txt');
		assert.equal(numstat[0].additions, 0);
		assert.equal(numstat[0].deletions, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('二进制文件的增删数解析为 null', () => {
	const { repo, git } = makeRepo();
	try {
		writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
		git('add', '-A');
		git('commit', '-q', '-m', 'binary');
		const numstat = parseNumStat(
			git('diff-tree', '--numstat', '-r', '--root', '--find-renames', '--diff-filter=AMDR', '-z', 'HEAD'),
			{ skipLeadingObjectName: true },
		);
		assert.equal(numstat.length, 1);
		assert.equal(numstat[0].filePath, 'bin.dat');
		assert.equal(numstat[0].additions, null);
		assert.equal(numstat[0].deletions, null);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('附注标签标注到被标注的提交而非标签对象', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('tag', '-a', 'ann', '-m', 'annotated');
		git('tag', 'light');

		const refs = parseRefs(git('for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/tags'));
		const commitHash = git('rev-parse', 'HEAD').trim();
		const tagObjectHash = git('rev-parse', 'refs/tags/ann').trim();
		assert.notEqual(tagObjectHash, commitHash);

		const ann = refs.tags.find((tag) => tag.name === 'ann');
		const light = refs.tags.find((tag) => tag.name === 'light');
		assert.equal(ann.annotated, true);
		assert.equal(ann.hash, commitHash, '附注标签应解引用到提交');
		assert.equal(light.annotated, false);
		assert.equal(light.hash, commitHash);
		assert.deepEqual(refs.heads, [{ hash: commitHash, name: 'main' }]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('远程 HEAD 符号引用与隐藏远程被排除', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		const head = git('rev-parse', 'HEAD').trim();
		git('update-ref', 'refs/remotes/origin/main', head);
		git('update-ref', 'refs/remotes/upstream/main', head);

		const raw = git('for-each-ref', `--format=${REF_FORMAT}`, 'refs/remotes');
		const all = parseRefs(raw);
		assert.deepEqual(all.remotes.map((r) => r.name), ['origin/main', 'upstream/main']);

		const hidden = parseRefs(raw, ['upstream']);
		assert.deepEqual(hidden.remotes.map((r) => r.name), ['origin/main']);

		git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
		const withHead = parseRefs(git('for-each-ref', `--format=${REF_FORMAT}`, 'refs/remotes'));
		assert.ok(!withHead.remotes.some((r) => r.name.endsWith('/HEAD')), '远程 HEAD 不应出现');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('配置列表按键取值且值中的换行被保留', () => {
	const stdout = 'user.name\nalice\0core.bare\nfalse\0weird.value\nline1\nline2\0';
	const configs = parseConfigList(stdout);
	assert.equal(configs['user.name'], 'alice');
	assert.equal(configs['core.bare'], 'false');
	assert.equal(configs['weird.value'], 'line1\nline2');
});

test('提交详情解析正文并保留签名状态', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'subject\n\nbody first\nbody second\n\n');
		const raw = git('-c', 'log.showSignature=false', 'show', '-z', '--quiet', `--format=${DETAILS_FORMAT}`, 'HEAD');
		const details = parseCommitDetails(raw);
		assert.equal(details.hash, git('rev-parse', 'HEAD').trim());
		assert.deepEqual(details.parents, []);
		assert.equal(details.author, 'Parse');
		assert.equal(details.committer, 'Parse');
		// 末尾空行去掉，正文内部换行保留。
		assert.equal(details.body, 'subject\n\nbody first\nbody second');
		assert.equal(details.signature, null);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('贮藏 reflog 解析出基提交与选择器', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		const base = git('rev-parse', 'HEAD').trim();
		write('a.txt', 'two');
		write('untracked.txt', 'u');
		git('stash', 'push', '-u', '-m', 'stash msg');

		const stashes = parseStashReflog(git('reflog', '-z', `--format=${STASH_FORMAT}`, 'refs/stash', '--'));
		assert.equal(stashes.length, 1);
		assert.equal(stashes[0].baseHash, base);
		assert.equal(stashes[0].selector, 'refs/stash@{0}');
		// 带未跟踪文件时第三个父提交存在。
		assert.notEqual(stashes[0].untrackedFilesHash, null);
		assert.equal(stashes[0].author, 'Parse');
		assert.ok(stashes[0].message.includes('stash msg'));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('无贮藏时 reflog 命令失败由调用方处理', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		let failed = false;
		try {
			git('reflog', '-z', `--format=${STASH_FORMAT}`, 'refs/stash', '--');
		} catch {
			failed = true;
		}
		assert.equal(failed, true, 'refs/stash 不存在时 git 以非零退出');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('标签详情解析打标签者、时间与消息', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('tag', '-a', 'v1', '-m', 'tag message');
		const raw = git('for-each-ref', 'refs/tags/v1', `--format=${TAG_FORMAT}`);
		const info = parseTagInfo(raw);
		assert.equal(info.taggerName, 'Parse');
		assert.equal(info.taggerEmail, 'parse@example.com');
		assert.ok(info.taggerDate > 0);
		assert.equal(info.signed, false);
		assert.equal(info.message, 'tag message');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('轻量标签没有打标签者', () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		git('tag', 'light');
		const raw = git('for-each-ref', 'refs/tags/light', `--format=${TAG_FORMAT}`);
		const info = parseTagInfo(raw);
		assert.equal(info.taggerName, '');
		assert.equal(info.message, 'base');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('GPG 状态行解析出签名与信任降级', () => {
	const good = parseTagSignature('[GNUPG:] GOODSIG ABC123 Alice <a@b.c>\n[GNUPG:] TRUST_ULTIMATE\n');
	assert.equal(good.status, 'G');
	assert.equal(good.key, 'ABC123');
	assert.equal(good.signer, 'Alice <a@b.c>');

	const untrusted = parseTagSignature('[GNUPG:] GOODSIG ABC123 Alice <a@b.c>\n[GNUPG:] TRUST_UNDEFINED\n');
	assert.equal(untrusted.status, 'U');

	const bad = parseTagSignature('[GNUPG:] BADSIG ABC123 Alice <a@b.c>\n');
	assert.equal(bad.status, 'B');

	assert.equal(parseTagSignature('no gnupg records here'), null);
});

test('改动列表把状态信息与增删数合并到同一路径', () => {
	const changes = generateFileChanges(
		[
			{ type: 'M', oldFilePath: 'a.txt', newFilePath: 'a.txt' },
			{ type: 'R', oldFilePath: 'old.txt', newFilePath: 'new.txt' },
		],
		[{ filePath: 'a.txt', additions: 3, deletions: 1 }],
		{ deleted: ['a.txt', 'gone.txt'], untracked: ['u.txt'] },
	);
	assert.deepEqual(changes, [
		{ oldFilePath: 'a.txt', newFilePath: 'a.txt', type: 'D', additions: 3, deletions: 1 },
		{ oldFilePath: 'old.txt', newFilePath: 'new.txt', type: 'R', additions: null, deletions: null },
		{ oldFilePath: 'gone.txt', newFilePath: 'gone.txt', type: 'D', additions: null, deletions: null },
		{ oldFilePath: 'u.txt', newFilePath: 'u.txt', type: 'U', additions: null, deletions: null },
	]);
});

test('未提交伪提交插在最前且带 HEAD 作父提交', () => {
	const refs = { head: 'h1', heads: [], tags: [], remotes: [] };
	const graph = assembleCommits(
		[{ hash: 'h1', parents: [], author: 'A', email: 'a@b.c', date: 10, message: 'first' }],
		refs, [], [], 2, true, 300, 99,
	);
	assert.equal(graph.commits.length, 2);
	assert.equal(graph.commits[0].hash, UNCOMMITTED);
	assert.deepEqual(graph.commits[0].parents, ['h1']);
	assert.equal(graph.commits[0].message, 'Uncommitted Changes (2)');
	assert.equal(graph.commits[0].date, 99);
	assert.equal(graph.commits[1].hash, 'h1');
	assert.equal(graph.moreCommitsAvailable, false);
});

test('没有未提交变更时不插入伪提交', () => {
	const graph = assembleCommits(
		[{ hash: 'h1', parents: [], author: 'A', email: 'a@b.c', date: 10, message: 'first' }],
		{ head: 'h1', heads: [], tags: [], remotes: [] }, [], [], 0, true, 300,
	);
	assert.deepEqual(graph.commits.map((commit) => commit.hash), ['h1']);
});

test('多取的一条被丢弃并置 moreCommitsAvailable', () => {
	const records = [
		{ hash: 'h3', parents: ['h2'], author: 'A', email: '', date: 3, message: 'c' },
		{ hash: 'h2', parents: ['h1'], author: 'A', email: '', date: 2, message: 'b' },
		{ hash: 'h1', parents: [], author: 'A', email: '', date: 1, message: 'a' },
	];
	const graph = assembleCommits(records, { head: 'h3', heads: [], tags: [], remotes: [] }, [], [], 0, true, 2);
	assert.equal(graph.commits.length, 2);
	assert.equal(graph.moreCommitsAvailable, true);
	assert.deepEqual(graph.commits.map((commit) => commit.hash), ['h3', 'h2']);
});

test('只被贮藏引用的提交在基提交前插入', () => {
	const records = [
		{ hash: 'h2', parents: ['h1'], author: 'A', email: '', date: 20, message: 'second' },
		{ hash: 'h1', parents: [], author: 'A', email: '', date: 10, message: 'first' },
	];
	const stash = {
		hash: 's1', baseHash: 'h1', untrackedFilesHash: null, selector: 'refs/stash@{0}',
		author: 'A', email: '', date: 15, message: 'stashed',
	};
	const graph = assembleCommits(records, { head: 'h2', heads: [], tags: [], remotes: [] }, [stash], [], 0, true, 300);
	assert.deepEqual(graph.commits.map((commit) => commit.hash), ['h2', 's1', 'h1']);
	assert.equal(graph.commits[1].stash.selector, 'refs/stash@{0}');
	assert.deepEqual(graph.commits[1].parents, ['h1']);
	assert.equal(graph.commits[2].stash, null);
});

test('已在列表中的贮藏只标记不插入', () => {
	const records = [
		{ hash: 's1', parents: ['h1'], author: 'A', email: '', date: 15, message: 'stashed' },
		{ hash: 'h1', parents: [], author: 'A', email: '', date: 10, message: 'first' },
	];
	const stash = {
		hash: 's1', baseHash: 'h1', untrackedFilesHash: null, selector: 'refs/stash@{0}',
		author: 'A', email: '', date: 15, message: 'stashed',
	};
	const graph = assembleCommits(records, { head: 'h1', heads: [], tags: [], remotes: [] }, [stash], [], 0, true, 300);
	assert.deepEqual(graph.commits.map((commit) => commit.hash), ['s1', 'h1']);
	assert.equal(graph.commits[0].stash.selector, 'refs/stash@{0}');
});

test('多个贮藏插在同一基提交上时按时间倒序', () => {
	const records = [{ hash: 'h1', parents: [], author: 'A', email: '', date: 10, message: 'first' }];
	const mk = (hash, date) => ({
		hash, baseHash: 'h1', untrackedFilesHash: null, selector: `refs/stash@{${hash}}`,
		author: 'A', email: '', date, message: hash,
	});
	const graph = assembleCommits(
		records, { head: 'h1', heads: [], tags: [], remotes: [] },
		[mk('old', 12), mk('new', 18)], [], 0, true, 300,
	);
	assert.deepEqual(graph.commits.map((commit) => commit.hash), ['new', 'old', 'h1']);
});

test('分支、标签与远程标注到对应提交并带上所属远程', () => {
	const records = [
		{ hash: 'h2', parents: ['h1'], author: 'A', email: '', date: 2, message: 'b' },
		{ hash: 'h1', parents: [], author: 'A', email: '', date: 1, message: 'a' },
	];
	const refs = {
		head: 'h2',
		heads: [{ hash: 'h2', name: 'main' }, { hash: 'h1', name: 'feature' }],
		tags: [{ hash: 'h2', name: 'v1', annotated: true }, { hash: 'h1', name: 'light', annotated: false }],
		remotes: [{ hash: 'h2', name: 'origin/main' }, { hash: 'h1', name: 'other/x' }],
	};
	const graph = assembleCommits(records, refs, [], ['origin'], 0, true, 300);
	assert.deepEqual(graph.commits[0].heads, ['main']);
	assert.deepEqual(graph.commits[1].heads, ['feature']);
	assert.deepEqual(graph.commits[0].tags, [{ name: 'v1', annotated: true }]);
	assert.deepEqual(graph.commits[0].remotes, [{ name: 'origin/main', remote: 'origin' }]);
	assert.deepEqual(graph.commits[1].remotes, [{ name: 'other/x', remote: null }]);
	assert.deepEqual(graph.tags, ['v1', 'light']);
	assert.equal(graph.head, 'h2');
});

test('不显示标签时提交上不带标签但 tags 列表仍返回', () => {
	const records = [{ hash: 'h1', parents: [], author: 'A', email: '', date: 1, message: 'a' }];
	const refs = { head: 'h1', heads: [], tags: [{ hash: 'h1', name: 'v1', annotated: false }], remotes: [] };
	const graph = assembleCommits(records, refs, [], [], 0, false, 300);
	assert.deepEqual(graph.commits[0].tags, []);
	assert.deepEqual(graph.tags, ['v1']);
});
