/**
 * 子模块数据隔离：未检出的子模块与父仓库之间不得互相串数据。
 *
 * 症状是「子模块行显示父仓库的分支」「选中子模块时图形区显示父仓库的提交」。根因是 git 从子模块
 * 目录向上找到父仓库：未检出的子模块目录里没有 `.git`，任何以它为工作目录的命令都会命中父仓库。
 * 因此判据一律是「该路径自身是不是仓库根」，而不是「向上能不能找到仓库」。
 *
 * 被测模块有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入；
 * `pretest` 会先重建产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempPath } from './harness.mjs';

/* 本文件的用例必须串行执行：每个用例起真实 git 子进程与临时仓库，串行便于定位失败 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const libPath = (relative) => pathToFileURL(join(root, 'lib', 'src', 'source-control', relative)).href;

/** 临时目录登记表；文件级 after 统一删除。 */
const temps = [];
test.after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

/**
 * 建一个临时目录并登记清理。
 *
 * @param prefix - 目录名前缀。
 * @returns 目录绝对路径。
 */
function makeTemp(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

/**
 * 在指定目录执行一次 git。
 *
 * @param cwd - 工作目录。
 * @param args - git 参数。
 * @returns 标准输出。
 */
function gitIn(cwd, ...args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * 建一个带提交的父仓库，并在其中登记一个子模块后删掉其工作区目录。
 *
 * @returns 父仓库路径与子模块路径。
 */
function makeUninitializedSubmodule() {
	const parent = makeTemp('gg-sub-iso-parent-');
	gitIn(parent, 'init', '-q', '-b', 'main');
	gitIn(parent, 'config', 'user.email', 'parent@example.com');
	gitIn(parent, 'config', 'user.name', 'Parent');
	writeFileSync(join(parent, 'a.txt'), 'a\n');
	gitIn(parent, 'add', '-A');
	gitIn(parent, 'commit', '-q', '-m', 'parent base');

	const source = makeTemp('gg-sub-iso-src-');
	gitIn(source, 'init', '-q', '-b', 'trunk');
	gitIn(source, 'config', 'user.email', 'sub@example.com');
	gitIn(source, 'config', 'user.name', 'Sub');
	writeFileSync(join(source, 's.txt'), 's\n');
	gitIn(source, 'add', '-A');
	gitIn(source, 'commit', '-q', '-m', 'sub base');
	const bare = makeTemp('gg-sub-iso-bare-');
	gitIn(tmpdir(), 'clone', '-q', '--bare', source, bare);

	gitIn(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', bare, 'lib/dep');
	gitIn(parent, 'commit', '-q', '-m', 'add submodule');
	const sub = join(parent, 'lib', 'dep');
	// 模拟未检出：工作区目录不存在，登记项仍在索引与 .gitmodules 里。
	rmSync(sub, { recursive: true, force: true });
	mkdirSync(join(parent, 'lib'), { recursive: true });
	return { parent, sub };
}

test('isRepoRoot：只认路径自身，未检出的子模块目录不是仓库根', async () => {
	const { isRepoRoot } = await import(libPath('worktree-branches.js'));
	const { parent, sub } = makeUninitializedSubmodule();
	assert.equal(await isRepoRoot(parent), true, '父仓库是仓库根');
	assert.equal(await isRepoRoot(sub), false, '未检出的子模块目录自身没有 .git');
	assert.equal(await isRepoRoot(join(parent, 'lib')), false, '父仓库的子目录不是仓库根');

	// 检出后该目录自己成为仓库根。
	gitIn(parent, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
	assert.equal(await isRepoRoot(sub), true, '检出后子模块目录自身是仓库根');
});

test('loadRepoSync：未检出的子模块不借用父仓库的分支', async () => {
	const { loadRepoSync, loadReposSync } = await import(libPath('repo-sync.js'));
	const { parent, sub } = makeUninitializedSubmodule();

	const parentSync = await loadRepoSync(parent);
	assert.equal(parentSync.branch, 'main', '父仓库读自己的分支');

	const subSync = await loadRepoSync(sub);
	assert.deepEqual(
		{ branch: subSync.branch, upstream: subSync.upstream, ahead: subSync.ahead, behind: subSync.behind },
		{ branch: null, upstream: null, ahead: 0, behind: 0 },
		'未检出的子模块不得回投父仓库的分支',
	);

	// 批量路径与单仓库路径同一判据：同一批里这两条路径各自正确。
	const batch = await loadReposSync([parent, sub]);
	assert.deepEqual(batch.map((entry) => entry.path), [parent, sub], 'path 原样回显');
	assert.equal(batch[0].branch, 'main');
	assert.equal(batch[1].branch, null, '批量子模块条目同样不得借用父仓库分支');

	/*
	 * 检出后读子模块自己的分支。`submodule update` 停在分离头指针上，因此先建并检出一个只属于
	 * 子模块的分支：名字与父仓库的 `main` 不同，读到它即证明读的是子模块自己的 `HEAD`。
	 */
	gitIn(parent, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
	gitIn(sub, 'checkout', '-q', '-B', 'subline');
	const initialized = await loadRepoSync(sub);
	assert.equal(initialized.branch, 'subline', '检出后读子模块自己的分支');
});

test('repoHead：未检出的子模块路径不是仓库，不返回父仓库的 HEAD', async () => {
	const facts = await import(libPath('repo-facts.js'));
	facts.setRepoFactsTtlForTest(0);
	const { parent, sub } = makeUninitializedSubmodule();

	const parentHead = await facts.repoHead(parent);
	const subLayout = await facts.repoLayout(sub);
	assert.equal(subLayout, null, '未检出的子模块没有 git 目录布局');
	assert.equal(await facts.repoHeadHash(sub), null, '未检出的子模块没有 HEAD');
	// 父仓库自身照常可读。
	assert.notEqual(parentHead, null, '父仓库的 HEAD 仍可读');
	assert.notEqual(await facts.repoHeadHash(parent), null);
});

test('isRepoPath 命令判据：未检出的子模块按非仓库处理', async () => {
	/*
	 * 命令层用同一判据决定「回空结果还是起 git」。以子模块路径发一条只读命令时，若判据向上
	 * 命中了父仓库，命令会真的去跑 git 并返回父仓库的数据。
	 */
	const { registerGgRoutes } = await import(libPath('routes.js'));
	const routes = new Map();
	registerGgRoutes({
		register(spec) {
			routes.set(spec.path, spec.handler);
			return () => {};
		},
	});
	const handler = routes.get('/dsh-source-control/gg/api');
	const call = (repo, message) => new Promise((done, fail) => {
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
				try { done(JSON.parse(text)); } catch { fail(new Error(`非 JSON 响应：${text}`)); }
			},
		};
		Promise.resolve(handler(req, res)).catch(fail);
	});

	const { parent, sub } = makeUninitializedSubmodule();
	const subSnapshot = await call(sub, { command: 'loadWorkingTreeSnapshot', noCache: true });
	assert.equal(subSnapshot.error, null);
	assert.deepEqual(subSnapshot.entries, [], '未检出的子模块没有工作区条目');
	assert.equal(subSnapshot.branch, null, '不得回投父仓库的分支');
	assert.equal(subSnapshot.head, null, '不得回投父仓库的 HEAD');

	const subCommits = await call(sub, { command: 'loadCommits', limit: 50, skip: 0, showTags: true, showRemoteBranches: true, hideRemotes: [], remotes: [] });
	assert.equal(subCommits.error, null);
	assert.deepEqual(subCommits.commits, [], '不得回投父仓库的提交');
	assert.equal(subCommits.branch, null);

	// 父仓库自身照常读出数据：判据只拒绝「向上命中」，不是拒绝一切。
	const parentSnapshot = await call(parent, { command: 'loadWorkingTreeSnapshot', noCache: true });
	assert.equal(parentSnapshot.branch, 'main');
	assert.notEqual(parentSnapshot.head, null);
});

test('enrichRepositories：过期的子模块节点在磁盘上消失后不再列出', async () => {
	/*
	 * `.gitmodules` 里删掉声明后，节点必须消失：留着它会让面板显示一个指向已不存在目录的行，
	 * 点它即得到「未检出子模块」空态，而它其实已被移除。
	 */
	const { discoverRepositories, clearDiscoveryCache } = await import(libPath('repo-discovery.js'));
	clearDiscoveryCache();
	const parent = makeTemp('gg-sub-stale-');
	gitIn(parent, 'init', '-q', '-b', 'main');
	gitIn(parent, 'config', 'user.email', 'stale@example.com');
	gitIn(parent, 'config', 'user.name', 'Stale');
	writeFileSync(join(parent, 'a.txt'), 'a\n');
	gitIn(parent, 'add', '-A');
	gitIn(parent, 'commit', '-q', '-m', 'base');
	writeFileSync(join(parent, '.gitmodules'), [
		'[submodule "gone"]',
		'\tpath = vendor/gone',
		'\turl = https://example.com/gone.git',
	].join('\n'));
	gitIn(parent, 'add', '-A');
	gitIn(parent, 'commit', '-q', '-m', 'add gitmodules');

	clearDiscoveryCache();
	const before = await discoverRepositories(parent, { maxDepth: 1 });
	const beforeSubs = before.nodes[0].children.filter((child) => child.kind === 'submodule');
	assert.deepEqual(beforeSubs.map((child) => resolve(child.path)), [resolve(join(parent, 'vendor', 'gone'))]);
	assert.equal(beforeSubs[0].available, false, '磁盘上没有该目录');

	// 声明被移除：下一次发现不得再列出它。
	rmSync(join(parent, '.gitmodules'));
	clearDiscoveryCache();
	const after = await discoverRepositories(parent, { maxDepth: 1 });
	assert.deepEqual(after.nodes[0].children.filter((child) => child.kind === 'submodule'), [], '声明移除后不再列出子模块');
});
