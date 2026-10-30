/**
 * 子进程输出收集：以数组参数直接 spawn、不经 shell，把标准输出与标准错误收成字符串。
 *
 * 无法启动子进程（可执行文件不在 PATH、工作目录不存在）时不抛错，而是以退出码 -1 与错误文本
 * 返回，让调用方的失败处理与子进程自身失败走同一条路径。可选超时到点即结束子进程。
 */
import { spawn } from 'node:child_process';

/** 一次子进程调用的结果。 */
export interface ChildResult {
	/** 退出码；子进程无法启动或被超时终止时为 -1。 */
	readonly code: number;
	/** 标准输出（按 UTF-8 解码）。 */
	readonly stdout: string;
	/** 标准错误（按 UTF-8 解码）。 */
	readonly stderr: string;
}

/** 收集一次子进程调用的选项。 */
export interface CollectProcessOptions {
	/** 可执行文件名。 */
	readonly command: string;
	/** 参数数组，按原样传给子进程。 */
	readonly args: readonly string[];
	/** 工作目录；省略时继承父进程。 */
	readonly cwd?: string;
	/** 子进程环境变量；省略时继承父进程。 */
	readonly env?: NodeJS.ProcessEnv;
	/** 超时毫秒数；省略时不设超时。 */
	readonly timeoutMs?: number;
	/** 超时时的错误文本；省略时用通用文案。 */
	readonly timeoutMessage?: string;
	/**
	 * 子进程启动后的登记回调；收尾时按 `onSettled` 撤销登记。
	 *
	 * @param child - 子进程。
	 * @param finish - 以给定结果收尾；重复调用只生效一次。
	 * @param partial - 取当前已收集的输出，供自定义超时文案使用。
	 */
	readonly onChild?: (
		child: ReturnType<typeof spawn>,
		finish: (result: ChildResult) => void,
		partial: () => { stdout: string; stderr: string },
	) => void;
	/** 收尾回调：子进程结束时调用一次，用于撤销登记。 */
	readonly onSettled?: (child: ReturnType<typeof spawn>) => void;
}

/** 限流器的执行形态：按提交顺序启动任务，并发不超过上限。 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * 创建一个并发上限执行器。
 *
 * 任务成功或失败都归还额度；归还时若有等待方，额度直接转交给它，等待方因此不与新来的任务
 * 抢同一个空位。用于批量取数：一次下发全部路径时不会同时压上一批子进程。
 *
 * @param max - 并发上限；小于 1 时按 1 处理。
 * @returns 以限流方式执行任务的函数。
 */
export function createLimiter(max: number): Limiter {
	const limit = Math.max(1, Math.floor(max));
	const waiting: Array<() => void> = [];
	let running = 0;
	/** 归还一个额度：有等待方时直接转交。 */
	const release = (): void => {
		const resume = waiting.shift();
		if (resume !== undefined) { resume(); return; }
		running -= 1;
	};
	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (running >= limit) await new Promise<void>((resolve) => { waiting.push(resolve); });
		else running += 1;
		try {
			return await task();
		} finally {
			release();
		}
	};
}

/**
 * 运行一次子进程并收集输出。
 *
 * @param options - 见 {@link CollectProcessOptions}。
 * @returns 退出码与输出。
 */
export function collectProcess({
	command, args, cwd, env, timeoutMs, timeoutMessage, onChild, onSettled,
}: CollectProcessOptions): Promise<ChildResult> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], { cwd, windowsHide: true, env });
		let stdout = '';
		let stderr = '';
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ChildResult): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			onSettled?.(child);
			resolve(result);
		};
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => {
				child.kill();
				finish({ code: -1, stdout, stderr: stderr !== '' ? stderr : (timeoutMessage ?? `${command} 超时未结束`) });
			}, timeoutMs);
		}
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => { stdout += chunk; });
		child.stderr.on('data', (chunk: string) => { stderr += chunk; });
		child.on('error', (error: Error) => {
			finish({ code: -1, stdout, stderr: stderr !== '' ? stderr : error.message });
		});
		child.on('close', (code) => {
			finish({ code: code === null ? -1 : code, stdout, stderr });
		});
		onChild?.(child, finish, () => ({ stdout, stderr }));
	});
}
