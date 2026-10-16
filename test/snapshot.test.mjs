/**
 * 工作区快照命令 `loadWorkingTreeSnapshot` 的契约回归：经真实路由 handler 发请求，用临时仓库校验。
 *
 * 被测模块有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
const built = existsSync(routesPath);
const skip = built ? false : '未找到宿主产物 lib/src/source-control/routes.js';

/**
 * 建一个已配置身份的临时仓库。
 *
 * @returns 仓库路径与 git / 写文件辅助函数。
 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-snap-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const write = (name, content) => writeFileSync(join(repo, name), content);
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'snap@example.com');
	git('config', 'user.name', 'Snap');
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

/** 请求一次工作区快照。 */
async function snapshot(call) {
	return call({ command: 'loadWorkingTreeSnapshot' });
}

/** 条目按契约四字段归一，用于逐条对照。 */
function normalize(entries) {
	return entries.map((entry) => ({
		path: entry.path,
		origPath: entry.origPath ?? null,
		index: entry.index,
		worktree: entry.worktree,
	}));
}

/**
 * 同时请求快照命令与既有工作区命令，并断言两条独立实现的 entries 逐条全等（含顺序）。
 *
 * @param call - 经真实路由 handler 发请求的函数。
 * @returns 快照响应与工作区响应。
 */
async function snapshotWithWorkingTree(call) {
	const snap = await call({ command: 'loadWorkingTreeSnapshot' });
	const working = await call({ command: 'loadWorkingTree' });
	assert.deepEqual(
		normalize(snap.entries),
		normalize(working.entries),
		'快照条目应与 loadWorkingTree 条目逐条全等（含顺序）',
	);
	return { snap, working };
}

test('干净仓库：entries 为空且无上游', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');

		const { snap } = await snapshotWithWorkingTree(await makeCaller(repo));
		assert.equal(snap.command, 'loadWorkingTreeSnapshot');
		assert.equal(String(snap.repo).replace(/\\/g, '/'), repo.replace(/\\/g, '/'));
		assert.equal(snap.error, null);
		assert.deepEqual(snap.entries, []);
		assert.equal(snap.branch, 'main');
		assert.equal(snap.upstream, null);
		assert.equal(snap.ahead, 0);
		assert.equal(snap.behind, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('工作区快照：未跟踪、已修改、已暂存、重命名（含中文路径）与排序', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		write('mod.txt', 'm\n');
		write('中文原.md', 'cn\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');

		write('a.txt', 'one2\n');
		git('add', 'a.txt');
		write('mod.txt', 'm2\n');
		write('staged.txt', 's\n');
		git('add', 'staged.txt');
		git('mv', '中文原.md', '中文新.md');
		write('untracked.txt', 'u\n');

		const { snap } = await snapshotWithWorkingTree(await makeCaller(repo));
		assert.equal(snap.error, null);
		assert.equal(snap.entries.length, 5);

		const paths = snap.entries.map((entry) => entry.path);
		assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right)), 'entries 应按 path 升序');
		for (const entry of snap.entries) {
			assert.equal(typeof entry.path, 'string');
			assert.equal(typeof entry.index, 'string');
			assert.equal(typeof entry.worktree, 'string');
			assert.equal(entry.index.length, 1, 'index 应为单个状态码');
			assert.equal(entry.worktree.length, 1, 'worktree 应为单个状态码');
		}

		const byPath = new Map(snap.entries.map((entry) => [entry.path, entry]));

		const staged = byPath.get('a.txt');
		assert.equal(staged.index, 'M');
		assert.equal(staged.worktree, ' ');
		assert.equal(staged.origPath, null);

		const modified = byPath.get('mod.txt');
		assert.equal(modified.index, ' ');
		assert.equal(modified.worktree, 'M');
		assert.equal(modified.origPath, null);

		const added = byPath.get('staged.txt');
		assert.equal(added.index, 'A');
		assert.equal(added.worktree, ' ');
		assert.equal(added.origPath, null);

		const untracked = byPath.get('untracked.txt');
		assert.equal(untracked.index, '?');
		assert.equal(untracked.worktree, '?');
		assert.equal(untracked.origPath, null);

		const renamed = byPath.get('中文新.md');
		assert.equal(renamed.index, 'R');
		assert.equal(renamed.worktree, ' ');
		assert.equal(renamed.origPath, '中文原.md');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('分离头指针：branch 为 null', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		git('checkout', '-q', '--detach');
		assert.equal(git('branch', '--show-current').trim(), '');

		const { snap } = await snapshotWithWorkingTree(await makeCaller(repo));
		assert.equal(snap.error, null);
		assert.equal(snap.branch, null);
		assert.equal(snap.upstream, null);
		assert.equal(snap.ahead, 0);
		assert.equal(snap.behind, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('无上游：已配置远程但分支未跟踪时 upstream 为 null、ahead/behind 为 0', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	const remote = mkdtempSync(join(tmpdir(), 'gg-snap-untracked-'));
	try {
		execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		git('remote', 'add', 'origin', remote);
		git('fetch', '-q', 'origin');

		const { snap } = await snapshotWithWorkingTree(await makeCaller(repo));
		assert.equal(snap.error, null);
		assert.equal(snap.branch, 'main');
		assert.equal(snap.upstream, null);
		assert.equal(snap.ahead, 0);
		assert.equal(snap.behind, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('有上游：领先 1 落后 0', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	const remote = mkdtempSync(join(tmpdir(), 'gg-snap-ahead-'));
	try {
		execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		git('remote', 'add', 'origin', remote);
		git('push', '-q', '--set-upstream', 'origin', 'main');

		write('a.txt', 'one\ntwo\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'second');

		const { snap } = await snapshotWithWorkingTree(await makeCaller(repo));
		assert.equal(snap.error, null);
		assert.equal(snap.branch, 'main');
		assert.equal(snap.upstream, 'origin/main');
		assert.equal(snap.ahead, 1);
		assert.equal(snap.behind, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('上游引用被删除但 branch.<name>.remote 仍在：upstream 为 null、ahead/behind 为 0', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	const remote = mkdtempSync(join(tmpdir(), 'gg-snap-gone-'));
	try {
		execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		git('remote', 'add', 'origin', remote);
		git('push', '-q', '--set-upstream', 'origin', 'main');
		git('update-ref', '-d', 'refs/remotes/origin/main');

		assert.equal(git('config', 'branch.main.remote').trim(), 'origin');
		assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/remotes/origin/main').trim(), '');

		const { snap } = await snapshotWithWorkingTree(await makeCaller(repo));
		assert.equal(snap.error, null);
		assert.equal(snap.branch, 'main');
		assert.equal(snap.upstream, null);
		assert.equal(snap.ahead, 0);
		assert.equal(snap.behind, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('对照：复杂工作区下快照条目与 loadWorkingTree 条目一致', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('keep.txt', 'keep\n');
		write('mod.txt', 'm\n');
		write('del.txt', 'd\n');
		write('中文旧.md', 'cn\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');

		write('mod.txt', 'm2\n');
		git('add', 'mod.txt');
		write('mod.txt', 'm3\n');
		git('rm', '-q', 'del.txt');
		git('mv', '中文旧.md', '中文新.md');
		write('keep.txt', 'keep2\n');
		write('untracked.txt', 'u\n');

		const { snap, working } = await snapshotWithWorkingTree(await makeCaller(repo));
		assert.equal(snap.error, null);
		assert.equal(working.error, null);
		assert.ok(snap.entries.length > 0, '复杂工作区应有条目');

		const byPath = new Map(normalize(snap.entries).map((entry) => [entry.path, entry]));
		assert.equal(byPath.get('mod.txt').index, 'M');
		assert.equal(byPath.get('mod.txt').worktree, 'M');
		assert.equal(byPath.get('del.txt').index, 'D');
		assert.equal(byPath.get('keep.txt').worktree, 'M');
		assert.equal(byPath.get('中文新.md').index, 'R');
		assert.equal(byPath.get('中文新.md').origPath, '中文旧.md');
		assert.equal(byPath.get('untracked.txt').index, '?');
		assert.equal(byPath.get('untracked.txt').worktree, '?');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('非仓库：error 为字符串且其余字段为空值', { skip }, async () => {
	const absent = join(tmpdir(), `gg-snap-absent-${Date.now()}`);
	const snap = await snapshot(await makeCaller(absent));
	assert.equal(snap.command, 'loadWorkingTreeSnapshot');
	assert.equal(typeof snap.error, 'string');
	assert.ok(snap.error.length > 0, '非仓库应给出错误文本');
	assert.equal(snap.branch, null);
	assert.equal(snap.upstream, null);
	assert.equal(snap.ahead, 0);
	assert.equal(snap.behind, 0);
	assert.equal((snap.entries ?? []).length, 0, '失败时 entries 应为空');
});

test('贮藏契约：无贮藏时 loadRepoInfo 返回空列表且无错误', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');

		const call = await makeCaller(repo);
		const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		assert.equal(info.command, 'loadRepoInfo');
		assert.equal(info.error, null);
		assert.deepEqual(info.stashes, []);
		assert.equal(info.isRepo, true);
		assert.equal(info.head, 'main');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('贮藏契约：链接工作树按公共目录读到主仓库的贮藏', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	const worktree = mkdtempSync(join(tmpdir(), 'gg-snap-wt-'));
	rmSync(worktree, { recursive: true, force: true });
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('a.txt', 'two\n');
		git('stash', 'push', '-q', '-m', 'wip');

		git('worktree', 'add', '-q', worktree, '-b', 'side');
		const call = await makeCaller(worktree);
		const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		assert.equal(info.error, null);
		assert.equal(info.stashes.length, 1, '链接工作树应读到主仓库的贮藏');
		assert.match(info.stashes[0].message, /wip/);
	} finally {
		rmSync(worktree, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test('首屏贮藏契约：loadCommits 首屏自带仓库信息与贮藏', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('a.txt', 'two\n');
		git('stash', 'push', '-q', '-m', 'wip');

		const call = await makeCaller(repo);
		const page = await call({ command: 'loadCommits', limit: 200, skip: 0, showStashes: true, showRemoteBranches: true, hideRemotes: [], remotes: [] });
		assert.equal(page.command, 'loadCommits');
		assert.equal(page.error, null);
		assert.equal(page.repoInfo.stashes.length, 1, '首屏仓库信息应带贮藏');
		assert.match(page.repoInfo.stashes[0].message, /wip/);
		assert.ok(page.commits.some((commit) => commit.hash !== '*' && commit.hash.length > 0), '首屏应含提交');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('首屏贮藏契约：调用方给出空贮藏列表时不插入贮藏行', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('a.txt', 'two\n');
		git('stash', 'push', '-q', '-m', 'wip');

		const call = await makeCaller(repo);
		const page = await call({ command: 'loadCommits', limit: 200, skip: 0, stashes: [], showRemoteBranches: true, hideRemotes: [], remotes: [] });
		assert.equal(page.error, null);
		assert.equal(page.repoInfo.stashes.length, 1, '仓库信息仍按 showStashes 读取贮藏');
		const stashRows = page.commits.filter((commit) => commit.stash !== null && commit.stash !== undefined);
		assert.equal(stashRows.length, 0, '调用方给出空列表时提交图不插入贮藏行');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

/**
 * 在 `.git/config` 追加一条只有 fetch、没有 url 的远程。
 *
 * @param repo - 仓库路径。
 * @param name - 远程名。
 * @returns 无。
 */
function addFetchOnlyRemote(repo, name) {
	appendFileSync(join(repo, '.git', 'config'), `[remote "${name}"]\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n`);
}

/**
 * 断言 `loadRepoInfo` 给出的远程名集合与 `git remote` 逐项一致。
 *
 * @param call - 经真实路由 handler 发请求的函数。
 * @param git - 临时仓库的 git 辅助函数。
 * @returns 远程名数组（已按升序）。
 */
async function assertRemoteNames(call, git) {
	const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: false, hideRemotes: [] });
	assert.equal(info.error, null);
	const fromGit = git('remote').split('\n').map((line) => line.trim()).filter((line) => line !== '');
	const names = info.remotes.map((remote) => remote.name);
	assert.deepEqual([...names].sort(), [...fromGit].sort(), '远程名集合应与 git remote 逐项一致');
	assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right)), '远程名应按 name 升序');
	for (const remote of info.remotes) {
		assert.equal(typeof remote.name, 'string');
		assert.ok(remote.url === null || typeof remote.url === 'string');
		assert.ok(remote.pushUrl === null || typeof remote.pushUrl === 'string');
	}
	return names;
}

test('远程名契约：只有 url 的远程', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		git('remote', 'add', 'origin', 'https://example.com/o.git');

		const names = await assertRemoteNames(await makeCaller(repo), git);
		assert.deepEqual(names, ['origin']);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('远程名契约：只有 fetch 无 url 的远程', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		addFetchOnlyRemote(repo, 'beta');

		const call = await makeCaller(repo);
		const names = await assertRemoteNames(call, git);
		assert.deepEqual(names, ['beta']);
		const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: false, hideRemotes: [] });
		assert.equal(info.remotes[0].url, null, '无 url 的远程 url 为 null');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('远程名契约：有 url 与只有 fetch 的远程并存', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		git('remote', 'add', 'origin', 'https://example.com/o.git');
		addFetchOnlyRemote(repo, 'beta');

		const names = await assertRemoteNames(await makeCaller(repo), git);
		assert.deepEqual(names, ['beta', 'origin'], '有 url 的远程不应挤掉只有 fetch 的远程');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
