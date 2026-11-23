/**
 * 合并窗口定时器：任一时刻最多排一个任务，窗口内的重复请求不延长窗口。
 *
 * 运行时无平台依赖，宿主与客户端各自打包。
 */

/** 合并窗口定时器。 */
export interface CoalesceTimer {
	/** 当前是否已排队。 */
	readonly pending: () => boolean;
	/** 排一次；已在排队时忽略。 */
	readonly schedule: () => void;
	/** 撤掉排队的定时器。 */
	readonly cancel: () => void;
}

/**
 * 建立一个合并窗口定时器。
 *
 * @param delayMs - 合并窗口毫秒数。
 * @param run - 窗口结束后的动作。
 * @param unref - 是否让定时器不阻止进程退出；浏览器半边的定时器没有该能力。
 * @returns 定时器。
 */
export function createCoalesceTimer(delayMs: number, run: () => void, unref = false): CoalesceTimer {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	return {
		pending: () => timer !== undefined,
		schedule: () => {
			if (timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				run();
			}, delayMs);
			if (unref) (timer as unknown as { unref?: () => void }).unref?.();
		},
		cancel,
	};
}
