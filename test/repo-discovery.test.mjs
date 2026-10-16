/**
 * 仓库发现契约回归：逐层扫描结果、目录数上限、TTL 缓存、已知路径快路径与批量同步。
 *
 * `repo-discovery.ts` 有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此一律从 `lib/` 产物导入；
 * `pretest` 会先重建产物。
 *
 * 另覆盖浅层发现（`shallow` 不产生 children）、`enrichRepositories` 按路径补齐、`discoverWorkspace`
 * 的持久化位置命中、`findEnclosingRepoDir` 的三档判定，以及无链接工作树时 `branchesOfOtherWorktrees`
 * 不启动 git 子进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const discoveryPath = join(root, 'lib', 'src', 'source-control', 'repo-discovery.js');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
const statePath = join(root, 'lib', 'src', 'source-control', 'state-store.js');

/** 临时目录登记表；文件级 after 统一删除。 */
const temps = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/* 状态文档隔离：本文件的 discoverWorkspace 会写宿主持久化，落到临时目录，避免动到真实 state.json。 */
const stateHome = mkdtempSync(join(tmpdir(), 'gg-disc-home-'));
temps.push(stateHome);
process.env.DSH_SOURCE_CONTROL_HOME = stateHome;

/* git 子进程计数：替换 child_process.spawn 并同步给 ESM 具名绑定，用于断言「不启动 git」。 */
let gitSpawns = 0;
const originalSpawn = cp.spawn;
cp.spawn = (...args) => {
	gitSpawns += 1;
	return originalSpawn(...args);
};
syncBuiltinESMExports();

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

/**
 * 节点的比较用形状：去掉对象身份，只留可跨实现比较的字段。
 *
 * 顶层 depth 不参与比较：按已知路径构造的节点不经过层序遍历，depth 恒为 0，与既有
 * `knownRepos` 快路径的已记录差异相同；子节点的 depth 照常比较。
 *
 * @param node - 节点。
 * @param top - 是否为顶层节点。
 * @returns 递归展开的形状。
 */
function shapeOf(node, top = true) {
	return {
		id: node.id, path: node.path, name: node.name, kind: node.kind,
		depth: top ? undefined : node.depth,
		branch: node.branch, head: node.head, available: node.available,
		children: (node.children ?? []).map((child) => shapeOf(child, false)),
	};
}

/** 清掉状态文档的内存镜像，使下一次读取重新落盘载入。 */
async function resetState() {
	const { resetStateCache } = await import(pathToFileURL(statePath).href);
	resetStateCache();
}

/**
 * 造一棵含三类仓库的发现用目录树，三类仓库都在工作区根下第 1 层：
 *   plain-repo/   无链接工作树、无子模块
 *   sub-repo/     挂 1 个子模块
 *   wt-repo/      挂 1 个链接工作树
 *
 * @returns 根目录与三类仓库路径。
 */
function makeMixedTree() {
	const rootDir = makeTemp('gg-disc-mixed-');
	const plain = makeRepoAt(rootDir, 'plain-repo');
	const sub = makeRepoAt(rootDir, 'sub-repo');
	const wt = makeRepoAt(rootDir, 'wt-repo');

	gitIn(wt, 'worktree', 'add', '-q', join(rootDir, 'wt-linked'), '-b', 'linked');

	const subSource = makeTemp('gg-disc-mixed-subsrc-');
	gitIn(subSource, 'init', '-q', '-b', 'main');
	gitIn(subSource, 'config', 'user.email', 'sub@example.com');
	gitIn(subSource, 'config', 'user.name', 'Sub');
	writeFileSync(join(subSource, 's.txt'), 's\n');
	gitIn(subSource, 'add', '-A');
	gitIn(subSource, 'commit', '-q', '-m', 'sub');
	const subBare = makeTemp('gg-disc-mixed-subbare-');
	gitIn(tmpdir(), 'clone', '-q', '--bare', subSource, subBare);
	gitIn(sub, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subBare, 'sub');
	gitIn(sub, 'commit', '-q', '-m', 'add submodule');

	return { root: rootDir, plain, sub, wt };
}

test('discoverRepositories：节点排序、depth、children 与 truncated', async () => {
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

test('discoverRepositories：maxDirectories 极小值时 truncated 为 true', async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	const result = await discoverRepositories(tree.root, { maxDirectories: 1 });
	assert.equal(result.truncated, true);
	// 只够访问工作区根，其子目录一个也没进：根本身不是仓库，因此不产生仓库节点。
	assert.equal(result.nodes.filter((node) => node.kind === 'repo').length, 0);
});

test('discoverRepositories：TTL 缓存返回同一对象，clearDiscoveryCache 后失效', async () => {
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

test('discoverRepositories：knownRepos 快路径与全部失效时回退完整扫描', async () => {
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
test('discoverRepositories：快路径 depth 恒 0，客户端不消费该字段', async () => {
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

test('discoverRepositories：同层目录多时结果与串行语义一致', async () => {
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

test('loadReposSync：空数组返回空、path 原样回显、重复入参去重', async () => {
	const { loadReposSync, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	assert.deepEqual(await loadReposSync([]), []);

	const rootDir = makeTemp('gg-sync-');
	const repoA = makeBareRepoAt(rootDir, 'Alpha-Repo');
	const repoB = makeBareRepoAt(rootDir, 'beta');
	// 非规范写法：追加平台分隔符。该写法必须逐字回显，且仍能读到仓库。
	const spelled = repoA + sep;
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

test('loadReposSync：单个仓库失败以空值兜底', async () => {
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

test('loadReposSync 命令：经真实路由 handler 的空列表与多仓库', async () => {
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

test('discoverRepositories：shallow 只产出顶层仓库节点，children 一律为空', async () => {
	const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	gitSpawns = 0;
	const shallow = await discoverRepositories(tree.root, { shallow: true });

	assert.equal(gitSpawns, 0, 'shallow 不启动 git');
	const repos = shallow.nodes.filter((node) => node.kind === 'repo');
	assert.equal(repos.length, 2);
	assert.ok(repos.every((node) => node.children.length === 0), 'shallow 的仓库节点无 children');
	assert.equal(
		shallow.nodes.some((node) => node.kind === 'worktree' || node.kind === 'submodule'),
		false,
		'shallow 不产出工作树与子模块节点',
	);

	const full = await discoverRepositories(tree.root);
	assert.notEqual(full, shallow, 'shallow 与完整发现不共用缓存');
	const scalarOf = (node) => ({
		id: node.id, path: node.path, name: node.name, kind: node.kind, depth: node.depth,
		branch: node.branch, head: node.head, available: node.available,
	});
	assert.deepEqual(
		repos.map(scalarOf),
		full.nodes.filter((node) => node.kind === 'repo').map(scalarOf),
		'浅层节点字段与完整发现一致',
	);
});

test('enrichRepositories：按顶层路径补齐的结构与完整扫描一致', async () => {
	const { discoverRepositories, enrichRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();
	const full = await discoverRepositories(tree.root);
	const paths = full.nodes.filter((node) => node.kind === 'repo').map((node) => node.path);

	const enriched = await enrichRepositories([...paths, join(tree.root, 'absent'), paths[0]]);

	assert.equal(enriched.length, 2, '重复路径去重、非仓库路径忽略');
	assert.deepEqual(enriched.map((node) => node.path), paths, '顺序与去重后的入参一致');
	assert.deepEqual(enriched.map((node) => shapeOf(node)), full.nodes.map((node) => shapeOf(node)), '与完整扫描的节点结构一致');

	const input = [...paths];
	await enrichRepositories(input);
	assert.deepEqual(input, paths, '不修改入参数组');
});

test('discoverWorkspace：命中持久化位置时 usedCache 为 true，fullScan 回填并跳过缓存', async () => {
	const { discoverWorkspace, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	await resetState();
	clearDiscoveryCache();
	const tree = makeTree();
	// 节点按 path 升序：nested\mid-repo 排在 top-repo 之前。
	const repoPaths = [tree.mid, tree.top].sort((left, right) => left.localeCompare(right));

	const cold = await discoverWorkspace(tree.root, { shallow: true });
	assert.equal(cold.usedCache, false, '无持久化位置时完整扫描');
	assert.equal(cold.nodes.filter((node) => node.kind === 'repo').length, 2);

	const forced = await discoverWorkspace(tree.root, { shallow: true, fullScan: true });
	assert.equal(forced.usedCache, false, 'fullScan 跳过持久化位置');
	assert.deepEqual(forced.nodes.filter((node) => node.kind === 'repo').map((node) => node.path), repoPaths);
	assert.deepEqual(forced.nodes.filter((node) => node.kind === 'repo').map((node) => node.children.length), [0, 0]);

	await resetState();
	clearDiscoveryCache();
	const hit = await discoverWorkspace(tree.root, { shallow: true });
	assert.equal(hit.usedCache, true, '命中持久化位置');
	assert.deepEqual(hit.nodes.filter((node) => node.kind === 'repo').map((node) => node.path), repoPaths);
	assert.ok(hit.nodes.filter((node) => node.kind === 'repo').every((node) => node.children.length === 0));

	const deep = await discoverWorkspace(tree.root);
	assert.equal(deep.usedCache, true);
	assert.ok(worktreesOf(deep.nodes.find((node) => node.path === tree.top)).length > 0, 'shallow 命中不污染完整发现的缓存');
});

test('findEnclosingRepoDir：工作区根即仓库 / 在仓库子目录内 / 不在仓库内', async () => {
	const { findEnclosingRepoDir } = await import(pathToFileURL(discoveryPath).href);
	const parent = makeTemp('gg-enclose-');
	const repo = makeRepoAt(parent, 'repo');
	const nested = join(repo, 'nested', 'deep');
	mkdirSync(nested, { recursive: true });
	const outside = join(parent, 'outside');
	mkdirSync(outside, { recursive: true });

	gitSpawns = 0;
	assert.equal(await findEnclosingRepoDir(repo), resolve(repo), '工作区根即仓库');
	assert.equal(await findEnclosingRepoDir(nested), resolve(repo), '工作区根在仓库子目录内');
	assert.equal(await findEnclosingRepoDir(outside), null, '不在任何仓库内');
	assert.equal(gitSpawns, 0, '判定只走文件系统');
});

test('branchesOfOtherWorktrees：无链接工作树时零 git 调用', async () => {
	const { branchesOfOtherWorktrees } = await import(pathToFileURL(discoveryPath).href);
	const tree = makeTree();

	gitSpawns = 0;
	assert.deepEqual(await branchesOfOtherWorktrees(tree.mid), new Set(), '普通仓库无别的工作树分支');
	assert.equal(gitSpawns, 0, '无链接工作树时不启动 git');

	gitSpawns = 0;
	assert.deepEqual([...await branchesOfOtherWorktrees(tree.top)].sort(), ['linked'], '有链接工作树时仍枚举');
	assert.ok(gitSpawns > 0);

	gitSpawns = 0;
	assert.deepEqual([...await branchesOfOtherWorktrees(tree.linked)].sort(), ['main'], '查看链接工作树时排除主工作树的当前分支');
});

test('enrichRepositories：三类仓库的结构与完整扫描一致，无来源时零 git 调用', async () => {
	const { discoverRepositories, enrichRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeMixedTree();
	const full = await discoverRepositories(tree.root);
	const byPath = new Map(full.nodes.filter((node) => node.kind === 'repo').map((node) => [node.path, node]));

	assert.deepEqual(
		worktreesOf(byPath.get(tree.wt)).length,
		1,
		'完整扫描下 wt-repo 有 1 个链接工作树',
	);
	assert.equal(submodulesOf(byPath.get(tree.sub)).length, 1, '完整扫描下 sub-repo 有 1 个子模块');
	assert.equal(byPath.get(tree.plain).children.length, 0, '完整扫描下 plain-repo 无 children');

	/* 等过宿主只读结果缓存的 200ms TTL，否则 spawn 计数会命中上一步完整扫描留下的缓存。 */
	await new Promise((done) => setTimeout(done, 400));

	clearDiscoveryCache();
	gitSpawns = 0;
	const plainOnly = await enrichRepositories([tree.plain]);
	assert.equal(gitSpawns, 0, '无链接工作树且无 .gitmodules 时不启动 git');
	assert.deepEqual(plainOnly.map((node) => shapeOf(node)), [shapeOf(byPath.get(tree.plain))], 'plain-repo 结构与完整扫描一致');
	assert.deepEqual(plainOnly[0].children, []);

	gitSpawns = 0;
	const subOnly = await enrichRepositories([tree.sub]);
	assert.ok(gitSpawns >= 1, '有子模块时仍枚举');
	assert.deepEqual(subOnly.map((node) => shapeOf(node)), [shapeOf(byPath.get(tree.sub))], 'sub-repo 结构与完整扫描一致');

	gitSpawns = 0;
	const wtOnly = await enrichRepositories([tree.wt]);
	assert.ok(gitSpawns >= 1, '有链接工作树时仍枚举');
	assert.deepEqual(wtOnly.map((node) => shapeOf(node)), [shapeOf(byPath.get(tree.wt))], 'wt-repo 结构与完整扫描一致');

	clearDiscoveryCache();
	const mixed = await enrichRepositories([tree.plain, tree.sub, tree.wt]);
	assert.deepEqual(
		mixed.map((node) => shapeOf(node)),
		[tree.plain, tree.sub, tree.wt].map((path) => shapeOf(byPath.get(path))),
		'三类仓库混在一批时结果与完整扫描一致',
	);
});

test('enrichRepositories：链接工作树路径不再返回空，且与发现层节点一致', async () => {
	const { discoverRepositories, enrichRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	// 工作区根位于链接工作树内部：发现层为链接工作树根产出仓库节点，该路径的 `.git` 是文件。
	const inner = join(tree.linked, 'inner', 'deep');
	mkdirSync(inner, { recursive: true });
	const viaEnclosing = await discoverRepositories(inner, {});
	const enclosing = viaEnclosing.nodes.find((node) => node.kind === 'repo');
	assert.equal(resolve(enclosing.path), resolve(tree.linked), '发现层把链接工作树根作为仓库节点');
	assert.equal(enclosing.branch, 'linked', '发现层从 `.git` 文件解析出分支');

	clearDiscoveryCache();
	const enriched = await enrichRepositories([tree.linked]);
	assert.equal(enriched.length, 1, '链接工作树路径不再被过滤');
	assert.equal(resolve(enriched[0].path), resolve(tree.linked));
	assert.equal(enriched[0].kind, 'repo');
	assert.equal(enriched[0].branch, 'linked', '`.git` 为文件时仍解析出分支');
	assert.equal(enriched[0].depth, 0);
	assert.deepEqual(
		enriched.map((node) => shapeOf(node)),
		[shapeOf(enclosing)],
		'链接工作树节点与发现层对该路径产出的节点一致',
	);
	assert.deepEqual(
		enriched[0].children.map((child) => resolve(child.path)),
		[resolve(tree.top)],
		'链接工作树补齐出主工作树节点',
	);

	// 主工作树路径照常工作。
	const mainEnriched = await enrichRepositories([tree.top]);
	assert.equal(mainEnriched.length, 1, '主工作树路径仍正常');
	assert.equal(mainEnriched[0].branch, 'main');
	assert.deepEqual(worktreesOf(mainEnriched[0]).map((node) => resolve(node.path)), [resolve(tree.linked)]);
});

test('enrichRepositories：子模块路径与发现层一致，bare 仓库两处判据一致', async () => {
	const { discoverRepositories, enrichRepositories, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
	clearDiscoveryCache();
	const tree = makeTree();

	// 子模块的 `.git` 是文件：`git worktree list` 会把 git 目录本身列为一条工作树记录。
	const submodule = join(tree.mid, 'sub');
	const inner = join(submodule, 'deep');
	mkdirSync(inner, { recursive: true });
	const viaEnclosing = await discoverRepositories(inner, {});
	const enclosing = viaEnclosing.nodes.find((node) => node.kind === 'repo');
	assert.equal(resolve(enclosing.path), resolve(submodule), '发现层把子模块根作为仓库节点');
	assert.ok(enclosing.children.length > 0, '子模块节点的 git 目录被枚举为工作树记录');

	clearDiscoveryCache();
	const enriched = await enrichRepositories([submodule]);
	assert.equal(enriched.length, 1, '子模块路径不被过滤');
	assert.deepEqual(enriched.map((node) => shapeOf(node)), [shapeOf(enclosing)], '子模块节点与发现层一致');

	// bare 仓库没有 `.git` 条目：发现层与补齐层都不认它，两处判据一致。
	const bareRoot = makeTemp('gg-disc-bare-');
	const source = makeRepoAt(bareRoot, 'source');
	const bare = join(bareRoot, 'bare.git');
	gitIn(bareRoot, 'clone', '-q', '--bare', source, bare);
	const bareDiscovery = await discoverRepositories(bareRoot, { maxDepth: 1 });
	assert.equal(
		bareDiscovery.nodes.filter((node) => resolve(node.path) === resolve(bare)).length,
		0,
		'发现层不把 bare 仓库当作仓库节点',
	);
	assert.deepEqual(await enrichRepositories([bare]), [], '补齐层同样不认 bare 仓库');
});
