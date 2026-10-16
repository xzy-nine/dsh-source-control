/**
 * 刷新耗时度量：仓库已加载后，一次重载（提交图窗口 + 工作区快照）的往返耗时与 git 调用构成。
 *
 * 用法：node scripts/bench-refresh.mjs [仓库路径] [轮数]
 * 依赖宿主产物 lib/src/source-control/routes.js。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
if (!existsSync(routesPath)) {
	console.error('未找到宿主产物，请先 pnpm build:host');
	process.exit(1);
}
const repo = process.argv[2] ?? process.cwd();
const rounds = Math.max(1, Number.parseInt(process.argv[3] ?? '5', 10));
/** 采样间隔：大于宿主只读结果缓存的 200ms TTL。 */
const COOLDOWN_MS = 300;

const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
const routes = new Map();
registerGgRoutes({ register(spec) { routes.set(spec.path, spec.handler); return () => {}; } });
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
		const res = { writeHead() {}, end(text) { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } } };
		Promise.resolve(handler(req, res)).catch(reject);
	});
}
async function ms(fn) {
	const started = process.hrtime.bigint();
	await fn();
	return Number(process.hrtime.bigint() - started) / 1e6;
}
const cooldown = () => new Promise((r) => setTimeout(r, COOLDOWN_MS));

/** 首屏/刷新共用的提交图请求：不带 stashes，宿主自行枚举。 */
const commitsMessage = {
	command: 'loadCommits', branches: null, limit: 200, skip: 0, showTags: true, showRemoteBranches: true,
	includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
	remotes: [], hideRemotes: [],
};

const samples = new Map();
const record = (label, value) => { const l = samples.get(label) ?? []; l.push(value); samples.set(label, l); };

// 先取一次仓库信息，供「刷新复用已知 remotes/stashes」的变体使用。
const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
const remoteNames = (info.remotes ?? []).map((remote) => remote.name);
const stashes = info.stashes ?? [];
/** 刷新时的真实请求：复用已知的 remotes/stashes，不附带仓库信息。 */
const refreshMessage = { ...commitsMessage, withRepoInfo: false, remotes: remoteNames, stashes };
/** 首次进入时的请求：附带仓库信息。 */
const firstMessage = { ...commitsMessage, withRepoInfo: true };

await call(firstMessage);

for (let round = 0; round < rounds; round += 1) {
	// 一次重载 = 提交图窗口 ∥ 工作区快照（客户端 refresh 的两路）。
	await cooldown();
	record('① 一次重载（刷新路径，提交图 ∥ 快照）', await ms(() => Promise.all([
		call(refreshMessage), call({ command: 'loadWorkingTreeSnapshot' }),
	])));

	await cooldown();
	record('② 只取工作区快照（提交图命中客户端窗口缓存）', await ms(() => call({ command: 'loadWorkingTreeSnapshot' })));

	await cooldown();
	record('③ 提交图刷新（withRepoInfo: false）', await ms(() => call(refreshMessage)));

	await cooldown();
	record('④ 提交图首次进入（withRepoInfo: true，旧行为）', await ms(() => call(firstMessage)));

	await cooldown();
	record('⑤ 只取仓库信息', await ms(() => call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] })));

	await cooldown();
	record('⑥ 提交图翻页（skip=200）', await ms(() => call({ ...refreshMessage, skip: 200 })));
}

const stat = (list) => {
	const sorted = [...list].sort((a, b) => a - b);
	const mean = list.reduce((s, v) => s + v, 0) / list.length;
	return 'min ' + sorted[0].toFixed(1) + '  mean ' + mean.toFixed(1) + '  max ' + sorted[sorted.length - 1].toFixed(1) + 'ms';
};
console.log('仓库：' + repo + '  轮数：' + rounds + '  采样间隔：' + COOLDOWN_MS + 'ms');
for (const [label, list] of samples) console.log(label.padEnd(44) + stat(list));

const meanOf = (list) => list.reduce((s, v) => s + v, 0) / list.length;
const before = samples.get('④ 提交图首次进入（withRepoInfo: true，旧行为）');
const after = samples.get('③ 提交图刷新（withRepoInfo: false）');
console.log('提交图刷新相对旧行为减少：' + (meanOf(before) - meanOf(after)).toFixed(1) + 'ms（'
	+ ((1 - meanOf(after) / meanOf(before)) * 100).toFixed(1) + '%）');
