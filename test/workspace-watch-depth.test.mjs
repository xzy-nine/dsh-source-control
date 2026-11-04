/**
 * 工作区级监视的第二层：给工作区的每个直接子目录各挂一个句柄。
 *
 * 判据取自实机缺口：`ctx.fs.watch` 只观察目录的直接子项，因此「子目录已存在、随后在其中
 * 新建仓库」这一日常场景收不到任何事件（一次性建两层反而能收到第一层）。第二层句柄配合
 * `PROBE_DEPTH` 的判定覆盖深度 2 的仓库。
 *
 * 本文件的用例必须串行：宿主能力是模块级单例，且真实监视句柄由模块级注册表承载。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch as watchFs, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importHostModule } from './lib-import.mjs';
import { serial } from './harness.mjs';

/* 本文件的用例必须串行执行：宿主能力与监视句柄都是模块级单例 */

const runtime = await importHostModule('source-control/host-runtime.js');
const watcher = await importHostModule('source-control/repo-watcher.js');
const { installHostCapabilities, resetHostCapabilities } = runtime;
const { closeRepositoryWatchers, onRepositoryTreeChange, watchWorkspace } = watcher;

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * 按服务名给出假宿主：监视用例只关心 `ctx.fs`，子进程给一个不会被调用的桩。
 *
 * @param fs - 假文件系统服务。
 * @returns 取服务函数。
 */
function hostWith(fs) {
	return (name) => (name === 'fs' ? fs : name === 'subprocess' ? { spawn: () => { throw new Error('本用例不跑子进程'); } } : undefined);
}

/**
 * 等条件成立。
 *
 * @param predicate - 判定函数。
 * @param timeoutMs - 超时毫秒数。
 * @returns 成立时为 true。
 */
async function waitFor(predicate, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((done) => setTimeout(done, 50));
	}
	return false;
}

/**
 * 建一个带提交的仓库。
 *
 * @param dir - 目录。
 * @returns 仓库路径。
 */
function makeRepo(dir) {
	mkdirSync(dir, { recursive: true });
	gitIn(dir, 'init', '-q', '-b', 'main');
	gitIn(dir, 'config', 'user.email', 'watch@example.com');
	gitIn(dir, 'config', 'user.name', 'Watch');
	writeFileSync(join(dir, 'a.txt'), 'a');
	gitIn(dir, 'add', '-A');
	gitIn(dir, 'commit', '-q', '-m', 'first');
	return dir;
}

/**
 * 造一个只观察直接子项的 `ctx.fs`：与本地后端一致（`watch` 无文件名、无类型、不递归）。
 *
 * @returns 服务对象与它当前挂着的目录集合。
 */
function singleLevelFs() {
	const handles = new Map();
	const service = {
		resolve: async (path) => ({ targetKey: path, displayPath: path }),
		stat: async (target) => {
			try {
				const info = statSync(target.displayPath);
				return { type: info.isDirectory() ? 'directory' : 'file', size: info.size };
			} catch {
				return undefined;
			}
		},
		readText: async (target) => readFileSync(target.displayPath, 'utf8'),
		listDir: async (target) => readdirSync(target.displayPath, { withFileTypes: true })
			.map((entry) => ({
				name: entry.name,
				type: entry.isDirectory() ? 'directory' : 'file',
				target: { targetKey: join(target.displayPath, entry.name), displayPath: join(target.displayPath, entry.name) },
			})),
		watch: async (target, changed) => {
			handles.set(target.displayPath, changed);
			// depth 0 且无文件名：本地后端的 chokidar 只报「这个目录变了」。
			const handle = watchFs(target.displayPath, { depth: 0, persistent: false }, () => { changed(); });
			return async () => { handles.delete(target.displayPath); handle.close(); };
		},
	};
	return { service, handles };
}

serial('不支持递归时给工作区的每个直接子目录补挂句柄', async () => {
	const { service, handles } = singleLevelFs();
	installHostCapabilities(hostWith(service));
	const root = mkdtempSync(join(tmpdir(), 'gg-ws-depth-'));
	try {
		mkdirSync(join(root, 'alpha'), { recursive: true });
		mkdirSync(join(root, 'beta'), { recursive: true });
		mkdirSync(join(root, 'node_modules'), { recursive: true });
		writeFileSync(join(root, 'file.txt'), 'x');
		watchWorkspace(root);
		assert.ok(await waitFor(() => handles.has(root)), '根目录应有句柄');
		assert.ok(await waitFor(() => handles.has(join(root, 'alpha'))), '直接子目录 alpha 应有句柄');
		assert.ok(await waitFor(() => handles.has(join(root, 'beta'))), '直接子目录 beta 应有句柄');
		assert.equal(handles.has(join(root, 'node_modules')), false, '剪枝目录不挂句柄');
	} finally {
		closeRepositoryWatchers();
		resetHostCapabilities();
		rmSync(root, { recursive: true, force: true });
	}
});

serial('在已存在的子目录里新建仓库会报告该工作区', async () => {
	// 这一条正是递归降级后失效的场景：一次性建两层能收到第一层，先建目录再建仓库则收不到。
	const { service } = singleLevelFs();
	installHostCapabilities(hostWith(service));
	const root = mkdtempSync(join(tmpdir(), 'gg-ws-nested-'));
	const seen = [];
	const unsubscribe = onRepositoryTreeChange((changed) => { seen.push(changed); });
	try {
		// 目录先存在，句柄因此能在仓库出现之前挂上。
		mkdirSync(join(root, 'existing'), { recursive: true });
		watchWorkspace(root);
		await new Promise((done) => setTimeout(done, 400));
		makeRepo(join(root, 'existing', 'new-repo'));
		assert.ok(await waitFor(() => seen.length > 0), '子目录里新建的仓库应触发结构事件');
		assert.ok(
			seen.every((path) => path.toLowerCase() === root.toLowerCase()),
			'事件给出工作区根',
		);
	} finally {
		unsubscribe();
		closeRepositoryWatchers();
		resetHostCapabilities();
		rmSync(root, { recursive: true, force: true });
	}
});

serial('新建的直接子目录会在下一轮事件后补挂句柄', async () => {
	const { service, handles } = singleLevelFs();
	installHostCapabilities(hostWith(service));
	const root = mkdtempSync(join(tmpdir(), 'gg-ws-late-'));
	try {
		watchWorkspace(root);
		await waitFor(() => handles.has(root));
		// 新子目录出现：根目录的句柄收到事件，合并窗口过后应给它补挂。
		mkdirSync(join(root, 'later'), { recursive: true });
		assert.ok(await waitFor(() => handles.has(join(root, 'later'))), '新出现的子目录应补挂句柄');
		// 子目录消失：句柄要摘掉，否则一直指向不存在的路径。
		rmSync(join(root, 'later'), { recursive: true, force: true });
		assert.ok(await waitFor(() => !handles.has(join(root, 'later'))), '消失的子目录应摘掉句柄');
	} finally {
		closeRepositoryWatchers();
		resetHostCapabilities();
		rmSync(root, { recursive: true, force: true });
	}
});

serial('关闭工作区监视时一并关掉子目录句柄', async () => {
	const { service, handles } = singleLevelFs();
	installHostCapabilities(hostWith(service));
	const root = mkdtempSync(join(tmpdir(), 'gg-ws-close-'));
	try {
		mkdirSync(join(root, 'alpha'), { recursive: true });
		watchWorkspace(root);
		await waitFor(() => handles.has(join(root, 'alpha')));
		closeRepositoryWatchers();
		assert.ok(await waitFor(() => handles.size === 0), '关闭后不应留下任何句柄');
	} finally {
		resetHostCapabilities();
		rmSync(root, { recursive: true, force: true });
	}
});


