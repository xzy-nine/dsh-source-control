/**
 * 分支同步契约回归：纯解析层直连 `src/`，`loadRepoSync` 从 `lib/` 宿主产物导入。
 *
 * `repo-discovery.ts` 有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此涉及它的断言
 * 一律从 `lib/` 产物导入；`pretest` 会先重建产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BRANCH_SYNC_FORMAT, parseBranchSync } from '../src/source-control/git-parse.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const discoveryPath = join(root, 'lib', 'src', 'source-control', 'repo-discovery.js');
const built = existsSync(discoveryPath);
const skip = built ? false : '未找到宿主产物 lib/src/source-control/repo-discovery.js';

/** 临时目录登记表；文件级 after 统一删除。 */
const temps = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

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
 * 建一个已配置身份的临时仓库。
 *
 * @param prefix - 目录名前缀。
 * @returns 仓库绝对路径。
 */
function makeRepo(prefix = 'gg-branch-') {
	const repo = makeTemp(prefix);
	gitIn(repo, 'init', '-q', '-b', 'main');
	gitIn(repo, 'config', 'user.email', 'branch@example.com');
	gitIn(repo, 'config', 'user.name', 'Branch');
	return repo;
}

/**
 * 写一个文件并提交。
 *
 * @param repo - 仓库路径。
 * @param name - 文件名。
 * @param content - 文件内容。
 * @param message - 提交信息。
 * @returns 无。
 */
function commitFile(repo, name, content, message) {
	writeFileSync(join(repo, name), content);
	gitIn(repo, 'add', '-A');
	gitIn(repo, 'commit', '-q', '-m', message);
}

/**
 * 造 `for-each-ref` 的一条记录：字段以 NUL 分隔。
 *
 * @param head - `%(HEAD)` 字段。
 * @param branch - 分支名。
 * @param upstream - 上游短名。
 * @param track - 领先/落后文本。
 * @returns 记录文本（不含行尾换行）。
 */
function record(head, branch, upstream, track) {
	return [head, branch, upstream, track].join('\0');
}

/**
 * 建一个带上游的仓库：裸仓库为上游，本地追加 localAhead 个提交，另一个克隆往上游推 remoteAhead 个提交。
 *
 * @param localAhead - 本地独有的提交数。
 * @param remoteAhead - 上游独有的提交数。
 * @returns 仓库绝对路径。
 */
function makeUpstreamRepo(localAhead, remoteAhead) {
	const remote = makeTemp('gg-branch-remote-');
	gitIn(tmpdir(), 'init', '-q', '--bare', '-b', 'main', remote);

	const repo = makeRepo('gg-branch-work-');
	commitFile(repo, 'a.txt', 'one\n', 'base');
	gitIn(repo, 'remote', 'add', 'origin', remote);
	gitIn(repo, 'push', '-q', '--set-upstream', 'origin', 'main');

	if (remoteAhead > 0) {
		const other = makeTemp('gg-branch-other-');
		gitIn(tmpdir(), 'clone', '-q', remote, other);
		gitIn(other, 'config', 'user.email', 'other@example.com');
		gitIn(other, 'config', 'user.name', 'Other');
		for (let i = 0; i < remoteAhead; i++) commitFile(other, `r${i}.txt`, `r${i}\n`, `remote ${i}`);
		gitIn(other, 'push', '-q', 'origin', 'main');
	}
	for (let i = 0; i < localAhead; i++) commitFile(repo, `l${i}.txt`, `l${i}\n`, `local ${i}`);
	gitIn(repo, 'fetch', '-q', 'origin');
	return repo;
}

/**
 * 独立预言机：git 自身推导的领先/落后数。
 *
 * `rev-list --left-right --count @{upstream}...HEAD` 左计数为上游独有（落后），右计数为本地独有（领先）。
 *
 * @param repo - 仓库路径。
 * @returns 领先与落后数。
 */
function oracleSync(repo) {
	const [behind, ahead] = gitIn(repo, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD')
		.trim().split(/\s+/).map(Number);
	return { ahead, behind };
}

test('BRANCH_SYNC_FORMAT：四个字段以 %00 分隔且首字段为 %(HEAD)', () => {
	assert.equal(BRANCH_SYNC_FORMAT.split('%00').length, 4);
	assert.ok(BRANCH_SYNC_FORMAT.startsWith('%(HEAD)'));
	assert.ok(BRANCH_SYNC_FORMAT.includes('%(upstream:short)'));
	assert.ok(BRANCH_SYNC_FORMAT.includes('%(upstream:track,nobracket)'));
	assert.ok(!BRANCH_SYNC_FORMAT.includes('%x00'), 'for-each-ref 的转义是 %00');
});

test('parseBranchSync：ahead、behind 与两者同时', () => {
	assert.deepEqual(parseBranchSync(record('*', 'main', 'origin/main', 'ahead 1') + '\n'),
		{ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0 });
	assert.deepEqual(parseBranchSync(record('*', 'main', 'origin/main', 'behind 2') + '\n'),
		{ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 2 });
	assert.deepEqual(parseBranchSync(record('*', 'main', 'origin/main', 'ahead 1, behind 2') + '\n'),
		{ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2 });
});

test('parseBranchSync：upstream 为 null 的三种情形', () => {
	assert.deepEqual(parseBranchSync(record('*', 'main', '', '') + '\n'),
		{ branch: 'main', upstream: null, ahead: 0, behind: 0 }, '上游字段为空');
	assert.deepEqual(parseBranchSync(record('*', 'main', 'origin/main', 'gone') + '\n'),
		{ branch: 'main', upstream: null, ahead: 0, behind: 0 }, '上游引用已删除');
	assert.deepEqual(parseBranchSync(record(' ', 'dev', '', '') + '\n'),
		{ branch: null, upstream: null, ahead: 0, behind: 0 }, '无 * 记录');
	assert.deepEqual(parseBranchSync(''),
		{ branch: null, upstream: null, ahead: 0, behind: 0 }, '空串');
});

test('parseBranchSync：多分支且 * 在中间', () => {
	const stdout = [
		record(' ', 'dev', '', ''),
		record('*', 'main', 'origin/main', 'ahead 3, behind 4'),
		record(' ', 'feat', '', ''),
	].join('\n') + '\n';
	assert.deepEqual(parseBranchSync(stdout), { branch: 'main', upstream: 'origin/main', ahead: 3, behind: 4 });
});

test('parseBranchSync：真实 for-each-ref 输出每行四字段且标出当前分支', () => {
	const repo = makeRepo();
	commitFile(repo, 'a.txt', 'one\n', 'base');
	gitIn(repo, 'branch', 'dev');

	const stdout = gitIn(repo, 'for-each-ref', `--format=${BRANCH_SYNC_FORMAT}`, 'refs/heads');
	const lines = stdout.split('\n').filter((line) => line !== '');
	assert.equal(lines.length, 2);
	for (const line of lines) assert.equal(line.split('\0').length, 4);

	const parsed = parseBranchSync(stdout);
	assert.equal(parsed.branch, 'main');
	assert.equal(parsed.upstream, null);
	assert.equal(parsed.ahead, 0);
	assert.equal(parsed.behind, 0);
});

test('独立预言机：仅领先时 for-each-ref 解析与 rev-list 推导一致', () => {
	const repo = makeUpstreamRepo(1, 0);
	const stdout = gitIn(repo, 'for-each-ref', `--format=${BRANCH_SYNC_FORMAT}`, 'refs/heads');
	const parsed = parseBranchSync(stdout);

	assert.equal(parsed.branch, 'main');
	assert.equal(parsed.upstream, 'origin/main');
	assert.deepEqual({ ahead: parsed.ahead, behind: parsed.behind }, { ahead: 1, behind: 0 });
	assert.deepEqual({ ahead: parsed.ahead, behind: parsed.behind }, oracleSync(repo));
});

test('独立预言机：领先且落后时 for-each-ref 解析与 rev-list 推导一致', () => {
	const repo = makeUpstreamRepo(2, 1);
	const stdout = gitIn(repo, 'for-each-ref', `--format=${BRANCH_SYNC_FORMAT}`, 'refs/heads');
	const parsed = parseBranchSync(stdout);

	assert.equal(parsed.branch, 'main');
	assert.equal(parsed.upstream, 'origin/main');
	assert.deepEqual({ ahead: parsed.ahead, behind: parsed.behind }, { ahead: 2, behind: 1 });
	assert.deepEqual({ ahead: parsed.ahead, behind: parsed.behind }, oracleSync(repo));
});

test('loadRepoSync（lib 产物）：与 rev-list 推导一致', { skip }, async () => {
	const { loadRepoSync } = await import(pathToFileURL(discoveryPath).href);
	const repo = makeUpstreamRepo(2, 1);

	const sync = await loadRepoSync(repo);
	assert.deepEqual(sync, { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
	assert.deepEqual({ ahead: sync.ahead, behind: sync.behind }, oracleSync(repo));
});

test('loadRepoSync（lib 产物）：上游引用被删除后 upstream 为 null 且不抛错', { skip }, async () => {
	const { loadRepoSync } = await import(pathToFileURL(discoveryPath).href);
	const repo = makeUpstreamRepo(0, 0);
	gitIn(repo, 'update-ref', '-d', 'refs/remotes/origin/main');

	const line = gitIn(repo, 'for-each-ref', `--format=${BRANCH_SYNC_FORMAT}`, 'refs/heads')
		.split('\n').find((text) => text.startsWith('*'));
	assert.equal(line.split('\0')[3].trim(), 'gone', '上游被删除时 track 文本为 gone');

	const sync = await loadRepoSync(repo);
	assert.deepEqual(sync, { branch: 'main', upstream: null, ahead: 0, behind: 0 });
});

test('loadRepoSync（lib 产物）：无提交仓库给出分支名与空上游', { skip }, async () => {
	const { loadRepoSync } = await import(pathToFileURL(discoveryPath).href);
	const repo = makeRepo('gg-branch-empty-');

	const sync = await loadRepoSync(repo);
	assert.deepEqual(sync, { branch: 'main', upstream: null, ahead: 0, behind: 0 });
});

test('loadRepoSync（lib 产物）：分离头指针时分支为 null', { skip }, async () => {
	const { loadRepoSync } = await import(pathToFileURL(discoveryPath).href);
	const repo = makeRepo();
	commitFile(repo, 'a.txt', 'one\n', 'base');
	gitIn(repo, 'checkout', '-q', '--detach');
	assert.equal(gitIn(repo, 'branch', '--show-current').trim(), '');

	const sync = await loadRepoSync(repo);
	assert.deepEqual(sync, { branch: null, upstream: null, ahead: 0, behind: 0 });
});
