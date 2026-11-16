/**
 * 宿主命令集回归（工作区与提交）：暂存、快照、提交详情、写操作、钩子探测与提交推送。
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

test('初始化仓库：在空工作区根建仓库，重复执行是无改动的再初始化', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gg-api-init-'));
	try {
		const call = await makeCaller(dir);
		const created = await call({ command: 'initRepository' });
		assert.equal(created.error, null, '空目录可初始化');
		assert.equal(created.command, 'initRepository');
		assert.equal(existsSync(join(dir, '.git')), true, '应生成 .git 目录');
		// 不暂存也不提交：git 初始化后工作区仍是空仓库。
		const head = await call({ command: 'loadCommits', limit: 10, skip: 0, showTags: true, showRemoteBranches: true, hideRemotes: [], remotes: [] });
		assert.deepEqual(head.commits, [], '新仓库没有提交');
		assert.equal(head.error, null);

		// 已经是仓库时 git 只做再初始化：成功且不改动任何内容，因此面板不必区分首次与重复。
		const again = await call({ command: 'initRepository' });
		assert.equal(again.error, null);
		assert.equal(existsSync(join(dir, '.git')), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('暂存与取消暂存：空路径表示全部，走集合命令', async () => {
	const { repo, git } = makeRepo();
	try {
		const call = await makeCaller(repo);
		writeFileSync(join(repo, 'bulk-a.txt'), 'a');
		writeFileSync(join(repo, 'bulk-b.txt'), 'b');
		writeFileSync(join(repo, 'bulk-c.txt'), 'c');
		const staged = await call({ command: 'stagePaths', paths: [] });
		assert.equal(staged.error, null);
		const indexed = git('ls-files').split('\n');
		for (const name of ['bulk-a.txt', 'bulk-b.txt', 'bulk-c.txt']) {
			assert.ok(indexed.includes(name), `空路径应把 ${name} 一并暂存`);
		}
		const unstaged = await call({ command: 'unstagePaths', paths: [] });
		assert.equal(unstaged.error, null);
		assert.equal(git('ls-files').includes('bulk-a.txt'), false, '空路径应取消全部暂存');
		// 文件夹行走目录 pathspec：一条命令处理目录下全部条目，不逐条列子文件。
		mkdirSync(join(repo, 'nested/deeper'), { recursive: true });
		writeFileSync(join(repo, 'nested/one.txt'), '1');
		writeFileSync(join(repo, 'nested/deeper/two.txt'), '2');
		await call({ command: 'stagePaths', paths: ['nested/'] });
		const nestedIndexed = git('ls-files').split('\n');
		assert.ok(nestedIndexed.includes('nested/one.txt') && nestedIndexed.includes('nested/deeper/two.txt'), '目录 pathspec 应暂存目录下全部文件');
		await call({ command: 'unstagePaths', paths: ['nested/'] });
		assert.equal(git('ls-files').includes('nested/one.txt'), false, '目录 pathspec 应取消暂存目录下全部文件');
		// 快照响应带截断标记：未超出上限时为 false，客户端据此决定是否给出计数后缀。
		const snapshot = await call({ command: 'loadWorkingTreeSnapshot', noCache: true });
		assert.equal(snapshot.truncated, false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('仓库信息、提交图与配置', async () => {
	const { repo } = makeRepo();
	try {
		const call = await makeCaller(repo);
		const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		assert.equal(info.isRepo, true);
		assert.equal(info.branches[0], info.head, '当前分支应排首位');
		assert.equal(info.stashes.length, 1);

		const commits = await call({
			command: 'loadCommits', branches: null, maxCommits: 300, showTags: true, showRemoteBranches: true,
			includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
			remotes: info.remotes, hideRemotes: [], stashes: info.stashes,
		});
		assert.equal(commits.error, null);
		// 未提交伪提交不在宿主侧插入：该行由客户端按工作区快照补出。
		assert.equal(commits.commits.some((commit) => commit.hash === '*'), false);
		assert.deepEqual(commits.commits.flatMap((commit) => commit.heads).sort(), ['feature', 'main']);

		const tagged = commits.commits.find((commit) => (commit.tags ?? []).some((tag) => tag.name === 'v1'));
		assert.ok(tagged !== undefined, '附注标签应标注到提交上');
		assert.ok(commits.commits.some((commit) => commit.stash !== null && commit.stash !== undefined), '贮藏应插入图中');

		const config = await call({ command: 'loadConfig', remotes: [] });
		assert.equal(config.config.user.name.local, 'Api');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('提交详情：普通、根、重命名、工作区与贮藏', async () => {
	const { repo } = makeRepo();
	try {
		const call = await makeCaller(repo);
		const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		const commits = await call({
			command: 'loadCommits', branches: null, maxCommits: 300, showTags: true, showRemoteBranches: true,
			includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
			remotes: info.remotes, hideRemotes: [], stashes: info.stashes,
		});
		const find = (message) => commits.commits.find((commit) => commit.message === message);

		const second = await call({ command: 'commitDetails', commitHash: find('second commit').hash, hasParents: true, stash: null });
		assert.equal(second.commitDetails.body, 'second commit\n\nbody text here');
		assert.ok(second.commitDetails.fileChanges.length > 0);
		assert.equal(typeof second.commitDetails.fileChanges[0].additions, 'number');

		const first = await call({ command: 'commitDetails', commitHash: find('first commit').hash, hasParents: false, stash: null });
		assert.ok(first.commitDetails.fileChanges.length > 0, '根提交应可读');

		const rename = await call({ command: 'commitDetails', commitHash: find('rename a to renamed').hash, hasParents: true, stash: null });
		const renamed = rename.commitDetails.fileChanges.find((change) => change.type === 'R');
		assert.equal(renamed.oldFilePath, 'a.txt');
		assert.equal(renamed.newFilePath, 'renamed.txt');

		const uncommitted = await call({ command: 'commitDetails', commitHash: '*', hasParents: true, stash: null });
		assert.ok(uncommitted.commitDetails.fileChanges.length > 0, '工作区应列出改动');

		const stashNode = commits.commits.find((commit) => commit.stash !== null && commit.stash !== undefined);
		const stashDetails = await call({ command: 'commitDetails', commitHash: stashNode.hash, hasParents: true, stash: stashNode.stash });
		assert.notEqual(stashDetails.commitDetails, null);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});


test('分支、标签、贮藏与远程的写操作', async () => {
	const { repo } = makeRepo();
	try {
		const call = await makeCaller(repo);
		const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

		assert.deepEqual((await call({ command: 'createBranch', branchName: 'api-branch', commitHash: head, checkout: false, force: false })).errors, [null]);
		assert.equal((await call({ command: 'renameBranch', oldName: 'api-branch', newName: 'api-renamed' })).error, null);
		assert.deepEqual((await call({ command: 'deleteBranch', branchName: 'api-renamed', forceDelete: true, deleteOnRemotes: [] })).errors, [null]);

		assert.deepEqual((await call({ command: 'addTag', tagName: 'v2', commitHash: head, type: 1, message: 'release two', force: false, pushToRemote: null })).errors, [null]);
		assert.equal((await call({ command: 'deleteTag', tagName: 'v2', deleteOnRemote: null })).error, null);

		assert.equal((await call({ command: 'pushStash', message: 'api stash', includeUntracked: true })).error, null);
		assert.equal((await call({ command: 'dropStash', selector: 'refs/stash@{0}' })).error, null);

		assert.equal((await call({ command: 'addRemote', name: 'origin', url: 'https://example.com/x.git', pushUrl: null, fetch: false })).error, null);
		const withRemote = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: false, hideRemotes: [] });
		assert.equal(withRemote.remotes[0].url, 'https://example.com/x.git');
		assert.equal((await call({ command: 'editRemote', nameOld: 'origin', nameNew: 'upstream', urlOld: 'https://example.com/x.git', urlNew: 'https://example.com/y.git', pushUrlOld: null, pushUrlNew: null })).error, null);
		assert.equal((await call({ command: 'deleteRemote', name: 'upstream' })).error, null);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('检出远程分支：本地同名分支的归属决定检出还是报告冲突', async () => {
	const { repo, git } = makeRepo();
	const bare = tempPath('gg-api-remote-');
	try {
		execFileSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf8' });
		git('remote', 'add', 'other', bare);
		git('push', '-q', 'other', 'main');
		git('fetch', '-q', 'other');
		const call = await makeCaller(repo);

		// 本地没有同名分支：新建跟踪分支并检出。
		assert.deepEqual((await call({ command: 'checkoutBranch', branchName: 'other/main', remoteBranch: 'other/main' })).errors, [null]);
		assert.equal(git('branch', '--show-current').trim(), 'other/main');
		// 上游与本地分支同名时 git 给多一层前缀的写法，插件统一收敛成远程分支短名。
		assert.equal(git('for-each-ref', '--format=%(upstream:short)', 'refs/heads/other/main').trim(), 'remotes/other/main');
		assert.equal((await call({ command: 'loadWorkingTreeSnapshot', noCache: true })).upstream, 'other/main');

		// 本地该分支正跟踪同一远程分支：直接检出它，不报「已存在」。
		git('checkout', '-q', 'main');
		assert.deepEqual((await call({ command: 'checkoutBranch', branchName: 'other/main', remoteBranch: 'other/main' })).errors, [null]);
		assert.equal(git('branch', '--show-current').trim(), 'other/main');

		// 本地同名分支没有上游：报告冲突，不静默落到它上面。
		git('checkout', '-q', 'main');
		const conflict = await call({ command: 'checkoutBranch', branchName: 'main', remoteBranch: 'other/main' });
		assert.match(conflict.errors[0], /already exists/i);
		assert.equal(git('branch', '--show-current').trim(), 'main');
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(bare, { recursive: true, force: true });
	}
});

test('按分支抓取：只取指定远程的指定分支，其他远程与分支不动', async () => {
	const { repo, git } = makeRepo();
	const kept = tempPath('gg-api-keep-');
	const skipped = tempPath('gg-api-skip-');
	try {
		for (const bare of [kept, skipped]) {
			execFileSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf8' });
			git('push', '-q', bare, 'main');
		}
		// kept 上多留一个非 main 分支：抓 main 时它不该被一起取回。
		git('branch', 'side', 'main');
		git('push', '-q', kept, 'side');
		git('remote', 'add', 'kept', kept);
		git('remote', 'add', 'skipped', skipped);
		const call = await makeCaller(repo);

		// 只抓 kept 的 main：不产生 skipped 的任何远程跟踪引用。
		const fetched = await call({ command: 'fetch', name: 'kept', prune: false, pruneTags: false, branch: 'main' });
		assert.equal(fetched.error ?? null, null, '按分支抓取应成功');
		assert.match(git('for-each-ref', '--format=%(refname)', 'refs/remotes'), /refs\/remotes\/kept\/main/);
		assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/remotes/skipped'), '', '未被指定的远程不应被访问');
		assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/remotes/kept/side'), '', '同一远程的其他分支也不该被取回');

		// 清理选项作用于整个远程，与按分支抓取不同时成立：直接拒绝，不起 git fetch。
		const rejected = await call({ command: 'fetch', name: 'kept', prune: true, pruneTags: false, branch: 'main' });
		assert.match(rejected.error, /不能同时清理/);
		// 没有远程名就无从判定抓哪一个：同样拒绝。
		const noRemote = await call({ command: 'fetch', name: null, prune: false, pruneTags: false, branch: 'main' });
		assert.match(noRemote.error, /必须指定远程名/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(kept, { recursive: true, force: true });
		rmSync(skipped, { recursive: true, force: true });
	}
});

test('停止操作：按停止键终止在跑的 git 子进程', async () => {
	const { repo, git } = makeRepo();
	const bare = tempPath('gg-api-cancel-remote-');
	try {
		execFileSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf8' });
		git('remote', 'add', 'origin', bare);
		// 先建立上游并推一次，此时还没有阻塞用的钩子。
		git('push', '-q', '-u', 'origin', 'main');

		/*
		 * 再制造一个可控的长任务：pre-push 钩子睡住，推送到结束前 git 一直不返回，
		 * 停止键因此有真实的子进程可终止。留一个待推的新提交，否则 git 会直接报 up-to-date 而不跑钩子。
		 */
		writeFileSync(join(repo, 'pending.txt'), 'pending\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'pending push');
		writeHook(join(repo, '.git', 'hooks'), 'pre-push', '#!/bin/sh\nsleep 8\n');

		const call = await makeCaller(repo);

		// 没有该键对应的操作时返回 0：停止一个已经结束的操作属正常情况。
		const idle = await call({ command: 'cancelOperation', key: 'no-such-key' });
		assert.equal(idle.stopped, 0);
		assert.equal(idle.error ?? null, null, '停止是用户主动行为，命令本身恒成功');
		const empty = await call({ command: 'cancelOperation', key: '' });
		assert.equal(empty.stopped, 0);

		// 起一次真实推送：它会被钩子挡住，等到子进程登记完成再停止。
		const pending = call({ command: 'pushUpstream', skipHooks: false, cancelKey: 'cancel-test-key' });
		await new Promise((resolve) => setTimeout(resolve, 2500));
		const stopped = await call({ command: 'cancelOperation', key: 'cancel-test-key' });
		assert.ok(stopped.stopped >= 1, '应终止在跑的 git 子进程，实际 ' + String(stopped.stopped));

		// 被终止的推送以失败回投，不会假装成功。
		const pushed = await pending;
		assert.notEqual(pushed.error ?? null, null, '被停止的推送应报错');
		// 登记随之清理：同一个键再停一次没有进程可终止。
		const again = await call({ command: 'cancelOperation', key: 'cancel-test-key' });
		assert.equal(again.stopped, 0, '结束后登记应已清理');
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(bare, { recursive: true, force: true });
	}
});

test('钩子探测：默认钩子目录与 core.hooksPath 都识别，未激活时为 false', async () => {
	const { repo } = makeRepo();
	try {
		const call = await makeCaller(repo);

		// 默认钩子目录里没有任何可执行钩子（只有 .sample）。
		const none = await call({ command: 'hooksState' });
		assert.equal(none.commit, false);
		assert.equal(none.push, false);
		assert.match(none.directory, /hooks$/, '默认钩子目录在 git 目录下');

		// 放两个真实钩子文件：提交与推送各一个。
		const hooksDir = none.directory;
		mkdirSync(hooksDir, { recursive: true });
		writeHook(hooksDir, 'pre-commit', '#!/bin/sh\nexit 0\n');
		writeHook(hooksDir, 'pre-push', '#!/bin/sh\nexit 0\n');
		const both = await call({ command: 'hooksState' });
		assert.equal(both.commit, true, 'pre-commit 视为提交钩子');
		assert.equal(both.push, true, 'pre-push 视为推送钩子');

		// core.hooksPath 指向别处时以它为准：该目录为空即两个都未激活。
		const elsewhere = mkdtempSync(join(tmpdir(), 'gg-hooks-'));
		execFileSync('git', ['config', 'core.hooksPath', elsewhere], { cwd: repo, encoding: 'utf8' });
		// 该取值由宿主缓存 60s，外部进程改配置不产生写事件；这里显式作废一次以读到新值。
		assert.equal((await call({ command: 'invalidateCache' })).error, null);
		const moved = await call({ command: 'hooksState' });
		assert.equal(moved.commit, false, 'core.hooksPath 决定钩子目录');
		assert.equal(moved.push, false);
		assert.equal(resolve(moved.directory), resolve(elsewhere));
		rmSync(elsewhere, { recursive: true, force: true });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('推送：上游分支名与本地不同名时按显式目标推送', async () => {
	const { repo, git } = makeRepo();
	const remote = mkdtempSync(join(tmpdir(), 'gg-push-target-'));
	try {
		execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
		git('remote', 'add', 'origin', remote);
		// 远程上先有 rename-me 分支，把本地 main 的上游指到它：上游分支名与本地不同名。
		git('push', '-q', 'origin', 'main:rename-me');
		git('fetch', '-q', 'origin');
		git('branch', '--set-upstream-to=origin/rename-me', 'main');
		git('config', 'branch.main.merge', 'refs/heads/rename-me');
		// 固定推送模式：不带目标的拒绝来自 simple，而开发机的全局 push.default 会改变这一结果。
		git('config', 'push.default', 'simple');

		const call = await makeCaller(repo);
		writeFileSync(join(repo, 'later.txt'), 'later\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'local commit');

		// 不带目标：push.default=simple 因两侧名字不同而拒绝。
		const rejected = await call({ command: 'pushUpstream' });
		assert.notEqual(rejected.error ?? null, null, '不同名时不带目标应被拒绝');

		// 带显式目标：推到上游实际绑定的那个远程分支。
		const pushed = await call({ command: 'pushUpstream', remote: 'origin', branch: 'rename-me' });
		assert.equal(pushed.error ?? null, null, '显式目标应推送成功');
		const remoteHead = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'rename-me'], { encoding: 'utf8' }).trim();
		const localHead = git('rev-parse', 'HEAD').trim();
		assert.equal(remoteHead, localHead, '远程分支应指到本地最新提交');
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('提交与推送：skipHooks 传 --no-verify，未传时照常运行钩子', async () => {
	const { repo, git } = makeRepo();
	const hooksDir = join(repo, '.git', 'hooks');
	try {
		const call = await makeCaller(repo);
		// 在钩子目录里放一个拒绝所有提交的 pre-commit：以此判定 --no-verify 是否生效。
		mkdirSync(hooksDir, { recursive: true });
		writeHook(hooksDir, 'pre-commit', '#!/bin/sh\necho blocked-by-hook >&2\nexit 1\n');

		writeFileSync(join(repo, 'hooked.txt'), 'content');
		git('add', '-A');

		// 不跳过：被钩子挡住。
		const blocked = await call({ command: 'commitStaged', message: 'should fail', amend: false });
		assert.match(String(blocked.error), /blocked-by-hook/, '钩子拒绝时提交失败并回投钩子输出');

		// 跳过：提交成功。
		const skipped = await call({ command: 'commitStaged', message: 'skip hooks', amend: false, skipHooks: true });
		assert.equal(skipped.error, null);
		assert.equal(typeof skipped.hash, 'string');

		// 推送侧的 --no-verify：用拒绝一切的 pre-push 验证同一个开关。
		const remote = mkdtempSync(join(tmpdir(), 'gg-hooks-remote-'));
		try {
			execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
			git('remote', 'add', 'origin', remote);
			git('push', '-q', '--set-upstream', 'origin', 'main');
			writeHook(hooksDir, 'pre-push', '#!/bin/sh\necho blocked-push >&2\nexit 1\n');

			const pushBlocked = await call({ command: 'pushUpstream' });
			assert.match(String(pushBlocked.error), /blocked-push/, '推送钩子拒绝时推送失败');

			const pushSkipped = await call({ command: 'pushUpstream', skipHooks: true });
			assert.equal(pushSkipped.error, null, 'skipHooks 时跳过 pre-push');
		} finally {
			rmSync(remote, { recursive: true, force: true });
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
