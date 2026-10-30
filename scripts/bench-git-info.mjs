/**
 * 取数耗时度量：请求 → 数据到手这一段的 git 子进程数、文件系统次数与墙钟。
 *
 * 用法：node scripts/bench-git-info.mjs [仓库路径] [轮数]
 * 依赖宿主产物 lib/src/source-control/routes.js（先 pnpm build:host）。
 *
 * 导入路由之前包裹 `child_process.spawn` 与 `fs/promises` 的 `readFile` / `stat` / `readdir`，
 * 再 `syncBuiltinESMExports()` 让 ESM 具名导入看到替换。每个场景前作废宿主缓存并空转，越过
 * `runGit` 的 200ms 结果缓存。
 */
import cp from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');
if (!existsSync(routesPath)) {
	console.error('未找到宿主产物，请先 pnpm build:host');
	process.exit(1);
}
const repo = process.argv[2] ?? process.cwd();
const rounds = Math.max(1, Number.parseInt(process.argv[3] ?? '3', 10));
/** 采样间隔：大于宿主只读结果缓存的 200ms TTL。 */
const COOLDOWN_MS = 350;

/** git 子进程记录：[命令, ...参数]。 */
const spawns = [];
/** 文件系统调用记录：{ kind, path }。 */
const fsCalls = [];

const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
	spawns.push([command, ...(Array.isArray(args) ? args : [])].map(String));
	return originalSpawn(command, args, options);
};
for (const kind of ['readFile', 'stat', 'readdir']) {
	const original = fs[kind];
	fs[kind] = (...args) => {
		fsCalls.push({ kind, path: String(args[0]) });
		return original(...args);
	};
}
syncBuiltinESMExports();

const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
const routes = new Map();
registerGgRoutes({ register(spec) { routes.set(spec.path, spec.handler); return () => {}; } });
const handler = routes.get('/dsh-source-control/gg/api');

/**
 * 经真实路由发一条命令。
 *
 * @param message - 命令载荷；`repo` 缺省为被测仓库。
 * @returns 响应载荷。
 */
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
const cooldown = () => new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS));

/**
 * 一次常规刷新：提交图（已知远程与贮藏）∥ 工作区快照。
 *
 * @param remotes - 已知远程名。
 * @param stashes - 已知贮藏列表。
 * @param skip - 分页偏移。
 * @returns 提交图取数请求。
 */
const refreshMessage = (remotes, stashes, skip = 0) => ({
	command: 'loadCommits', branches: null, limit: 200, skip, showTags: true, showRemoteBranches: true,
	includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
	withRepoInfo: false, remotes, stashes, hideRemotes: [],
});

/** 首屏请求：随提交图一并取回仓库信息，远程与贮藏由宿主自行读取。 */
const firstPaintMessage = {
	command: 'loadCommits', branches: null, limit: 200, skip: 0, showTags: true, showRemoteBranches: true,
	includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'topo',
	withRepoInfo: true, hideRemotes: [],
};

/**
 * 判定一次文件系统调用是否落在 git 目录内。
 *
 * @param entry - 调用记录。
 * @returns 落在 `.git` 下时为 true。
 */
function inGitDir(entry) {
	return /(^|[\\/])\.git([\\/]|$)/.test(entry.path) || entry.path.endsWith('.git');
}

/**
 * 度量一次场景：作废缓存、空转、预热，记录子进程、文件系统调用与墙钟。
 *
 * @param label - 场景名。
 * @param fn - 场景主体，计时与计数只覆盖这一段。
 * @param warm - 预热段，不计入结果。
 * @returns 一次采样。
 */
async function measure(label, fn, warm) {
	await call({ command: 'invalidateCache' });
	await cooldown();
	if (warm !== undefined) {
		await warm();
		// 预热后同样空转：否则样本会命中 `runGit` 的 200ms 结果缓存与 500ms 快照缓存。
		await cooldown();
	}
	const spawnFrom = spawns.length;
	const fsFrom = fsCalls.length;
	const started = process.hrtime.bigint();
	await fn();
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	const git = spawns.slice(spawnFrom).filter(([command]) => command === 'git');
	const files = fsCalls.slice(fsFrom);
	return {
		label, ms,
		git: git.length,
		fs: files.length,
		gitDir: files.filter(inGitDir).length,
		detail: git.map(([, ...args]) => args.filter((arg) => !arg.startsWith('-')).slice(0, 2).join(' ')).join(' | '),
	};
}

/** 取被测仓库的远程名与贮藏，供刷新路径回传已知值。 */
const info = await call({ command: 'loadRepoInfo', showRemoteBranches: true, showStashes: true, hideRemotes: [] });
const remoteNames = (info.remotes ?? []).map((remote) => remote.name);
const stashes = info.stashes ?? [];

/* 仓库树领先/落后：8 个空仓库各一次 for-each-ref 与一次 symbolic-ref 回退。 */
const syncRoot = mkdtempSync(join(tmpdir(), 'gg-bench-sync-'));
process.on('exit', () => rmSync(syncRoot, { recursive: true, force: true }));
const syncRepos = Array.from({ length: 8 }, (_, index) => {
	const dir = join(syncRoot, 'repo-' + index);
	cp.execFileSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8' });
	return dir;
});

/** 首屏取数：提交图（带仓库信息）∥ 工作区快照。 */
const firstPaint = () => Promise.all([call(firstPaintMessage), call({ command: 'loadWorkingTreeSnapshot' })]);
/** 刷新取数：提交图（已知信息）∥ 工作区快照。 */
const refresh = () => Promise.all([call(refreshMessage(remoteNames, stashes)), call({ command: 'loadWorkingTreeSnapshot' })]);

const scenarios = [
	{
		label: '① 首屏：提交图（withRepoInfo）∥ 快照',
		run: firstPaint,
	},
	{
		label: '② 常规刷新：提交图（已知信息）∥ 快照',
		run: refresh,
	},
	{
		label: '③ 空信息仓库刷新：空远程与空贮藏 ∥ 快照',
		// 预热只取仓库信息：连快照一并预热会让样本命中 500ms 的快照缓存。
		warm: () => call(firstPaintMessage),
		run: () => Promise.all([call(refreshMessage([], [])), call({ command: 'loadWorkingTreeSnapshot' })]),
	},
	{
		label: '④ 翻页（skip=200）',
		run: () => call(refreshMessage(remoteNames, stashes, 200)),
	},
	{
		label: '⑤ hooksState 首次（读 core.hooksPath）',
		run: () => call({ command: 'hooksState' }),
	},
	{
		label: '⑥ 8 个仓库的 loadReposSync',
		run: () => call({ command: 'loadReposSync', repos: syncRepos }),
	},
	{
		label: '⑦ 缓存命中：同一窗口的第二次取数',
		warm: () => call(refreshMessage(remoteNames, stashes)),
		run: () => call(refreshMessage(remoteNames, stashes)),
	},
	{
		label: '⑧ 钩子探测命中：同一仓库的第二次 hooksState',
		warm: () => call({ command: 'hooksState' }),
		run: () => call({ command: 'hooksState' }),
	},
];

const samples = new Map();
for (let round = 0; round < rounds; round += 1) {
	for (const scenario of scenarios) {
		const sample = await measure(scenario.label, scenario.run, scenario.warm);
		const list = samples.get(scenario.label) ?? [];
		list.push(sample);
		samples.set(scenario.label, list);
	}
}

const mean = (list, pick) => list.reduce((sum, item) => sum + pick(item), 0) / list.length;
console.log('仓库：' + repo + '  轮数：' + rounds + '  采样间隔：' + COOLDOWN_MS + 'ms');
console.log('场景'.padEnd(46) + 'ms'.padStart(8) + 'git'.padStart(6) + 'fs'.padStart(6) + 'fs(.git)'.padStart(10) + '  命令明细');
for (const [label, list] of samples) {
	const last = list[list.length - 1];
	console.log(
		label.padEnd(44)
		+ mean(list, (item) => item.ms).toFixed(1).padStart(8)
		+ String(Math.round(mean(list, (item) => item.git))).padStart(6)
		+ String(Math.round(mean(list, (item) => item.fs))).padStart(6)
		+ String(Math.round(mean(list, (item) => item.gitDir))).padStart(10)
		+ '  ' + last.detail,
	);
}

/* 与计划第 1 节的判定标准逐条对照。 */
const at = (label) => samples.get(label) ?? [];
const refreshSamples = at('② 常规刷新：提交图（已知信息）∥ 快照');
const emptyInfo = at('③ 空信息仓库刷新：空远程与空贮藏 ∥ 快照');
const hit = at('⑦ 缓存命中：同一窗口的第二次取数');
const hookHit = at('⑧ 钩子探测命中：同一仓库的第二次 hooksState');
console.log('');
console.log('判定标准对照：');
console.log('  1. 常规刷新 git 子进程 3 → 2：' + Math.round(mean(refreshSamples, (item) => item.git))
	+ '，墙钟 ≤60ms：' + mean(refreshSamples, (item) => item.ms).toFixed(1) + 'ms');
console.log('  2. 无远程无贮藏的刷新子进程 4 → 2：' + Math.round(mean(emptyInfo, (item) => item.git)));
console.log('  3. 一次刷新对 .git 的读取 17 → ≤8：' + Math.round(mean(refreshSamples, (item) => item.gitDir)));
console.log('  4. 同一仓库 60 秒内的钩子探测 1 → 0：命中时 ' + Math.round(mean(hookHit, (item) => item.git))
	+ '（首次见 ⑤）');
console.log('  6. 缓存命中 ≤2ms 且 0 个子进程：' + mean(hit, (item) => item.ms).toFixed(1)
	+ 'ms / ' + Math.round(mean(hit, (item) => item.git)) + ' 个子进程');
