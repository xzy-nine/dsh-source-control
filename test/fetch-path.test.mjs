/**
 * 取数路径契约：一次刷新起的 git 子进程数、只读命令的在途复用、钩子路径与远程名的缓存生效。
 *
 * 断言经真实路由 handler 发出（从 `lib/` 产物导入），并包裹 `child_process.spawn` 统计 git 子进程。
 * 每次测量前作废宿主缓存并空转一段，越过 `runGit` 的 200ms 结果缓存与 500ms 快照缓存。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');

/* 子进程计数：替换 spawn 并同步给 ESM 具名绑定。 */
const spawns = [];
const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
	spawns.push([command, ...(Array.isArray(args) ? args : [])].map(String));
	return originalSpawn(command, args, options);
};
syncBuiltinESMExports();

/** 临时目录登记表；文件级 after 统一删除。 */
const temps = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** 清空子进程记录。 */
function resetSpawns() {
	spawns.length = 0;
}

/**
 * 统计带某个子命令的 git 子进程数。
 *
 * @param subcommand - git 子命令，如 `status`。
 * @returns 次数。
 */
function countGit(subcommand) {
	return spawns.filter(([command, ...args]) => command === 'git' && args.includes(subcommand)).length;
}

/** 统计全部 git 子进程数。 */
function countAllGit() {
	return spawns.filter(([command]) => command === 'git').length;
}

/** 空转一段，越过宿主只读结果缓存与快照缓存的有效期。 */
const cooldown = () => new Promise((resolve) => setTimeout(resolve, 350));

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
	git('config', 'user.email', 'fetch@example.com');
	git('config', 'user.name', 'Fetch');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
	return { repo, git };
}

/**
 * 取一条经真实路由 handler 发请求的调用函数。
 *
 * @param repo - 仓库路径。
 * @returns 发请求的函数。
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
				try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
			},
		};
		Promise.resolve(handler(req, res)).catch(reject);
	});
}

/** 一次常规刷新：提交图（已知远程与贮藏）∥ 工作区快照。 */
const REFRESH = {
	command: 'loadCommits', branches: null, limit: 200, skip: 0, showTags: true, showRemoteBranches: true,
	includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
	withRepoInfo: false, remotes: [], stashes: [], hideRemotes: [],
};

test('常规刷新恰起 2 个 git 子进程', async () => {
	const { repo } = makeRepo('gg-fetch-refresh-');
	const call = await makeCaller(repo);
	// 先走一次首屏，使仓库信息与引用集合都已就绪。
	await call({ ...REFRESH, withRepoInfo: true });
	await cooldown();
	await call({ command: 'invalidateCache' });

	resetSpawns();
	const [page, snapshot] = await Promise.all([
		call(REFRESH),
		call({ command: 'loadWorkingTreeSnapshot' }),
	]);
	assert.equal(page.error, null);
	assert.equal(snapshot.error, null);
	assert.deepEqual(
		spawns.filter(([command, ...args]) => command === 'git' && (args.includes('log') || args.includes('status')))
			.map(([, ...args]) => args.find((arg) => arg === 'log' || arg === 'status')).sort(),
		['log', 'status'],
	);
	assert.equal(countAllGit(), 2, '刷新路径的 git 子进程数');
});

test('空信息仓库二次刷新不再起 config --list 与 remote', async () => {
	const { repo } = makeRepo('gg-fetch-empty-');
	const call = await makeCaller(repo);
	const first = await call({ ...REFRESH, withRepoInfo: true });
	assert.equal(first.error, null);
	assert.deepEqual(first.repoInfo.remotes, [], '仓库确实没有远程');
	assert.deepEqual(first.repoInfo.stashes, []);
	await cooldown();
	await call({ command: 'invalidateCache' });

	// 客户端记下空远程与空贮藏后，刷新按已知值回传，宿主不再取仓库信息。
	resetSpawns();
	const second = await call(REFRESH);
	assert.equal(second.error, null);
	assert.equal(second.repoInfo, null);
	assert.equal(countGit('config'), 0, '不再起 config');
	assert.equal(countGit('remote'), 0, '空远程列表不回退读远程名');
});

test('并发两次快照只起 1 个 status', async () => {
	const { repo } = makeRepo('gg-fetch-snapshot-');
	const call = await makeCaller(repo);
	await cooldown();
	await call({ command: 'invalidateCache' });

	resetSpawns();
	const [left, right] = await Promise.all([
		call({ command: 'loadWorkingTreeSnapshot' }),
		call({ command: 'loadWorkingTreeSnapshot' }),
	]);
	assert.deepEqual(left.entries, right.entries);
	assert.equal(countGit('status'), 1, '在途复用使并发快照共用同一个子进程');
});

test('并发两次写命令各起一个子进程', async () => {
	const { repo, git } = makeRepo('gg-fetch-write-');
	const call = await makeCaller(repo);
	const head = git('rev-parse', 'HEAD').trim();

	// 两个不同的标签：各写一个引用，互不抢同一把锁，因此能真正并发。
	resetSpawns();
	const results = await Promise.all([
		call({ command: 'addTag', tagName: 'one', commitHash: head, type: 0, message: '', force: false }),
		call({ command: 'addTag', tagName: 'two', commitHash: head, type: 0, message: '', force: false }),
	]);
	for (const result of results) assert.deepEqual(result.errors, [null]);
	assert.equal(countGit('tag'), 2, '写命令不参与在途复用');
});

test('hooksState 两次只起 1 个 git config', async () => {
	const { repo } = makeRepo('gg-fetch-hooks-');
	const call = await makeCaller(repo);
	await call({ command: 'invalidateCache' });

	resetSpawns();
	const first = await call({ command: 'hooksState' });
	const second = await call({ command: 'hooksState' });
	assert.equal(second.directory, first.directory);
	assert.equal(countGit('config'), 1, 'core.hooksPath 命中宿主缓存');
});

test('响应带回当前分支名，分离头指针时为 null', async () => {
	const { repo, git } = makeRepo('gg-fetch-branch-');
	const call = await makeCaller(repo);
	await call({ command: 'invalidateCache' });
	const attached = await call(REFRESH);
	assert.equal(attached.branch, 'main');
	assert.equal(attached.branch, git('symbolic-ref', '--short', 'HEAD').trim());
	assert.equal(attached.head, git('rev-parse', 'HEAD').trim());

	git('checkout', '-q', '--detach', 'HEAD');
	await call({ command: 'invalidateCache' });
	const detached = await call(REFRESH);
	assert.equal(detached.branch, null);
	assert.equal(detached.head, git('rev-parse', 'HEAD').trim(), '分离头指针时 head 是提交哈希');
});

test('仓库树批量取数的并发上限为 5', async () => {
	const { repo } = makeRepo('gg-fetch-sync-');
	const call = await makeCaller(repo);
	// 6 个仓库各一次 for-each-ref：不限流时 6 个同时在跑，限流后只到 5。
	const paths = Array.from({ length: 6 }, (_, index) => {
		const dir = mkdtempSync(join(tmpdir(), 'gg-fetch-target-' + index + '-'));
		temps.push(dir);
		execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
		return dir;
	});
	await call({ command: 'invalidateCache' });

	let running = 0;
	let peak = 0;
	const tracked = cp.spawn;
	cp.spawn = (command, args, options) => {
		const isRefs = command === 'git' && Array.isArray(args) && args.includes('for-each-ref');
		if (isRefs) { running += 1; peak = Math.max(peak, running); }
		const child = tracked(command, args, options);
		if (isRefs) child.once('close', () => { running -= 1; });
		return child;
	};
	syncBuiltinESMExports();
	try {
		const result = await call({ command: 'loadReposSync', repos: paths });
		assert.equal(result.results.length, 6, '每个仓库一条结果');
	} finally {
		cp.spawn = tracked;
		syncBuiltinESMExports();
	}
	assert.equal(peak, 5, '同时进行的仓库树取数恰为上限 5 个');
});
