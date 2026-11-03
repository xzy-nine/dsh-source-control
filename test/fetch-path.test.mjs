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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 本文件的用例必须串行执行：用例靠真实时钟越过缓存 TTL，且计数子进程数 */

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

/** 临时目录登记表；文件级 after 统一删除并还原 spawn 桩。 */
const temps = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	// 还原模块级 spawn 桩，避免同进程后续用例看到本文件的计数包装。
	cp.spawn = originalSpawn;
	syncBuiltinESMExports();
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

test('耗时汇总的 git 子进程数与实际 spawn 一致', async () => {
	const { repo } = makeRepo('gg-fetch-perf-');
	const call = await makeCaller(repo);
	await cooldown();
	await call({ command: 'invalidateCache' });

	// 一次只有一条命令的刷新：旧实现在「首条命令完成后」才取基线，差值为零，会记成 0 个。
	resetSpawns();
	await call({ command: 'loadWorkingTreeSnapshot', refreshId: 987654321 });
	const spawned = countAllGit();
	assert.ok(spawned >= 1, '这次调用确实起了子进程');

	/*
	 * 汇总是异步冲刷（空闲 3 秒后写出）：先 flush 日志模块，让缓冲落盘，再读这一轮的 perf 行。
	 * 日志根由 test/setup.mjs 隔离到临时目录，因此这里读的是本次测试自己的文件。
	 */
	const { flushSync, currentLogFile } = await import(pathToFileURL(join(root, 'lib', 'src', 'source-control', 'logger.js')).href);
	await new Promise((resolve) => setTimeout(resolve, 3300));
	flushSync();
	const logFile = currentLogFile();
	assert.ok(typeof logFile === 'string' && logFile !== '', '日志文件应已创建');
	const line = readFileSync(logFile, 'utf8').split('\n').find((entry) => entry.includes('第 987654321 轮刷新'));
	assert.ok(line !== undefined, '应写出该轮的耗时汇总行');
	const reported = Number(/git 子进程 (\d+) 个/.exec(line)?.[1]);
	assert.equal(reported, spawned, '汇总里的子进程数应与实际 spawn 数一致');
});

test('并发两轮各自只记自己的子进程', async () => {
	const { repo } = makeRepo('gg-fetch-perf-concurrent-');
	const call = await makeCaller(repo);
	await cooldown();
	await call({ command: 'invalidateCache' });

	/*
	 * 两轮同时发出、都要真起子进程：按仓库取计数器再算差值时，后收尾的一轮会把先收尾那一轮的
	 * 子进程也计入自己的差值，汇总因此偏大。
	 */
	resetSpawns();
	await Promise.all([
		call({ command: 'loadWorkingTreeSnapshot', refreshId: 111222333 }),
		call({ command: 'loadWorkingTreeSnapshot', refreshId: 111222334, noCache: true }),
	]);
	const spawned = countAllGit();
	assert.ok(spawned >= 1, '两轮确实起了子进程');

	const { flushSync, currentLogFile } = await import(pathToFileURL(join(root, 'lib', 'src', 'source-control', 'logger.js')).href);
	await new Promise((resolve) => setTimeout(resolve, 3300));
	flushSync();
	const lines = readFileSync(currentLogFile(), 'utf8').split('\n');
	const reported = ['111222333', '111222334'].map((id) => {
		const entry = lines.find((line) => line.includes(`第 ${id} 轮刷新`));
		assert.ok(entry !== undefined, `应写出第 ${id} 轮的汇总行`);
		return Number(/git 子进程 (\d+) 个/.exec(entry)?.[1]);
	});
	assert.equal(reported.reduce((sum, value) => sum + value, 0), spawned, '两轮之和应等于实际 spawn 数');
});

test('仅索引写之后提交图窗口仍然命中', async () => {
	const { repo } = makeRepo('gg-fetch-index-');
	const call = await makeCaller(repo);
	await call({ ...REFRESH, withRepoInfo: true });
	await cooldown();

	// 先取一次窗口页面把它写进缓存，再做一次只改索引的 `git add`。
	await call(REFRESH);
	await cooldown();
	await call({ command: 'stagePaths', paths: [] });

	resetSpawns();
	const afterWrite = await call(REFRESH);
	assert.equal(afterWrite.error, null);
	assert.ok(Array.isArray(afterWrite.commits) && afterWrite.commits.length > 0, '仍返回完整窗口');
	assert.equal(countGit('log'), 0, '索引类写不改变引用，提交图窗口应命中缓存');

	// 工作区快照仍必须重取：条目与暂存状态确实变了。
	const snapshot = await call({ command: 'loadWorkingTreeSnapshot' });
	assert.equal(snapshot.error, null);
	assert.equal(countGit('status'), 1, '索引类写作废快照，下一次读取重跑一次 status');
});
