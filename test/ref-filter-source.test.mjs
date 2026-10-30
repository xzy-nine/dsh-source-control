/**
 * 引用筛选的宿主侧取数：全部引用摘要与当前分支的分叉来源。
 *
 * 分叉来源的取值顺序与 VS Code 图形视图的 base 引用一致：配置、分支 reflog 的创建来源、
 * 默认远程的默认分支。用真实临时仓库覆盖三种来源与分离头指针。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importHostModule } from './lib-import.mjs';

const { getBranchBase, getRefSummaries } = await importHostModule('source-control/git-query.js');

/** 临时目录登记表；文件级 after 统一删除。 */
const temps = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * 建一个带已提交内容的仓库。
 *
 * @param prefix - 目录名前缀。
 * @returns 仓库路径与执行 git 的辅助函数。
 */
function makeRepo(prefix) {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	temps.push(repo);
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'filter@example.com');
	git('config', 'user.name', 'Filter');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
	return { repo, git };
}

/**
 * 建一个裸仓库并把它配成 origin，再把 main 推上去。
 *
 * @param git - 仓库的 git 辅助函数。
 * @returns 裸仓库路径。
 */
function withRemote(git) {
	const remote = mkdtempSync(join(tmpdir(), 'gg-filter-remote-'));
	temps.push(remote);
	rmSync(remote, { recursive: true, force: true });
	execFileSync('git', ['init', '-q', '--bare', remote]);
	git('remote', 'add', 'origin', remote);
	git('push', '-q', '-u', 'origin', 'main');
	return remote;
}

test('全部引用：分支、远程分支与标签都带完整引用名', async () => {
	const { repo, git } = makeRepo('gg-filter-refs-');
	withRemote(git);
	git('branch', 'feature');
	git('tag', 'v1');

	const refs = await getRefSummaries(repo, true);
	const byId = new Map(refs.map((ref) => [ref.id, ref]));
	assert.equal(byId.get('refs/heads/main')?.type, 'branch');
	assert.equal(byId.get('refs/heads/feature')?.type, 'branch');
	assert.equal(byId.get('refs/tags/v1')?.type, 'tag');
	assert.equal(byId.get('refs/remotes/origin/main')?.type, 'remote');
	assert.equal(byId.get('refs/remotes/origin/main')?.name, 'origin/main');
	// 关闭远程分支时列表里没有远程引用。
	const localOnly = await getRefSummaries(repo, false);
	assert.equal(localOnly.some((ref) => ref.type === 'remote'), false);
});

test('分叉来源：reflog 的创建来源解析到上游远程分支', async () => {
	const { repo, git } = makeRepo('gg-filter-reflog-');
	withRemote(git);
	git('checkout', '-q', '-b', 'feature');

	assert.deepEqual(await getBranchBase(repo), { branch: 'feature', base: 'origin/main' });
});

test('分叉来源：显式配置优先于 reflog', async () => {
	const { repo, git } = makeRepo('gg-filter-config-');
	withRemote(git);
	const base = git('rev-parse', 'HEAD');
	git('update-ref', 'refs/remotes/origin/dev', base);
	git('checkout', '-q', '-b', 'topic', 'main');
	git('config', 'branch.topic.vscode-merge-base', 'origin/dev');

	assert.deepEqual(await getBranchBase(repo), { branch: 'topic', base: 'origin/dev' });
});

test('分叉来源：无远程时退回本地来源分支', async () => {
	const { repo, git } = makeRepo('gg-filter-local-');
	git('branch', 'side');
	git('checkout', '-q', '-b', 'topic', 'side');

	assert.deepEqual(await getBranchBase(repo), { branch: 'topic', base: 'side' });
});

test('分叉来源：分离头指针没有来源', async () => {
	const { repo, git } = makeRepo('gg-filter-detached-');
	git('checkout', '-q', '--detach', 'HEAD');

	assert.deepEqual(await getBranchBase(repo), { branch: null, base: null });
});
/**
 * 取一条经真实路由 handler 发请求的调用函数。
 *
 * @param repo - 仓库路径。
 * @returns 发请求的函数。
 */
async function makeCaller(repo) {
	const routesPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'src', 'source-control', 'routes.js');
	const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
	const routes = new Map();
	registerGgRoutes({ register(spec) { routes.set(spec.path, spec.handler); return () => {}; } });
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
		const res = { writeHead() {}, end(payload) { try { resolve(JSON.parse(payload)); } catch (error) { reject(error); } } };
		Promise.resolve(handler(req, res)).catch(reject);
	});
}

test('经路由读引用与分叉来源', async () => {
	const { repo, git } = makeRepo('gg-filter-route-');
	withRemote(git);
	git('checkout', '-q', '-b', 'feature');
	const call = await makeCaller(repo);

	const refs = await call({ command: 'loadRefs', showRemoteBranches: true });
	assert.equal(refs.error, null);
	assert.ok(Array.isArray(refs.refs));
	assert.ok(refs.refs.some((item) => item.id === 'refs/heads/feature'));

	const base = await call({ command: 'loadBranchBase' });
	assert.equal(base.error, null);
	assert.equal(base.branch, 'feature');
	assert.equal(base.base, 'origin/main');
});

test('筛选在取数端生效：提交图只含选中引用的历史', async () => {
	const { repo, git } = makeRepo('gg-filter-commits-');
	// main：base → second；feature 从 base 分出再加一条，HEAD 停在 main。
	writeFileSync(join(repo, 'a.txt'), 'two\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'second');
	git('checkout', '-q', '-b', 'feature', 'HEAD~1');
	writeFileSync(join(repo, 'b.txt'), 'feature\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'feature work');
	git('checkout', '-q', 'main');
	const mainTip = git('rev-parse', 'HEAD');
	const featureTip = git('rev-parse', 'feature');
	const call = await makeCaller(repo);
	const message = {
		command: 'loadCommits', limit: 50, skip: 0, showTags: true, showRemoteBranches: true,
		includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
		withRepoInfo: false, remotes: [], stashes: [], hideRemotes: [],
	};

	const all = await call(message);
	assert.equal(all.error, null);
	assert.ok(all.commits.some((commit) => commit.hash === mainTip), '全部时 main 尖端可见');

	const filtered = await call({ ...message, branches: ['feature'] });
	assert.equal(filtered.error, null);
	const hashes = filtered.commits.map((commit) => commit.hash);
	assert.ok(hashes.includes(featureTip), '选中引用的尖端可见');
	assert.equal(hashes.includes(mainTip), false, '未选中的分支尖端被排除');
	assert.ok(hashes.includes(git('rev-parse', 'feature~1')), '共同祖先仍在');
});
