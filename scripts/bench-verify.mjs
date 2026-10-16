/**
 * 刷新耗时度量：经真实路由 handler 度量提交图与工作区读取的耗时。
 *
 * 用法：node scripts/bench-verify.mjs [仓库路径] [轮数]
 * 依赖宿主产物 lib/src/source-control/routes.js。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
if (!existsSync(routesPath)) {
	console.error('未找到宿主产物：' + routesPath);
	process.exit(1);
}
/** 只含数字的参数按轮数解释，便于直接写 node scripts/bench-verify.mjs 3。 */
const isCount = (value) => value !== undefined && /^\d+$/.test(value);
const first = process.argv[2];
const second = process.argv[3];
const repo = first === undefined || isCount(first) ? process.cwd() : first;
const rounds = Math.max(1, Number.parseInt(isCount(first) ? first : (second ?? '3'), 10));

/** 注册真实路由并返回发请求的函数。 */
async function makeCaller() {
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

const call = await makeCaller();
const commitsMessage = {
	command: 'loadCommits', branches: null, limit: 200, skip: 0, showTags: true, showRemoteBranches: true,
	includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
	remotes: [], hideRemotes: [], stashes: [],
};

/**
 * 采样冷却（毫秒）。
 *
 * `runGit` 对只读命令有 200ms 的结果缓存；相邻采样间隔小于该 TTL 时后一次会命中缓存，
 * 读数偏小且不可复现。冷却取 300ms 以稳定越过该 TTL。
 */
const SAMPLE_COOLDOWN_MS = 300;

/**
 * 度量一次请求；返回耗时毫秒与响应。
 *
 * 冷却发生在计时区间之外，不计入耗时。
 *
 * @param message - 请求载荷。
 * @returns 耗时与响应。
 */
async function time(message) {
	await sleep(SAMPLE_COOLDOWN_MS);
	const started = process.hrtime.bigint();
	const result = await call(message);
	return { ms: Number(process.hrtime.bigint() - started) / 1e6, result };
}

const samples = new Map();
const record = (label, ms) => {
	const list = samples.get(label) ?? [];
	list.push(ms);
	samples.set(label, list);
};

// 预热：让产物加载与 git 首次调用的开销不进入统计。
await time(commitsMessage);

let lastCommits = null;
for (let round = 0; round < rounds; round += 1) {
	const single = await time(commitsMessage);
	lastCommits = single.result;
	record('loadCommits(limit 200, skip 0) 单次往返', single.ms);

	record('loadWorkingTreeSnapshot', (await time({ command: 'loadWorkingTreeSnapshot' })).ms);
	record('loadWorkingTree', (await time({ command: 'loadWorkingTree' })).ms);

	// 旧路径代理：仓库信息与提交图分两次往返、串行等待。
	const info = await time({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
	const after = await time({
		...commitsMessage,
		remotes: (info.result.remotes ?? []).map((remote) => remote.name),
		stashes: info.result.stashes ?? [],
	});
	record('loadRepoInfo + loadCommits 两次串行（旧路径代理）', info.ms + after.ms);
}

const stat = (list) => {
	const sorted = [...list].sort((left, right) => left - right);
	const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
	return 'min ' + sorted[0].toFixed(1) + 'ms  mean ' + mean.toFixed(1) + 'ms  max ' + sorted[sorted.length - 1].toFixed(1) + 'ms';
};

console.log('仓库：' + repo);
console.log('轮数：' + rounds);
for (const [label, list] of samples) console.log(label.padEnd(44) + stat(list));

const commits = lastCommits.commits ?? [];
const count = (predicate) => commits.filter(predicate).length;
console.log('commits 条数：' + commits.length);
console.log('标记摘要：heads ' + count((commit) => (commit.heads ?? []).length > 0)
	+ ' / tags ' + count((commit) => (commit.tags ?? []).length > 0)
	+ ' / remotes ' + count((commit) => (commit.remotes ?? []).length > 0)
	+ ' / stash ' + count((commit) => commit.stash !== null && commit.stash !== undefined)
	+ ' / 伪提交 ' + count((commit) => commit.hash === '*'));
console.log('head：' + lastCommits.head);
console.log('moreCommitsAvailable：' + lastCommits.moreCommitsAvailable);
try {
	const baseline = execFileSync('git', ['log', '--topo-order', '--max-count=200', '--format=%H', '--branches', '--tags', '--remotes', 'HEAD', '--'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
		.split('\n').filter((line) => line !== '').length;
	console.log('git log 基线条数：' + baseline);
} catch (error) {
	console.log('git log 基线读取失败：' + String(error));
}
