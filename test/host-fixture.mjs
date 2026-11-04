/**
 * 测试用的宿主能力替身：用 Node 原生实现填满 `ctx.fs` 与 `ctx.subprocess` 的能力面。
 *
 * 生产代码没有原生回退，缺少服务即装载失败；测试进程没有宿主，因此由 `setup.mjs` 装这一套，
 * 让既有用例继续在真实文件系统与真实子进程上跑。契约面（`watch` 不给名字与类型、`spawn`
 * 走受管范围）由 `host-runtime.test.mjs` 用更精确的假服务单独验证。
 */
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { watch as watchFs } from 'node:fs';
import { join } from 'node:path';

/** 测试进程里每个受管子进程的宽限毫秒数。 */
const GRACE_MS = 1000;

/** 测试进程里每个受管子进程的内存收集上限。 */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * 造一个基于 Node 原生实现的 `ctx.fs`。
 *
 * @returns 能力面对象。
 */
export function nodeBackedFs() {
	return {
		resolve: async (path) => ({ targetKey: path, displayPath: path }),
		stat: async (target) => {
			try {
				const info = await stat(target.displayPath);
				return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size, version: String(info.mtimeMs) };
			} catch {
				return undefined;
			}
		},
		readText: async (target) => readFile(target.displayPath, 'utf8'),
		listDir: async (target) => (await readdir(target.displayPath, { withFileTypes: true })).map((entry) => ({
			name: entry.name,
			type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
			target: { targetKey: join(target.displayPath, entry.name), displayPath: join(target.displayPath, entry.name) },
		})),
		watch: async (target, changed, signal) => {
			const handle = watchFs(target.displayPath, { depth: 0, persistent: false }, () => { changed(); });
			handle.on('error', (error) => { changed(error); });
			const close = async () => { handle.close(); };
			signal.addEventListener('abort', () => { void close(); }, { once: true });
			return close;
		},
	};
}

/**
 * 造一个基于 Node 原生实现的 `ctx.subprocess`。
 *
 * 只实现收集模式：`spawn` 返回受管句柄，`terminate` 终止整棵进程树。
 *
 * @returns 能力面对象。
 */
export function nodeBackedSubprocess() {
	return {
		spawn(spec) {
			const [command, ...args] = spec.argv;
			const child = spawn(command, args, {
				cwd: spec.cwd,
				windowsHide: true,
				env: spec.env === undefined ? process.env : { ...process.env, ...spec.env },
			});
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => { stdout += chunk; });
			child.stderr.on('data', (chunk) => { stderr += chunk; });
			if (spec.stdio.stdin !== 'ignore' && typeof spec.stdio.stdin === 'object') child.stdin.end(spec.stdio.stdin.data);
			else child.stdin.end();
			child.stdin.on('error', () => { /* 子进程提前关闭标准输入 */ });
			const done = new Promise((resolve, reject) => {
				child.on('error', reject);
				child.on('close', (code) => { resolve({ exitCode: code === null ? -1 : code, signal: null }); });
			});
			spec.signal?.addEventListener('abort', () => {
				if (process.platform === 'win32' && child.pid !== undefined) {
					spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
					return;
				}
				try { child.kill(); } catch { /* 进程已退出 */ }
			}, { once: true });
			/*
			 * 读取必须取实时值：收集在子进程结束时才完成，闭包里捕获的字符串只是 spawn 那一刻的
			 * 快照，读到的一律是空串。
			 */
			const reader = (current) => ({ readFrom: () => {
				const text = current();
				return { text, nextOffset: text.length, lossy: false };
			} });
			return {
				collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
				done,
				terminate: () => {
					if (process.platform === 'win32' && child.pid !== undefined) {
						spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
						return;
					}
					try { child.kill(); } catch { /* 进程已退出 */ }
				},
			};
		},
	};
}

/** 受管范围的宽限毫秒数；与生产取值一致。 */
export { GRACE_MS, MAX_BYTES };
