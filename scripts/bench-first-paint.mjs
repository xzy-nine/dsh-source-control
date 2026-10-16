/**
 * 首屏空白时间度量：经真实路由 handler 度量「仓库列表 / 更改区 / 图形区」出现内容前的等待。
 *
 * 每个采样之间留出冷却，避开宿主只读子命令结果缓存的 200ms TTL：否则同一仓库的相邻采样会命中
 * 上一次的 `git worktree list` / `git status` 结果，读数偏小且不可复现。
 *
 * 用法：node scripts/bench-first-paint.mjs [仓库路径] [轮数]
 * 依赖宿主产物 lib/src/source-control/routes.js 与 lib/src/source-control/repo-discovery.js。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
const discoveryPath = join(root, 'lib', 'src', 'source-control', 'repo-discovery.js');
if (!existsSync(routesPath) || !existsSync(discoveryPath)) {
	console.error('未找到宿主产物，请先 pnpm build:host');
	process.exit(1);
}

const repo = process.argv[2] ?? process.cwd();
const rounds = Math.max(1, Number.parseInt(process.argv[3] ?? '5', 10));
/** 采样间隔：大于宿主只读结果缓存的 200ms TTL。 */
const COOLDOWN_MS = 300;

const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
const { discoverRepositories, discoverWorkspace, clearDiscoveryCache } = await import(pathToFileURL(discoveryPath).href);
const { writeRepoLocations } = await import(pathToFileURL(join(root, 'lib', 'src', 'source-control', 'state-store.js')).href);

const routes = new Map();
registerGgRoutes({
	register(spec) {
		routes.set(spec.path, spec.handler);
		return () => {};
	},
});
const handler = routes.get('/dsh-source-control/gg/api');

/** 经真实路由发一条命令。 */
function call(message) {
	return new Promise((resolve, reject) => {
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

/** 度量一次异步调用。 */
async function ms(fn) {
	const started = process.hrtime.bigint();
	const value = await fn();
	return { ms: Number(process.hrtime.bigint() - started) / 1e6, value };
}

/** 首屏真实形状：不带 `stashes` 键，贮藏由宿主按 showStashes 自行枚举。 */
const commitsMessage = {
	command: 'loadCommits', branches: null, limit: 200, skip: 0, showTags: true, showRemoteBranches: true,
	includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
	remotes: [], hideRemotes: [],
};

const samples = new Map();
const record = (label, value) => {
	const list = samples.get(label) ?? [];
	list.push(value);
	samples.set(label, list);
};
const cooldown = () => new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS));

// 预热：产物加载与 git 首次调用的开销不进统计。
await call(commitsMessage);
clearDiscoveryCache();
const seeded = await discoverRepositories(repo, {});
const topLevel = seeded.nodes.filter((node) => node.kind === 'repo').map((node) => node.path);
// 首屏走的是宿主按持久化位置取树；这里把位置写进状态文档，使后续采样与真实首屏同形。
writeRepoLocations(repo, topLevel.map((path) => ({ path, name: path.split(/[\\/]/).pop() })));

for (let round = 0; round < rounds; round += 1) {
	await cooldown();
	clearDiscoveryCache();
	record('① 仓库列表：完整扫描（无位置缓存）', (await ms(() => discoverRepositories(repo, {}))).ms);

	await cooldown();
	clearDiscoveryCache();
	record('② 仓库列表：已知位置取树（冷）', (await ms(() => discoverRepositories(repo, { knownRepos: topLevel }))).ms);

	await cooldown();
	clearDiscoveryCache();
	record('③ 仓库列表：首屏实际走法（shallow + 位置）', (await ms(() => discoverWorkspace(repo, { shallow: true }))).ms);

	await cooldown();
	record('④ 更改区：loadWorkingTreeSnapshot', (await ms(() => call({ command: 'loadWorkingTreeSnapshot' }))).ms);

	await cooldown();
	record('⑤ 图形区：loadCommits 首屏', (await ms(() => call(commitsMessage))).ms);

	// 改动前的首屏形状：先等仓库树定下选中仓库，再并行取更改区与图形区。
	// 浅层化之后仓库树只要 1–2ms，因此这一项与「全并行」的差别只剩调度开销。
	await cooldown();
	clearDiscoveryCache();
	record('⑥ 首屏：仓库树串行 + 更改区∥图形区', (await ms(async () => {
		await discoverWorkspace(repo, { shallow: true });
		await Promise.all([call(commitsMessage), call({ command: 'loadWorkingTreeSnapshot' })]);
	})).ms);

	// 改动前的完整路径：按已知位置取树时逐个仓库枚举工作树与子模块，这才是首屏空白的主因。
	await cooldown();
	clearDiscoveryCache();
	record('⑦ 首屏：旧路径（完整取树串行 + 两区并行）', (await ms(async () => {
		await discoverRepositories(repo, { knownRepos: topLevel });
		await Promise.all([call(commitsMessage), call({ command: 'loadWorkingTreeSnapshot' })]);
	})).ms);
}

/** 输出一组样本的统计。 */
function stat(list) {
	const sorted = [...list].sort((a, b) => a - b);
	const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
	return 'min ' + sorted[0].toFixed(1) + 'ms  mean ' + mean.toFixed(1) + 'ms  max ' + sorted[sorted.length - 1].toFixed(1) + 'ms';
}

console.log('仓库：' + repo);
console.log('轮数：' + rounds + '  采样间隔：' + COOLDOWN_MS + 'ms');
for (const [label, list] of samples) console.log(label.padEnd(38) + stat(list));

const meanOf = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
const before = samples.get('⑦ 首屏：旧路径（完整取树串行 + 两区并行）');
const after = samples.get('⑥ 首屏：仓库树串行 + 更改区∥图形区');
console.log('首屏空白减少：' + (meanOf(before) - meanOf(after)).toFixed(1) + 'ms（'
	+ ((1 - meanOf(after) / meanOf(before)) * 100).toFixed(1) + '%）');
