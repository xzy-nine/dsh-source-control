/**
 * 测试执行拓扑的声明入口：并发级别、临时路径与全局还原。
 *
 * 文件级并行由运行器默认开启，文件内并行默认关闭。哪些文件可以并发执行用例、哪些必须串行，
 * 由测试自己经本模块声明，而不是依赖运行器的默认值：默认值会随 Node 版本与 `--test-isolation`
 * 变化，而共享进程级状态的文件一旦被并发执行就会间歇性失败。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * 把一个文件的用例声明为一个并发执行的组。
 *
 * 只有不共享进程级可变状态的文件可以使用：用例之间不得依赖执行顺序，不得共用临时目录、
 * 固定端口或未还原的全局桩。其余文件保持串行，并用 {@link serial} 显式标注。
 *
 * @param name - 组的名字，出现在 TAP 输出里。
 * @param body - 组内登记用例的函数；收到的 `t` 与 `test` 同形。
 * @param concurrency - 同组用例的并发上限。
 * @returns 组的 Promise。
 */
export function parallel(name, body, concurrency = 4) {
	return test(name, { concurrency }, body);
}

/**
 * 标注一个必须串行执行的用例。
 *
 * 用于依赖进程级单例（真实 `fs.watch` 句柄、`globalThis` 桩、`process.env`）的用例。
 *
 * @param name - 用例名。
 * @param fn - 用例函数。
 * @returns 用例的 Promise。
 */
export function serial(name, fn) {
	return test(name, { concurrency: false }, fn);
}

/**
 * 建一个进程唯一的临时路径。
 *
 * 直接 `join(tmpdir(), '固定名')` 在并行执行时会与兄弟进程撞名；本函数保证每次调用都得到
 * 不同的目录名。
 *
 * @param prefix - 目录名前缀。
 * @returns 目录绝对路径。
 */
export function tempPath(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 记录一组全局的当前值，返回按原值还原的函数。
 *
 * 进程级单例被桩替换后必须还原：不还原时，同进程后续用例看到的是上一个用例留下的桩。
 *
 * @param names - 全局名。
 * @returns 还原函数。
 */
export function snapshotGlobals(names) {
	const saved = new Map();
	for (const name of names) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	return () => {
		for (const [name, descriptor] of saved) {
			if (descriptor === undefined) delete globalThis[name];
			else Object.defineProperty(globalThis, name, descriptor);
		}
	};
}
