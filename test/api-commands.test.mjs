/**
 * 宿主命令集回归：经真实路由 handler 逐条发 API 请求，校验响应形状与关键取值。
 *
 * 被测模块有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入；
 * `pretest` 会先重建宿主与客户端产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'git-graph', 'routes.js');

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
	const handler = routes.get('/dsh-dev-git-graph/gg/api');
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

const built = existsSync(routesPath);

test('仓库信息、提交图与配置', { skip: !built && '未找到宿主产物 lib/src/git-graph/routes.js' }, async () => {
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
		assert.equal(commits.commits[0].hash, '*', '未提交伪提交应在最前');
		assert.equal(commits.commits[0].parents.length, 1);
		assert.match(commits.commits[0].message, /^Uncommitted Changes \(1\)$/);
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

test('提交详情：普通、根、重命名、工作区与贮藏', { skip: !built && '未找到宿主产物' }, async () => {
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

test('标签详情区分附注与轻量', { skip: !built && '未找到宿主产物' }, async () => {
	const { repo } = makeRepo();
	try {
		const call = await makeCaller(repo);
		const annotated = await call({ command: 'tagDetails', tagName: 'v1', commitHash: '' });
		assert.equal(annotated.tagDetails.message, 'release one');
		assert.equal(annotated.tagDetails.tagger, 'Api <api@example.com>');
		assert.equal(typeof annotated.tagDetails.date, 'string');

		const lightweight = await call({ command: 'tagDetails', tagName: 'light', commitHash: '' });
		assert.equal(lightweight.tagDetails, null);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('分支、标签、贮藏与远程的写操作', { skip: !built && '未找到宿主产物' }, async () => {
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

test('用户身份读写与文件差异内容', { skip: !built && '未找到宿主产物' }, async () => {
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

test('远程分支标注与 hideRemotes', { skip: !built && '未找到宿主产物' }, async () => {
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

test('未知命令被拒绝且非仓库路径不抛错', { skip: !built && '未找到宿主产物' }, async () => {
	const { repo } = makeRepo();
	try {
		const call = await makeCaller(repo);
		const unknown = await call({ command: 'no-such-command' });
		assert.match(unknown.error, /未知命令/);

		const outside = await makeCaller(join(tmpdir(), `gg-absent-${Date.now()}`));
		const info = await outside({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
		assert.equal(info.isRepo, false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
