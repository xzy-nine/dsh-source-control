/**
 * 工作区快照命令 `loadWorkingTreeSnapshot` 的契约回归：经真实路由 handler 发请求，用临时仓库校验。
 *
 * 被测模块有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与临时仓库，串行便于定位失败 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');

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

/**
 * 作废宿主缓存后请求一次快照。
 *
 * 快照结果在宿主有短暂 TTL，测试里两次快照之间仓库已变化，必须先作废才能读到新状态。
 *
 * @param call - 发送命令的函数。
 * @returns 快照响应。
 */
async function freshSnapshot(call) {
	await call({ command: 'invalidateCache' });
	return snapshot(call);
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

test('贮藏契约：无贮藏时 loadRepoInfo 返回空列表且无错误', async () => {
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

test('贮藏契约：链接工作树按公共目录读到主仓库的贮藏', async () => {
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

test('首屏贮藏契约：loadCommits 带 withRepoInfo 时自带仓库信息与贮藏', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('a.txt', 'two\n');
		git('stash', 'push', '-q', '-m', 'wip');

		const call = await makeCaller(repo);
		const page = await call({ command: 'loadCommits', limit: 200, skip: 0, withRepoInfo: true, showStashes: true, showRemoteBranches: true, hideRemotes: [], remotes: [] });
		assert.equal(page.command, 'loadCommits');
		assert.equal(page.error, null);
		assert.equal(page.repoInfo.stashes.length, 1, '仓库信息批应带贮藏');
		assert.match(page.repoInfo.stashes[0].message, /wip/);
		assert.ok(page.commits.some((commit) => commit.hash !== '*' && commit.hash.length > 0), '首屏应含提交');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('刷新契约：不带 withRepoInfo 时响应 repoInfo 为 null，即使仓库有贮藏', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('a.txt', 'two\n');
		git('stash', 'push', '-q', '-m', 'wip');

		const call = await makeCaller(repo);
		/* skip 为 0 不再是「取仓库信息」的判据：刷新同样以 skip 0 请求。 */
		const page = await call({ command: 'loadCommits', limit: 200, skip: 0, showStashes: true, showRemoteBranches: true, hideRemotes: [], remotes: [] });
		assert.equal(page.error, null);
		assert.equal(page.repoInfo, null, '未要求仓库信息时不随响应取回');
		assert.ok(page.commits.length > 0, '提交图仍应正常返回');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('刷新契约：调用方给出远程与贮藏时提交图与首屏批逐条一致', async () => {
	const { repo, git, write } = makeRepo();
	const remote = mkdtempSync(join(tmpdir(), 'gg-snap-remote-'));
	try {
		execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		git('remote', 'add', 'origin', remote);
		git('push', '-q', '--set-upstream', 'origin', 'main');
		write('a.txt', 'two\n');
		git('stash', 'push', '-q', '-m', 'wip');

		const call = await makeCaller(repo);
		const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		const first = await call({
			command: 'loadCommits', limit: 200, skip: 0, withRepoInfo: true, showTags: true,
			showRemoteBranches: true, hideRemotes: [], remotes: [], stashes: info.stashes,
		});
		const refreshParams = {
			command: 'loadCommits', limit: 200, skip: 0, showTags: true, showRemoteBranches: true,
			hideRemotes: [], remotes: info.remotes, stashes: info.stashes,
		};
		const refresh = await call(refreshParams);
		const again = await call(refreshParams);

		assert.equal(first.repoInfo.stashes.length, 1);
		/*
		 * 远程标识参与缓存键：刷新带的是真实远程名，首屏带的是空列表，两者落到不同窗口，
		 * 因此本次刷新重新取数，结果仍应与首屏逐条一致。
		 */
		assert.deepEqual(refresh.commits, first.commits, '给出已知远程与贮藏时提交图应与首屏批逐条一致');
		assert.deepEqual(refresh.tags, first.tags);
		assert.equal(refresh.head, first.head);
		assert.ok(refresh.commits.some((commit) => commit.stash !== null && commit.stash !== undefined), '贮藏行应仍插入');
		const remoteMarked = refresh.commits.find((commit) => (commit.remotes ?? []).length > 0);
		assert.deepEqual(remoteMarked.remotes, [{ name: 'origin/main', remote: 'origin' }], '远程分支归属应来自调用方给出的远程名');

		/*
		 * 同一组参数再请求一次即命中宿主缓存：命中时仓库信息一并回投（同样来自宿主缓存），
		 * 客户端不必再补一次 `loadRepoInfo`。未命中缓存时该字段为 null。
		 */
		assert.ok(again.repoInfo !== null, '命中缓存时一并回投仓库信息');
		assert.deepEqual(again.repoInfo.stashes, first.repoInfo.stashes, '回投的贮藏与首屏一致');
		assert.deepEqual(again.repoInfo.remotes, first.repoInfo.remotes, '回投的远程与首屏一致');
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('首屏贮藏契约：调用方给出空贮藏列表时不插入贮藏行', async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('a.txt', 'two\n');
		git('stash', 'push', '-q', '-m', 'wip');

		const call = await makeCaller(repo);
		const page = await call({ command: 'loadCommits', limit: 200, skip: 0, withRepoInfo: true, stashes: [], showRemoteBranches: true, hideRemotes: [], remotes: [] });
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

test('远程名契约：只有 url 的远程', async () => {
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

test('远程名契约：只有 fetch 无 url 的远程', async () => {
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

test('远程名契约：有 url 与只有 fetch 的远程并存', async () => {
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
