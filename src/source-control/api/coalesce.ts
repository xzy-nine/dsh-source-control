/**
 * 并发合并的等待：同一只读命令同时到达时共用一次执行，等不到就交还给调用方自己跑。
 *
 * 超时不产出结果：把「并发合并超时」当载荷投出去，面板会把它当成操作失败弹给用户。只读命令
 * 重跑安全，因此等待方自己执行一遍即可，发起方仍在跑，两者的结果落进同一份缓存。
 */

/**
 * 合并等待的上限（毫秒）。
 *
 * 超过它等待方改为自己执行一遍：某个请求的处理体异常退出而没回投时，后来者不能一直挂着。
 */
export const COALESCE_TIMEOUT_MS = 30_000;

/** 等待合并项的哨兵：超时返回它，与「载荷本身」区分开。 */
const TIMED_OUT = Symbol('coalesce-timeout');

/**
 * 等一个在飞的合并项，最多等到给定上限。
 *
 * @param inFlight - 在飞项的载荷 Promise。
 * @param timeoutMs - 等待上限毫秒数；省略时用 {@link COALESCE_TIMEOUT_MS}。
 * @returns 载荷；超时为 null。
 */
export async function waitCoalesced<T>(inFlight: Promise<T>, timeoutMs: number = COALESCE_TIMEOUT_MS): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => { resolve(TIMED_OUT); }, timeoutMs);
		if (typeof timer.unref === 'function') timer.unref();
	});
	try {
		const result = await Promise.race([inFlight, timeout]);
		return result === TIMED_OUT ? null : result;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
