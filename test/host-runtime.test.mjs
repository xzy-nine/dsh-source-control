/**
 * 宿主能力面：子进程、文件读取与目录监视的 seam 契约。
 *
 * 判据取自两类回归：能力面只在真实宿主里跑到，测试里若从不装假服务就一行都验不到。这里用
 * 假服务把契约钉住：argv、stdio、graceMs、退出码、截断与终止按 seam 的要求给出，读取与监视
 * 都落到 `ctx.fs`，缺服务时装载即失败。
 *
 * 本文件的用例必须串行：宿主能力是模块级单例，用例之间不得互相看见对方装的服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, watch as watchFs, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importHostModule } from './lib-import.mjs';
import { serial, tempPath } from './harness.mjs';

const runtime = await importHostModule('source-control/host-runtime.js');
const {
	installHostCapabilities, resetHostCapabilities,
	runCollect, terminateAllChildren, readTextAt, statAt, listDirAt, probePathAt, watchDirAt,
} = runtime;

/* 本文件的用例必须串行执行：宿主能力是模块级单例 */

/**
 * 造一个假的 `ctx.subprocess`。
 *
 * 受管范围的结束由用例控制：`hang` 让 done 一直挂着，用例再经 `settle.finish` 决定何时、
 * 以什么退出事实结束它——超时与终止都要能在 done 未结束时被观察到。
 *
 * @param options - 退出码、输出与被截断的流。
 * @returns 服务对象与它收到的 spawn 参数。
 */
function fakeSubprocess(options = {}) {
	const calls = [];
	const terminated = [];
	let settleDone;
	const settle = {
		done: options.hang === true
			? new Promise((resolve) => { settleDone = resolve; })
			: options.reject === undefined
				? Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null })
				: Promise.reject(options.reject),
		finish: (outcome = { exitCode: null, signal: 'SIGTERM' }) => { settleDone?.(outcome); },
	};
	const service = {
		spawn(spec) {
			calls.push(spec);
			const handle = {
				collected: {
					stdout: { readFrom: () => ({ text: options.stdout ?? '', lossy: options.stdoutLossy === true }) },
					stderr: { readFrom: () => ({ text: options.stderr ?? '', lossy: options.stderrLossy === true }) },
				},
				done: settle.done,
				terminate: () => { terminated.push(spec); },
			};
			if (options.onSpawn !== undefined) options.onSpawn(handle, spec);
			return handle;
		},
	};
	return { service, calls, terminated, settle };
}

/**
 * 造一个 `ctx.fs`：目录读取与监视都落到真实文件系统，只有「不给名字与类型」这一条是仿造的
 * ——那正是本地后端的实际行为。
 *
 * @returns 服务对象与它当前挂着的目录集合。
 */
function fakeFs() {
	const handles = new Map();
	const service = {
		resolve: async (path) => ({ targetKey: path, displayPath: path }),
		stat: async (target) => {
			try {
				const info = statSync(target.displayPath);
				return { type: info.isDirectory() ? 'directory' : 'file', size: info.size, version: String(info.mtimeMs) };
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

serial('缺 ctx.fs 时装载即失败', () => {
	resetHostCapabilities();
	assert.throws(
		() => installHostCapabilities((name) => (name === 'subprocess' ? fakeSubprocess().service : undefined)),
		/需要 ctx\.fs/,
		'没有文件系统服务必须报错，不能静默降级',
	);
	resetHostCapabilities();
});

serial('缺 ctx.subprocess 时装载即失败', () => {
	resetHostCapabilities();
	assert.throws(
		() => installHostCapabilities((name) => (name === 'fs' ? fakeFs().service : undefined)),
		/需要 ctx\.subprocess/,
		'没有子进程服务必须报错，不能静默降级',
	);
	resetHostCapabilities();
});

serial('两项都装好后按 seam 契约下发 spawn', async () => {
	const { service: sub, calls } = fakeSubprocess({ stdout: 'graph', exitCode: 0 });
	const { service: fs } = fakeFs();
	installHostCapabilities((name) => (name === 'fs' ? fs : name === 'subprocess' ? sub : undefined));
	try {
		const result = await runCollect({
			command: 'git', args: ['log', '--oneline'], cwd: 'C:/repo', input: 'piped',
			env: { GIT_PAGER: 'cat' }, timeoutMs: 5000,
		});
		assert.equal(result.code, 0);
		assert.equal(result.stdout, 'graph');
		assert.equal(calls.length, 1);
		const spec = calls[0];
		// argv[0] 是可执行文件本身，参数按原样跟在后面：seam 不做 shell 解释。
		assert.deepEqual(spec.argv, ['git', 'log', '--oneline']);
		assert.equal(spec.cwd, 'C:/repo');
		// 每条 stdio 都显式给出：seam 不提供默认值。
		assert.deepEqual(spec.stdio.stdin, { data: 'piped' });
		assert.ok(typeof spec.stdio.stdout === 'object' && spec.stdio.stdout !== null);
		assert.ok(typeof spec.stdio.stderr === 'object' && spec.stdio.stderr !== null);
		assert.ok(Number.isFinite(spec.graceMs) && spec.graceMs > 0, 'graceMs 必须是正的有限值');
		assert.deepEqual(spec.env, { GIT_PAGER: 'cat' });
		assert.ok(spec.signal instanceof AbortSignal, '超时与取消经 abort signal 下发');
	} finally {
		resetHostCapabilities();
	}
});

serial('非零退出码原样给出', async () => {
	const { service: sub } = fakeSubprocess({ exitCode: 128, stderr: 'fatal: not a git repository' });
	installHostCapabilities((name) => (name === 'fs' ? fakeFs().service : name === 'subprocess' ? sub : undefined));
	try {
		const result = await runCollect({ command: 'git', args: ['status'] });
		assert.equal(result.code, 128);
		assert.equal(result.stderr, 'fatal: not a git repository');
	} finally {
		resetHostCapabilities();
	}
});

serial('输出被截断时按失败处理', async () => {
	// git 的解析需要完整输出，截断的尾部会给出错误的提交图，因此不能当成功结果用。
	const { service: sub } = fakeSubprocess({ stdout: 'tail-only', stdoutLossy: true });
	installHostCapabilities((name) => (name === 'fs' ? fakeFs().service : name === 'subprocess' ? sub : undefined));
	try {
		const result = await runCollect({ command: 'git', args: ['log'] });
		assert.equal(result.code, -1);
		assert.equal(result.stdout, 'tail-only');
		assert.match(result.stderr, /上限/);
	} finally {
		resetHostCapabilities();
	}
});

serial('spawn 同步抛错与 done 拒绝都收敛成退出码 -1', async () => {
	const { service: fs } = fakeFs();
	const throwing = { spawn: () => { throw new Error('no such executable'); } };
	installHostCapabilities((name) => (name === 'fs' ? fs : name === 'subprocess' ? throwing : undefined));
	try {
		const result = await runCollect({ command: 'nope', args: [] });
		assert.equal(result.code, -1);
		assert.match(result.stderr, /no such executable/);
	} finally {
		resetHostCapabilities();
	}

	const rejecting = fakeSubprocess({ reject: new Error('provider failed') });
	installHostCapabilities((name) => (name === 'fs' ? fs : name === 'subprocess' ? rejecting.service : undefined));
	try {
		const result = await runCollect({ command: 'git', args: ['status'] });
		assert.equal(result.code, -1);
		assert.match(result.stderr, /provider failed/);
	} finally {
		resetHostCapabilities();
	}
});

serial('超时经 abort signal 结束受管范围', async () => {
	let aborted = false;
	const { service: sub, settle } = fakeSubprocess({
		hang: true,
		onSpawn: (handle, spec) => {
			spec.signal?.addEventListener('abort', () => {
				aborted = true;
				settle.finish();
			});
		},
	});
	installHostCapabilities((name) => (name === 'fs' ? fakeFs().service : name === 'subprocess' ? sub : undefined));
	try {
		const result = await runCollect({ command: 'git', args: ['fetch'], timeoutMs: 20 });
		assert.equal(result.code, -1);
		assert.equal(aborted, true, '超时必须触发 spawn 时给出的 abort signal');
		assert.match(result.stderr, /超时/);
	} finally {
		settle.finish();
		resetHostCapabilities();
	}
});

serial('终止按受管范围下发', async () => {
	const { service: sub, terminated } = fakeSubprocess({ hang: true });
	installHostCapabilities((name) => (name === 'fs' ? fakeFs().service : name === 'subprocess' ? sub : undefined));
	try {
		// 起一个永不结束的受管范围：done 不 resolve，句柄留在登记表里。
		void runCollect({ command: 'git', args: ['status'] });
		await new Promise((done) => setTimeout(done, 20));
		terminateAllChildren();
		assert.equal(terminated.length, 1, '终止应下发给 seam 的 terminate');
	} finally {
		resetHostCapabilities();
	}
});

serial('读取与监视都落到 ctx.fs', async () => {
	const { service: fs, handles } = fakeFs();
	installHostCapabilities((name) => (name === 'fs' ? fs : name === 'subprocess' ? fakeSubprocess().service : undefined));
	const dir = tempPath('gg-runtime-fs-');
	try {
		writeFileSync(join(dir, 'a.txt'), 'hello');
		mkdirSync(join(dir, 'sub'), { recursive: true });
		assert.equal(await readTextAt(join(dir, 'a.txt')), 'hello');
		assert.equal((await statAt(join(dir, 'a.txt')))?.type, 'file');
		assert.equal(await probePathAt(dir), 'directory');
		assert.equal(await probePathAt(join(dir, 'missing')), null);
		assert.equal(await statAt(join(dir, 'missing')), undefined);
		assert.deepEqual((await listDirAt(dir)).map((entry) => entry.name).sort(), ['a.txt', 'sub']);

		const controller = new AbortController();
		const close = await watchDirAt(dir, () => {}, controller.signal);
		assert.ok(handles.has(dir), '监视应落到 seam');
		await close();
		assert.equal(handles.has(dir), false, '关闭也应落到 seam');
	} finally {
		resetHostCapabilities();
	}
});

serial('seam 的监视不提供名字与类型：回调据此给出 null', async () => {
	// 这一条是 repo-watcher 判定的前提：名字为 null 时它走「核对结构状态」那条分支。
	const { service: fs } = fakeFs();
	let captured = null;
	const withWatch = {
		...fs,
		watch: async (_target, changed) => {
			captured = changed;
			return async () => {};
		},
	};
	installHostCapabilities((name) => (name === 'fs' ? withWatch : name === 'subprocess' ? fakeSubprocess().service : undefined));
	try {
		const controller = new AbortController();
		const seen = [];
		await watchDirAt('C:/repo', (error, name, kind) => { seen.push([error ?? null, name, kind]); }, controller.signal);
		assert.equal(typeof captured, 'function');
		captured(undefined);
		assert.deepEqual(seen, [[null, null, null]], 'seam 不给名字与类型，回调按 null 上报');
	} finally {
		resetHostCapabilities();
	}
});
