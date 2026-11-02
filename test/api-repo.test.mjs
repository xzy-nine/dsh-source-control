/**
 * 宿主命令集回归（仓库与远程）：用户身份、远程标注、重置、贮藏、提交对比、工作树占用与未知命令。
 *
 * 被测模块有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入；
 * `pretest` 会先重建宿主与客户端产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempPath } from './harness.mjs';

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与临时仓库，串行便于定位失败 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');

/**
 * 写入一个可执行的 git 钩子文件。
 *
 * 钩子必须带执行位才会被 git 运行；umask 会影响创建时的权限，写入后再显式补一次。
 *
 * @param {string} directory - 钩子目录。
 * @param {string} name - 钩子文件名。
 * @param {string} content - 文件内容。
 */
function writeHook(directory, name, content) {
	const path = join(directory, name);
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
}

/** 建一个含分支、标签、贮藏、重命名与未跟踪文件的仓库，并返回其路径与 git 辅助函数。 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-api-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const write = (name, content) => writeFileSync(join(repo, name), content);

	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'api@example.com');
	git('config', 'user.name', 'Api');

	write('a.txt', 'one\ntwo\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'first commit');
	git('tag', '-a', 'v1', '-m', 'release one');
	git('tag', 'light');

	write('a.txt', 'one\ntwo\nthree\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'second commit\n\nbody text here');

	git('branch', 'feature');
	git('mv', 'a.txt', 'renamed.txt');
	git('commit', '-q', '-m', 'rename a to renamed');

	write('renamed.txt', 'one\ntwo\nthree\nfour\n');
	write('untracked.txt', 'new file');
	git('stash', 'push', '-u', '-m', 'work in progress');

	write('renamed.txt', 'one\ntwo\nthree\nfour\nfive\n');
	return { repo, git, write };
}

/**
 * 取一条经真实路由 handler 发请求的调用函数。
 *
 * @param repo - 仓库路径。
 * @returns 发送命令并解析响应的函数。
 */
async function makeCaller(repo) {
	const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
	const routes = new Map();
	registerGgRoutes({
		register(spec) {
			routes.set(spec.path, spec.handler);
			return () => {};
		},
	});
	const handler = routes.get('/dsh-source-control/gg/api');
	return (message) => new Promise((resolve, reject) => {
		const body = JSON.stringify({ repo, ...message });
		const req = {
			method: 'POST',
			on(event, callback) {
				if (event === 'data') callback(Buffer.from(body, 'utf8'));
				if (event === 'end') callback();
				return req;
			},
		};
		const res = {
			writeHead() {},
			end(text) {
				try { resolve(JSON.parse(text)); } catch { reject(new Error(`非 JSON 响应：${text}`)); }
			},
		};
		Promise.resolve(handler(req, res)).catch(reject);
	});
}

test('用户身份读写与文件差异内容', async () => {
	const { repo } = makeRepo();
	try {
		const call = await makeCaller(repo);
		assert.deepEqual((await call({ command: 'editUserDetails', name: 'Api2', email: 'api2@example.com', location: 'local', deleteLocalName: false, deleteLocalEmail: false })).errors, []);
		assert.equal((await call({ command: 'loadConfig', remotes: [] })).config.user.name.local, 'Api2');
		assert.deepEqual((await call({ command: 'deleteUserDetails', name: true, email: true, location: 'local' })).errors, []);

		// HEAD 是重命名提交，此时 a.txt 只在父提交存在；取改动 a.txt 的那次提交。
		const target = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repo, encoding: 'utf8' }).trim();
		const diff = await call({ command: 'fileDiffContent', commitHash: target, filePath: 'a.txt', staged: false });
		assert.equal(typeof diff.oldText, 'string');
		assert.equal(typeof diff.newText, 'string');
		assert.ok(diff.hunks.length > 0, '应返回逐块差异');

		const archivePath = join(repo, 'archive.zip');
		assert.equal((await call({ command: 'createArchive', ref: 'HEAD', format: 'zip', outputPath: archivePath })).error, null);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('远程分支标注与 hideRemotes', async () => {
	const { repo, git } = makeRepo();
	try {
		const head = git('rev-parse', 'HEAD').trim();
		git('update-ref', 'refs/remotes/origin/main', head);
		git('update-ref', 'refs/remotes/upstream/main', head);
		git('remote', 'add', 'origin', 'https://github.com/o/r.git');
		git('remote', 'add', 'upstream', 'https://github.com/u/r.git');

		const call = await makeCaller(repo);
		const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: false, hideRemotes: [] });
		assert.ok(info.branches.includes('origin/main') && info.branches.includes('upstream/main'));
		assert.ok(!info.branches.some((name) => name.endsWith('/HEAD')), '远程 HEAD 符号引用不应出现');

		const commits = await call({
			command: 'loadCommits', branches: null, maxCommits: 50, showTags: true, showRemoteBranches: true,
			includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
			remotes: info.remotes, hideRemotes: [], stashes: [],
		});
		const node = commits.commits.find((commit) => commit.hash !== '*');
		assert.deepEqual(node.remotes, [
			{ name: 'origin/main', remote: 'origin' },
			{ name: 'upstream/main', remote: 'upstream' },
		]);

		const hidden = await call({
			command: 'loadCommits', branches: null, maxCommits: 50, showTags: true, showRemoteBranches: true,
			includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
			remotes: info.remotes, hideRemotes: ['upstream'], stashes: [],
		});
		assert.deepEqual(hidden.commits.find((commit) => commit.hash !== '*').remotes, [{ name: 'origin/main', remote: 'origin' }]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('重置三种模式与丢弃全部', async () => {
	const { repo, git } = makeRepo();
	try {
		const call = await makeCaller(repo);
		const head = git('rev-parse', 'HEAD').trim();
		const reset = async (mode) => {
			const result = await call({ command: 'resetToCommit', commit: head, resetMode: mode });
			assert.equal(result.error, null);
		};
		const restore = () => {
			git('checkout', '-q', '--', '.');
			git('clean', '-qfd');
			writeFileSync(join(repo, 'renamed.txt'), 'changed');
			writeFileSync(join(repo, 'fresh.txt'), 'fresh');
		};
		/** 改动进入暂存区后再重置，用于区分三种模式对暂存区的处理。 */
		const restoreStaged = () => {
			restore();
			git('add', 'renamed.txt');
		};

		// 软重置保留暂存区：已暂存的改动仍是已暂存。
		restoreStaged();
		await reset('soft');
		assert.match(git('status', '--short'), /^M  renamed\.txt$/m, '软重置应保留暂存区');

		// 混合重置清空暂存区但保留改动内容。
		restoreStaged();
		await reset('mixed');
		assert.match(git('status', '--short'), /^ M renamed\.txt$/m, '混合重置应把改动移出暂存区');

		// 硬重置丢弃已跟踪文件的改动，未跟踪文件不受影响。
		restoreStaged();
		await reset('hard');
		const afterHard = git('status', '--short');
		assert.ok(!afterHard.includes('renamed.txt'), '硬重置应丢弃已跟踪改动');
		assert.match(afterHard, /\?\? fresh\.txt/, '硬重置不应删除未跟踪文件');

		// 丢弃全部：已跟踪与未跟踪分开下发，两者都应生效。
		restore();
		const entries = (await call({ command: 'loadWorkingTree' })).entries;
		const tracked = entries.filter((entry) => !(entry.index === '?' && entry.worktree === '?')).map((entry) => entry.path);
		const untracked = entries.filter((entry) => entry.index === '?' && entry.worktree === '?').map((entry) => entry.path);
		assert.ok(tracked.length > 0 && untracked.length > 0, '应同时存在已跟踪与未跟踪改动');
		await call({ command: 'discardPaths', paths: tracked, untracked: false });
		await call({ command: 'discardPaths', paths: untracked, untracked: true });
		assert.deepEqual((await call({ command: 'loadWorkingTree' })).entries, [], '丢弃全部后工作区应干净');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('贮藏改动与推送上游', async () => {
	const { repo, git } = makeRepo();
	const remote = mkdtempSync(join(tmpdir(), 'gg-remote-'));
	try {
		const call = await makeCaller(repo);
		writeFileSync(join(repo, 'renamed.txt'), 'changed');
		writeFileSync(join(repo, 'fresh.txt'), 'fresh');

		// 贮藏应把全部改动（含未跟踪文件）移出工作区。
		const before = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		const stashed = await call({ command: 'pushStash', message: 'wip', includeUntracked: true });
		assert.equal(stashed.error, null);
		assert.deepEqual((await call({ command: 'loadWorkingTree' })).entries, []);
		const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		assert.equal(info.stashes.length, before.stashes.length + 1, '应新增一条贮藏');
		// 贮藏按时间倒序，新建的排在最前。
		assert.match(info.stashes[0].message, /wip/);

		// 未设上游时推送给出可读错误，而不是静默成功。
		const noUpstream = await call({ command: 'pushUpstream' });
		assert.equal(typeof noUpstream.error, 'string');
		assert.ok(noUpstream.error.length > 0, '未设上游时推送应报错而非静默成功');

		// 设上游后推送成功，远程出现该分支。
		execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
		git('remote', 'add', 'origin', remote);
		git('push', '-q', '--set-upstream', 'origin', 'main');
		assert.equal((await call({ command: 'pushUpstream' })).error, null);
		const remoteBranches = execFileSync('git', ['--git-dir', remote, 'branch', '--list', 'main'], { encoding: 'utf8' });
		assert.match(remoteBranches, /main/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('提交对比与两提交文件差异', async () => {
	const { repo, git, write } = makeRepo();
	try {
		const call = await makeCaller(repo);
		const first = git('rev-parse', 'HEAD~1').trim();
		const head = git('rev-parse', 'HEAD').trim();

		// 对比跨过一个提交：改动文件含该区间的全部结果。
		const comparison = await call({ command: 'compareCommits', commitHash: head, compareWithHash: first, fromHash: first, toHash: head, refresh: false });
		assert.equal(comparison.error, null);
		const paths = comparison.fileChanges.map((change) => change.newFilePath);
		assert.ok(paths.includes('renamed.txt'), '对比应含重命名后的路径');
		const renamed = comparison.fileChanges.find((change) => change.newFilePath === 'renamed.txt');
		assert.equal(typeof renamed.additions, 'number');

		// 两提交模式的单文件差异取 `baseHash → commitHash`，而非父提交。
		const diff = await call({ command: 'fileDiffContent', commitHash: head, filePath: 'renamed.txt', staged: false, baseHash: first });
		assert.ok(Array.isArray(diff.hunks) && diff.hunks.length > 0, '两提交差异应有 hunk');
		const added = diff.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith('+')).join('\n');
		assert.match(added, /three/, '新侧应含区间内新增的行');

		// 中文路径在对比模式下同样可读。
		write('中文文件.md', 'cn\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'add chinese file');
		const chineseHead = git('rev-parse', 'HEAD').trim();
		const chinese = await call({ command: 'fileDiffContent', commitHash: chineseHead, filePath: '中文文件.md', staged: false, baseHash: head });
		assert.equal(chinese.oldText, null, '新增文件的旧侧应为空');
		assert.match(chinese.newText, /cn/, '新增文件的新侧应有内容');

		// 单提交模式不受影响：仍与父提交比较。
		const single = await call({ command: 'fileDiffContent', commitHash: head, filePath: 'renamed.txt', staged: false });
		assert.ok(Array.isArray(single.hunks) && single.hunks.length > 0, '单提交差异应仍可用');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('被别的工作树检出的分支照常出现在提交图上，并回投占用名单', async () => {
	const { repo, git } = makeRepo();
	const worktreePath = mkdtempSync(join(tmpdir(), 'gg-api-wt-'));
	try {
		git('branch', 'linked');
		git('worktree', 'add', '-q', worktreePath, 'linked');

		const call = await makeCaller(repo);
		const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: false, hideRemotes: [] });
		const commits = await call({
			command: 'loadCommits', branches: null, maxCommits: 50, showTags: true, showRemoteBranches: true,
			includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
			remotes: info.remotes, hideRemotes: [], stashes: [],
		});
		const heads = commits.commits.flatMap((commit) => commit.heads ?? []);
		assert.ok(heads.includes('main'), '当前分支照常显示');
		assert.ok(heads.includes('linked'), '被别的工作树检出的分支照常显示');
		assert.deepEqual(commits.foreignBranches, ['linked'], '占用名单随响应回投，供客户端禁用操作');

		const containing = await call({ command: 'branchesContaining', commitHash: git('rev-parse', 'HEAD').trim() });
		assert.ok(!containing.local.includes('linked'), '删除候选中排除占用分支');
		assert.deepEqual(containing.foreign, ['linked'], 'branchesContaining 同样回投占用名单');
	} finally {
		rmSync(worktreePath, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test('未知命令被拒绝且非仓库路径不抛错', async () => {
	const { repo } = makeRepo();
	const absent = tempPath('gg-absent-');
	try {
		const call = await makeCaller(repo);
		const unknown = await call({ command: 'no-such-command' });
		assert.equal(unknown.code, 'unknown-command', '未知命令按稳定原因码拒绝');
		assert.ok(typeof unknown.error === 'string' && unknown.error !== '', '仍应给出可展示的错误文本');

		const outside = await makeCaller(absent);
		const info = await outside({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		assert.equal(info.isRepo, false);
	} finally {
		rmSync(absent, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});