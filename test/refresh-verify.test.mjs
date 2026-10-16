/**
 * 刷新验证：提交图与工作区读取的一致性、提交集合的独立推导，以及草稿的会话级绑定。
 *
 * 宿主侧经真实路由 handler 发请求（从 lib/ 产物导入）；草稿侧直连 src/ 的 TS 模块，
 * 在 Node 下用最小 sessionStorage 桩与 fetch 桩替代浏览器环境。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
const built = existsSync(routesPath);
const skip = built ? false : '未找到宿主产物 lib/src/source-control/routes.js';

/**
 * 提交图取数参数：与面板首屏一致。
 *
 * 不带 `stashes`：首屏由宿主自行枚举贮藏，客户端不再先取一次仓库信息。
 */
const COMMITS_MESSAGE = {
	command: 'loadCommits', branches: null, limit: 200, skip: 0, showTags: true, showRemoteBranches: true,
	includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
	remotes: [], hideRemotes: [],
};

/**
 * 删除临时目录，容忍 Windows 上的瞬时文件锁。
 *
 * 测试里的 git 子进程刚退出时目录可能仍被短暂占用，`rmSync` 会抛 EPERM。重试若干次即可，
 * 全部失败才抛错（真删除失败仍应暴露）。
 *
 * @param {string} dir - 待删除的目录。
 * @returns {void}
 */
function removeTemp(dir) {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === 4) throw error;
			// 同步等待：这是清理路径，不需要与测试的异步节奏配合。
			const until = Date.now() + 100 * (attempt + 1);
			while (Date.now() < until) { /* 自旋等待文件锁释放 */ }
		}
	}
}

/** 建一个已配置身份的临时仓库。 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-refresh-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const write = (name, text) => writeFileSync(join(repo, name), text);
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'refresh@example.com');
	git('config', 'user.name', 'Refresh');
	return { repo, git, write };
}

/** 取一条经真实路由 handler 发请求的调用函数。 */
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

/** 条目按契约四字段归一，便于逐条对照。 */
function normalize(entries) {
	return entries.map((entry) => ({
		path: entry.path,
		origPath: entry.origPath ?? null,
		index: entry.index,
		worktree: entry.worktree,
	}));
}

/** 独立推导：按与命令相同的起点与排序取提交哈希列表。 */
function deriveLogHashes(git, extraRefs = []) {
	return git('log', '--topo-order', '--max-count=200', '--format=%H', '--branches', '--tags', '--remotes', ...extraRefs, 'HEAD', '--')
		.split('\n').filter((line) => line !== '');
}

/** 取 git 侧的一行式列表。 */
function gitLines(git, args) {
	return git(...args).split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

test('快照条目与 loadWorkingTree 条目逐条一致', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	try {
		write('a.txt', 'one\n');
		write('中文旧.md', 'cn\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');
		write('a.txt', 'two\n');
		git('add', 'a.txt');
		write('中文旧.md', 'cn2\n');
		git('mv', '中文旧.md', '中文新.md');
		write('untracked.txt', 'u\n');

		const call = await makeCaller(repo);
		const snapshot = await call({ command: 'loadWorkingTreeSnapshot' });
		const working = await call({ command: 'loadWorkingTree' });
		assert.equal(snapshot.error, null);
		assert.equal(working.error, null);
		assert.deepEqual(normalize(snapshot.entries), normalize(working.entries));
		assert.ok(snapshot.entries.length >= 3, '应含暂存、重命名与未跟踪改动');
	} finally {
		removeTemp(repo);
	}
});

test('提交集合与顺序由 git log 独立推导，标记与伪提交符合契约', { skip }, async () => {
	const { repo, git, write } = makeRepo();
	const remote = mkdtempSync(join(tmpdir(), 'gg-refresh-remote-'));
	try {
		write('a.txt', 'one\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'c1');
		git('tag', '-a', 'v1', '-m', 'release one');
		git('tag', 'light');

		write('a.txt', 'two\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'c2');
		git('branch', 'feature');

		git('mv', 'a.txt', 'renamed.txt');
		git('commit', '-q', '-m', 'c3 rename');

		write('renamed.txt', 'three\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'c4');

		write('中文.md', 'cn\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'c5 chinese');

		execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
		git('remote', 'add', 'origin', remote);
		git('push', '-q', '--set-upstream', 'origin', 'main');

		write('renamed.txt', 'stash change\n');
		write('untracked.txt', 'u\n');
		git('stash', 'push', '-u', '-m', 'wip');
		write('renamed.txt', 'modified\n');

		const call = await makeCaller(repo);
		const data = await call(COMMITS_MESSAGE);
		assert.equal(data.error, null);
		const commits = data.commits;
		const head = git('rev-parse', 'HEAD').trim();
		assert.equal(data.head, head);

		// 1) 伪提交在最前，父提交为 HEAD。
		assert.equal(commits[0].hash, '*');
		assert.deepEqual(commits[0].parents, [head]);

		// 2) 去掉伪提交与贮藏提交后，提交集合与顺序与 git log 一致。
		const stashHash = git('rev-parse', 'refs/stash').trim();
		const stashBase = git('rev-parse', 'refs/stash^').trim();
		const expectedLog = deriveLogHashes(git, [stashBase]);
		const actualLog = commits.filter((commit) => commit.hash !== '*' && commit.stash === null).map((commit) => commit.hash);
		assert.deepEqual(actualLog, expectedLog);

		// 3) 贮藏插入在其基提交之前，且带贮藏标记。
		const stashNode = commits.find((commit) => commit.hash === stashHash);
		assert.ok(stashNode !== undefined, '贮藏提交应出现在图中');
		assert.ok(stashNode.stash !== null && stashNode.stash !== undefined);
		assert.equal(commits.findIndex((commit) => commit.hash === stashHash) + 1, commits.findIndex((commit) => commit.hash === stashBase));

		// 4) 标记集合与 git 自身枚举一致。
		const localBranches = gitLines(git, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
		const markedHeads = [...new Set(commits.flatMap((commit) => commit.heads ?? []))].sort();
		assert.deepEqual(markedHeads, [...localBranches].sort());
		assert.equal(data.tags.length > 0, true);
		assert.deepEqual([...data.tags].sort(), gitLines(git, ['for-each-ref', '--format=%(refname:short)', 'refs/tags']).sort());
		const tagNames = [...new Set(commits.flatMap((commit) => (commit.tags ?? []).map((tag) => tag.name)))].sort();
		assert.deepEqual(tagNames, gitLines(git, ['for-each-ref', '--format=%(refname:short)', 'refs/tags']).sort());
		const remoteRefs = gitLines(git, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']).filter((name) => !name.endsWith('/HEAD'));
		const markedRemotes = [...new Set(commits.flatMap((commit) => (commit.remotes ?? []).map((remoteRef) => remoteRef.name)))].sort();
		assert.deepEqual(markedRemotes, remoteRefs.sort());
		const headNode = commits.find((commit) => commit.hash === head);
		assert.deepEqual(headNode.remotes, [{ name: 'origin/main', remote: 'origin' }]);
		assert.equal(data.moreCommitsAvailable, false);
	} finally {
		removeTemp(repo);
		removeTemp(remote);
	}
});

test('无提交的仓库：提交图为空且无伪提交', { skip }, async () => {
	const { repo } = makeRepo();
	try {
		const call = await makeCaller(repo);
		const data = await call(COMMITS_MESSAGE);
		assert.equal(data.commits.length, 0);
		assert.equal(data.head, null);
		assert.equal(data.error, null);
	} finally {
		removeTemp(repo);
	}
});

/* --- 未提交伪提交行的本地修正 --- */

test('伪提交行：条目数变化时就地改写文案，条目清空时去掉该行', async () => {
	const { withUncommittedCount } = await import(pathToFileURL(join(root, 'src', 'client', 'panel', 'commit-diff.ts')).href);
	const head = { hash: 'h1', parents: [], message: 'head commit' };
	const uncommitted = (count) => ({ hash: '*', parents: ['h1'], message: `Uncommitted Changes (${count})` });

	// 条目数未变：保持原引用。
	const stable = [uncommitted(2), head];
	assert.equal(withUncommittedCount(stable, 2), stable, '条目数未变时不应新建数组');

	// 条目数变化：只改文案，其余字段与顺序不动。
	const changed = withUncommittedCount([uncommitted(2), head], 3);
	assert.equal(changed[0].message, 'Uncommitted Changes (3)');
	assert.deepEqual(changed[0].parents, ['h1']);
	assert.equal(changed[1], head, '其余行应保持原引用');
	assert.notEqual(changed, stable);

	// 条目清空：伪提交行不再适用。
	const cleared = withUncommittedCount([uncommitted(2), head], 0);
	assert.deepEqual(cleared, [head]);

	// 列表首行不是伪提交时不改动。
	const withoutRow = [head];
	assert.equal(withUncommittedCount(withoutRow, 5), withoutRow);
	assert.equal(withUncommittedCount([], 5).length, 0);
});

/* --- 草稿：会话级绑定 --- */
/** 最小 sessionStorage 桩。 */
function makeSessionStorage() {
	const map = new Map();
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => { map.set(key, String(value)); },
		removeItem: (key) => { map.delete(key); },
		clear: () => { map.clear(); },
		key: (index) => [...map.keys()][index] ?? null,
		get length() { return map.size; },
		keys: () => [...map.keys()],
	};
}

/**
 * 安装 sessionStorage 桩并加载存储模块。
 *
 * @returns 存储模块、状态模块、桩与会话存储快照函数。
 */
let moduleGeneration = 0;

async function loadDraftModules() {
	moduleGeneration += 1;
	const sessionStorage = makeSessionStorage();
	globalThis.sessionStorage = sessionStorage;
	// 带查询串导入：每次取独立模块实例，避免模块缓存让上一次的桩继续生效。
	const storage = await import(pathToFileURL(join(root, 'src', 'client', 'panel', 'storage.ts')).href + '?v=' + moduleGeneration);
	const state = await import(pathToFileURL(join(root, 'src', 'client', 'api', 'state.ts')).href + '?v=' + moduleGeneration);
	return { storage, state, sessionStorage };
}

/**
 * 安装 fetch 桩：按命令返回成功响应并记录请求。
 *
 * @param hostEntries - 宿主 entries 的可变镜像。
 * @returns 请求记录与还原函数。
 */
function installFetchStub(hostEntries) {
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push(body);
		let payload = { command: body.command, repo: body.repo, error: null };
		if (body.command === 'readState') payload = { ...payload, entries: { ...hostEntries } };
		if (body.command === 'writeState') {
			if (body.value === null || body.value === undefined) delete hostEntries[body.key];
			else hostEntries[body.key] = body.value;
		}
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify(payload),
		};
	};
	return { calls, restore: () => { globalThis.fetch = original; } };
}

test('草稿按仓库根绑定：同一工作区两个仓库各写各的', async () => {
	const { storage, sessionStorage } = await loadDraftModules();
	const cwd = join(tmpdir(), 'gg-refresh-workspace');
	const repoA = join(cwd, 'repo-a');
	const repoB = join(cwd, 'repo-b');

	const keyA = storage.draftKeyOf(repoA);
	const keyB = storage.draftKeyOf(repoB);
	assert.notEqual(keyA, keyB);
	assert.equal(keyA, 'ggg-commit-msg:' + repoA);
	assert.equal(keyB, 'ggg-commit-msg:' + repoB);
	assert.ok(sessionStorage.keys().includes(keyA) === false, '写入前不应存在草稿键');

	storage.saveSessionValue(keyA, 'draft-A');
	storage.saveSessionValue(keyB, 'draft-B');
	assert.equal(storage.loadSessionValue(keyA, ''), 'draft-A');
	assert.equal(storage.loadSessionValue(keyB, ''), 'draft-B');
	assert.equal(storage.loadSessionValue(storage.draftKeyOf(join(cwd, 'repo-c')), 'none'), 'none');

	// 改 B 不影响 A。
	storage.saveSessionValue(keyB, 'draft-B2');
	assert.equal(storage.loadSessionValue(keyA, ''), 'draft-A');
	assert.equal(storage.loadSessionValue(keyB, ''), 'draft-B2');

	// 置空删除后回退值生效。
	storage.saveSessionValue(keyB, null);
	assert.equal(storage.loadSessionValue(keyB, 'none'), 'none');
	assert.equal(storage.loadSessionValue(keyA, ''), 'draft-A');
});

test('切换仓库：上一个仓库的草稿写回它自己的键', async () => {
	const { storage } = await loadDraftModules();
	const cwd = join(tmpdir(), 'gg-refresh-switch');
	const repoA = join(cwd, 'repo-a');
	const repoB = join(cwd, 'repo-b');
	const keyA = storage.draftKeyOf(repoA);
	const keyB = storage.draftKeyOf(repoB);

	// 在 A 编辑并写回，随后切到 B。
	storage.saveSessionValue(keyA, 'A-edit-1');
	const loadedForB = storage.loadSessionValue(keyB, '');
	assert.equal(loadedForB, '', 'B 的键不应读到 A 的草稿');

	// 切回 A 时写回仍落在 A 的键上。
	storage.saveSessionValue(keyA, 'A-edit-2');
	storage.saveSessionValue(keyB, 'B-edit-1');
	assert.equal(storage.loadSessionValue(keyA, ''), 'A-edit-2');
	assert.equal(storage.loadSessionValue(keyB, ''), 'B-edit-1');

	// 清 A 的键不影响 B。
	storage.clearSessionValue(keyA);
	assert.equal(storage.loadSessionValue(keyA, 'none'), 'none');
	assert.equal(storage.loadSessionValue(keyB, ''), 'B-edit-1');
});

test('草稿不落宿主：宿主 entries 不出现 ggg-commit-msg:* 新写入', async () => {
	const { storage, state } = await loadDraftModules();
	const cwd = join(tmpdir(), 'gg-refresh-host');
	const repoA = join(cwd, 'repo-a');
	const keyA = storage.draftKeyOf(repoA);

	const hostEntries = {};
	const fetchStub = installFetchStub(hostEntries);
	try {
		storage.saveSessionValue(keyA, 'session-only');
		assert.equal(fetchStub.calls.length, 0, '写草稿不应发起宿主请求');
		assert.equal(hostEntries[keyA], undefined);

		// 宿主里遗留的旧草稿可被取回一次，并在宿主侧删除。
		hostEntries[keyA] = 'persisted';
		const first = await state.takePersistedDraft(cwd, keyA);
		assert.equal(first, 'persisted');
		const writeCall = fetchStub.calls.find((call) => call.command === 'writeState' && call.key === keyA);
		assert.ok(writeCall !== undefined, '取回后应写一次删除');
		assert.equal(writeCall.value, null);
		assert.equal(hostEntries[keyA], undefined, '取回后宿主键应被删除');
		const second = await state.takePersistedDraft(cwd, keyA);
		assert.equal(second, null);
	} finally {
		fetchStub.restore();
	}
});
