/**
 * 并发上限执行器：按提交顺序启动任务，同时在跑的不超过上限。
 *
 * 与子进程无关，只约束提交节奏；批量取数用它摊平一次下发的全部路径。
 */

/** 限流器的执行形态。 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * 创建一个并发上限执行器。
 *
 * 任务成功或失败都归还额度；归还时若有等待方，额度直接转交给它，等待方因此不与新来的任务
 * 抢同一个空位。
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
