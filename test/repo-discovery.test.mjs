/**
 * 仓库发现契约回归：逐层扫描结果、目录数上限、TTL 缓存、已知路径快路径与批量同步。
 *
 * `repo-discovery.ts` 有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此一律从 `lib/` 产物导入；
 * `pretest` 会先重建产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const discoveryPath = join(root, 'lib', 'src', 'source-control', 'repo-discovery.js');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
const built = existsSync(discoveryPath) && existsSync(routesPath);
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
 * 在一个目录下建一个已提交的仓库。
 *
 * @param parent - 父目录。
 * @param name - 仓库目录名。
 * @returns 仓库绝对路径。
 */
function makeRepoAt(parent, name) {
	const repo = join(parent, name);
	mkdirSync(repo, { recursive: true });
	gitIn(repo, 'init', '-q', '-b', 'main');
	gitIn(repo, 'config', 'user.email', 'disc@example.com');
	gitIn(repo, 'config', 'user.name', 'Disc');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	gitIn(repo, 'add', '-A');
	gitIn(repo, 'commit', '-q', '-m', 'base');
	return repo;
}

/** 造一个仓库目录（未提交），供已知路径快路径的节点数断言使用。 */
function makeBareRepoAt(parent, name) {
	const repo = join(parent, name);
	mkdirSync(repo, { recursive: true });
	gitIn(repo, 'init', '-q', '-b', 'main');
	return repo;
}

/**
 * 造一棵发现用目录树：两个顶层仓库（第二个在第 2 层）、一个链接工作树、一个子模块。
 *
 * 目录布局（root 为工作区根）：
 *   top-repo/            顶层仓库，挂 1 个链接工作树
 *   nested/mid-repo/     第 2 层仓库，挂 1 个子模块
 *   nested/plain/        非仓库目录
 *
 * @returns 根目录、两个仓库路径与链接工作树路径。
 */
function makeTree() {
	const rootDir = makeTemp('gg-disc-');
	const top = makeRepoAt(rootDir, 'top-repo');

	const linked = join(rootDir, 'linked-wt');
	gitIn(top, 'worktree', 'add', '-q', linked, '-b', 'linked');

	const nested = join(rootDir, 'nested');
	mkdirSync(join(nested, 'plain'), { recursive: true });
	const mid = makeRepoAt(nested, 'mid-repo');

	const subSource = makeTemp('gg-disc-subsrc-');
	gitIn(subSource, 'init', '-q', '-b', 'main');
	gitIn(subSource, 'config', 'user.email', 'sub@example.com');
	gitIn(subSource, 'config', 'user.name', 'Sub');
	writeFileSync(join(subSource, 's.txt'), 's\n');
	gitIn(subSource, 'add', '-A');
	gitIn(subSource, 'commit', '-q', '-m', 'sub');
	const subBare = makeTemp('gg-disc-subbare-');
	gitIn(tmpdir(), 'clone', '-q', '--bare', subSource, subBare);
	gitIn(mid, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subBare, 'sub');
	gitIn(mid, 'commit', '-q', '-m', 'add submodule');

	return { root: rootDir, top, mid, linked };
}

/** 把路径统一成 `/` 分隔，供跨平台比较。 */
function normalizePath(path) {
	return path.replace(/\\/g, '/');
}

/** 取出仓库节点上的子模块节点。 */
function submodulesOf(node) {
	return node.children.filter((child) => child.kind === 'submodule');
}

/** 取出仓库节点上的工作树节点。 */
function worktreesOf(node) {
	return node.children.filter((child) => child.kind === 'worktree');
}

test('discoverRepositories：节点排序、depth、children 与 truncated', { skip }, async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	const result = await discoverRepositories(tree.root);

	assert.equal(result.truncated, false);
	const repos = result.nodes.filter((node) => node.kind === 'repo');
	assert.equal(repos.length, 2, '应发现两个仓库');
	assert.deepEqual(repos.map((node) => node.path), [tree.mid, tree.top], '仓库节点按 path 升序');

	const byPath = new Map(result.nodes.map((node) => [node.path, node]));
	assert.equal(byPath.get(tree.top).depth, 1, '工作区根为第 0 层，直接子目录仓库 depth 为 1');
	assert.equal(byPath.get(tree.mid).depth, 2, '第 2 层目录下的仓库 depth 为 2');
	assert.equal(byPath.get(tree.top).name, 'top-repo');
	assert.equal(byPath.get(tree.top).kind, 'repo');
	assert.equal(byPath.get(tree.top).available, true);

	assert.deepEqual(
		worktreesOf(byPath.get(tree.top)).map((node) => normalizePath(node.path)),
		[normalizePath(tree.linked)],
		'工作树挂在所属仓库下',
	);
	assert.equal(byPath.get(tree.linked), undefined, '工作树不作为独立顶层节点');

	const submodules = submodulesOf(byPath.get(tree.mid));
	assert.equal(submodules.length, 1);
	assert.equal(submodules[0].path, join(tree.mid, 'sub'));
	assert.equal(submodules[0].depth, 1);
	assert.equal(submodules[0].available, true);
	assert.deepEqual(submodules[0].children, []);
});

test('discoverRepositories：maxDirectories 极小值时 truncated 为 true', { skip }, async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	const result = await discoverRepositories(tree.root, { maxDirectories: 1 });
	assert.equal(result.truncated, true);
	// 只够访问工作区根，其子目录一个也没进：根本身不是仓库，因此不产生仓库节点。
	assert.equal(result.nodes.filter((node) => node.kind === 'repo').length, 0);
});

test('discoverRepositories：TTL 缓存返回同一对象，clearDiscoveryCache 后失效', { skip }, async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	const first = await discoverRepositories(tree.root);
	const second = await discoverRepositories(tree.root);
	assert.equal(first, second, '同参数未过期时命中同一结果对象');

	clearDiscoveryCache();
	const third = await discoverRepositories(tree.root);
	assert.notEqual(third, first, '作废后应重新扫描');
	assert.notEqual(third.nodes, first.nodes);
	assert.deepEqual(third.nodes.map((node) => node.path), first.nodes.map((node) => node.path));

	const scoped = await discoverRepositories(tree.root, { maxDepth: 1 });
	assert.notEqual(scoped, first, '不同 maxDepth 不共用缓存');
});

test('discoverRepositories：knownRepos 快路径与全部失效时回退完整扫描', { skip }, async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();
	const found = await discoverRepositories(tree.root);
	const repoPaths = found.nodes.filter((node) => node.kind === 'repo').map((node) => node.path);

	clearDiscoveryCache();
	const fast = await discoverRepositories(tree.root, { knownRepos: repoPaths });
	assert.deepEqual(
		fast.nodes.filter((node) => node.kind === 'repo').map((node) => node.path),
		repoPaths,
		'已知路径快路径返回同样的顶层仓库',
	);
	assert.equal(fast.truncated, false);

	clearDiscoveryCache();
	const fallback = await discoverRepositories(tree.root, { knownRepos: [join(tree.root, 'absent-a'), join(tree.root, 'absent-b')] });
	assert.deepEqual(
		fallback.nodes.filter((node) => node.kind === 'repo').map((node) => node.path),
		repoPaths,
		'已知路径全部失效时回退完整扫描',
	);
});

/**
 * 记录既有差异：完整扫描的仓库 depth 是目录层数，knownRepos 快路径的仓库 depth 恒为 0。
 *
 * 快路径按已知路径构造节点，不经过层序遍历，因此拿不到目录层数；客户端不消费该字段
 * （仓库树的缩进由 flattenVisible 按嵌套层级自算），故不作为缺陷处理。
 */
test('discoverRepositories：快路径 depth 恒 0，客户端不消费该字段', { skip }, async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	const found = await discoverRepositories(tree.root);
	const depthByPath = new Map(found.nodes.filter((node) => node.kind === 'repo').map((node) => [node.path, node.depth]));
	assert.equal(depthByPath.get(tree.top), 1, '完整扫描：工作区根下的仓库 depth 为目录层数 1');
	assert.equal(depthByPath.get(tree.mid), 2, '完整扫描：第 2 层目录下的仓库 depth 为目录层数 2');

	clearDiscoveryCache();
	const fast = await discoverRepositories(tree.root, { knownRepos: [tree.top, tree.mid] });
	const fastRepos = fast.nodes.filter((node) => node.kind === 'repo');
	assert.equal(fastRepos.length, 2);
	assert.ok(
		fastRepos.every((node) => node.depth === 0),
		'快路径 depth 恒 0，客户端不消费该字段',
	);
});

test('discoverRepositories：同层目录多时结果与串行语义一致', { skip }, async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	const wide = makeTemp('gg-disc-wide-');
	const expected = [];
	for (let i = 0; i < 30; i++) {
		const repo = makeRepoAt(wide, `r${String(i).padStart(2, '0')}`);
		expected.push(repo);
	}

	clearDiscoveryCache();
	const result = await discoverRepositories(wide, { maxDepth: 1 });

	const paths = result.nodes.map((node) => node.path);
	assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right)), '节点按 path 升序');
	assert.deepEqual(paths, expected, '同层 30 个仓库全部发现');
	assert.equal(result.truncated, false);
	assert.ok(result.nodes.every((node) => node.depth === 1 && node.kind === 'repo'), '同层仓库 depth 均为 1');
});

test('loadReposSync：空数组返回空、path 原样回显、重复入参去重', { skip }, async () => {
	const { loadReposSync, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	assert.deepEqual(await loadReposSync([]), []);

	const rootDir = makeTemp('gg-sync-');
	const repoA = makeBareRepoAt(rootDir, 'Alpha-Repo');
	const repoB = makeBareRepoAt(rootDir, 'beta');
	const spelled = repoA.replace(/\//g, '\\') + '\\';
	assert.notEqual(spelled, repoA, '入参多一个尾分隔符，验证逐字回显');

	const results = await loadReposSync([spelled, repoB, spelled]);
	assert.equal(results.length, 2, '重复入参去重');
	assert.deepEqual(results.map((entry) => entry.path), [spelled, repoB]);
	assert.equal(results[0].path, spelled, 'path 逐字回显（含尾分隔符）');
	assert.equal(results[0].branch, 'main');
	assert.equal(results[0].upstream, null);
	assert.equal(results[0].ahead, 0);
	assert.equal(results[0].behind, 0);

	// 大小写变体是另一个入参字符串，不得被去重或改写。
	const cased = spelled.toLowerCase() === spelled ? spelled.toUpperCase() : spelled.toLowerCase();
	const variants = await loadReposSync([spelled, cased]);
	assert.deepEqual(variants.map((entry) => entry.path), [spelled, cased], '大小写变体各自回显');
	assert.equal(variants[0].branch, 'main', '大小写不影响仓库读取');
	assert.equal(variants[1].branch, 'main');
});

test('loadReposSync：单个仓库失败以空值兜底', { skip }, async () => {
	const { loadReposSync } = await import(pathToFileURL(discoveryPath).href);
	const rootDir = makeTemp('gg-sync-miss-');
	const repo = makeBareRepoAt(rootDir, 'real');
	const absent = join(rootDir, 'no-such-repo');

	const results = await loadReposSync([repo, absent]);
	assert.equal(results.length, 2);
	assert.deepEqual(results.map((entry) => entry.path), [repo, absent]);
	assert.equal(results[0].branch, 'main');
	assert.deepEqual(
		{ branch: results[1].branch, upstream: results[1].upstream, ahead: results[1].ahead, behind: results[1].behind },
		{ branch: null, upstream: null, ahead: 0, behind: 0 },
	);
});

test('loadReposSync 命令：经真实路由 handler 的空列表与多仓库', { skip }, async () => {
	const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
	const routes = new Map();
	registerGgRoutes({
		register(spec) {
			routes.set(spec.path, spec.handler);
			return () => {};
		},
	});
	const handler = routes.get('/dsh-source-control/gg/api');
	const call = (message) => new Promise((resolve, reject) => {
		const body = JSON.stringify(message);
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

	const rootDir = makeTemp('gg-sync-cmd-');
	const repoA = makeBareRepoAt(rootDir, 'Alpha-Repo');
	const repoB = makeBareRepoAt(rootDir, 'beta');

	const empty = await call({ repo: rootDir, command: 'loadReposSync', repos: [] });
	assert.deepEqual(empty, { command: 'loadReposSync', repo: rootDir, results: [], error: null });

	const batch = await call({ repo: rootDir, command: 'loadReposSync', repos: [repoA, repoB] });
	assert.equal(batch.command, 'loadReposSync');
	assert.equal(batch.error, null);
	assert.equal(batch.results.length, 2);
	assert.deepEqual(batch.results.map((entry) => entry.path), [repoA, repoB], 'path 与入参逐字相同');
	for (const entry of batch.results) {
		assert.equal(entry.branch, 'main');
		assert.equal(entry.upstream, null);
		assert.equal(entry.ahead, 0);
		assert.equal(entry.behind, 0);
	}
});
