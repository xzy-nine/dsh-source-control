/**
 * 刷新轮次的上下文：随一次请求进入执行层，使每条 git 子进程记到真正发起它的那一轮。
 *
 * 按仓库取计数器在并发轮次下会互相串账：两轮的时间窗重叠时，各自把对方的子进程也计入差值，
 * 汇总因此偏大；而单命令轮次在第一轮收尾后才取基线，差值为零。上下文按异步调用链归属，
 * 两个方向的误差都不存在。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** 一轮刷新在上下文里的登记。 */
export interface RefreshScope {
	/** 该轮已启动的 git 子进程数。 */
	spawns: number;
}

const storage = new AsyncLocalStorage<RefreshScope>();

/**
 * 建一个轮次登记。
 *
 * @returns 计数为 0 的新登记。
 */
export function createRefreshScope(): RefreshScope {
	return { spawns: 0 };
}

/**
 * 在一轮的上下文里执行。
 *
 * @param scope - 该轮的登记。
 * @param fn - 请求处理体。
 * @returns 处理体的结果。
 */
export function runInRefreshScope<T>(scope: RefreshScope, fn: () => Promise<T>): Promise<T> {
	return storage.run(scope, fn);
}

/**
 * 记一次子进程启动到当前轮次；不在任何轮次里时不做任何事。
 *
 * @returns 无。
 */
export function countSpawnInScope(): void {
	const scope = storage.getStore();
	if (scope !== undefined) scope.spawns += 1;
}
