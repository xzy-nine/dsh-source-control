/**
 * 外部变更轮询的判据：连续两次看到同一份签名才算变化已稳定。
 *
 * 克隆等长时间写盘期间，目标目录已出现但还不是仓库，外层仓库的
 * `git status --untracked-files=all` 会把这棵正在增长的目录树整体列为未跟踪文件。
 * 只看「与上次不同」就会在全程每轮触发一次完整重载，因此改为「稳定后才重载」。
 * 本模块无任何导入，供 hook 与单元测试直接使用。
 */

/** 两次自动重载之间的最小间隔（毫秒）。 */
export const AUTO_REFRESH_INTERVAL_MS = 60000;

/** 一次轮询的判定输入。 */
export interface PollGateInput {
	/** 本次轮询看到的工作区签名。 */
	readonly signature: string;
	/** 上一次轮询看到的签名；首次轮询为空串。 */
	readonly lastSeen: string;
	/** 面板当前已加载的签名。 */
	readonly loaded: string;
	/** 上一次自动重载的时间戳；从未重载时为 0。 */
	readonly lastRefreshAt: number;
	/** 当前时间戳。 */
	readonly now: number;
}

/**
 * 本次轮询是否应触发重载。
 *
 * @param input - 见 {@link PollGateInput}。
 * @returns 应重载时为 true。
 */
export function shouldAutoRefresh({ signature, lastSeen, loaded, lastRefreshAt, now }: PollGateInput): boolean {
	// 首次轮询没有上一次观测可比，先记下；只有两次看到同一份签名才认为变化已稳定。
	if (lastSeen === '' || signature !== lastSeen) return false;
	if (signature === loaded) return false;
	return now - lastRefreshAt >= AUTO_REFRESH_INTERVAL_MS;
}
