/**
 * 生成结果「上屏」的判据（纯函数）。
 *
 * 上屏指把 AI 生成好的提交信息写进提交框。异步结果可能在任何时刻到达，因此要同时满足：
 * 结果属于当前这个仓库、该仓库的生成已结束、提交框在屏幕上、草稿已读完。缺一条就继续暂存，
 * 等下一次判据变真 —— 否则结果会写进别的仓库，或在草稿读回前被覆盖。
 */

/** 上屏判据的输入。 */
export interface LandingInput {
	/** 生成结果所属的仓库。 */
	readonly generationRepo: string | null;
	/** 当前活跃仓库（提交框所属）。 */
	readonly activeRepo: string | null;
	/** 该仓库的生成是否仍在进行。 */
	readonly busy: boolean;
	/** 是否已有可上屏的文本。 */
	readonly hasText: boolean;
	/** 提交框是否在屏幕上：当前会话 + 侧栏页可见。 */
	readonly onScreen: boolean;
	/** 该仓库的草稿是否已读回。 */
	readonly draftReady: boolean;
}

/**
 * 判断一次生成结果此刻是否可以上屏。
 *
 * @param input - 见 {@link LandingInput}。
 * @returns 可以写入提交框时为 true。
 */
export function canLandGeneration(input: LandingInput): boolean {
	const { generationRepo, activeRepo, busy, hasText, onScreen, draftReady } = input;
	if (generationRepo === null || activeRepo === null) return false;
	// 归属：结果只进发起它的那个仓库的提交框。
	if (generationRepo !== activeRepo) return false;
	if (busy || !hasText) return false;
	return onScreen && draftReady;
}
