/**
 * 提交框主按钮与提交可用性的判据。
 *
 * 主按钮在「提交 / 同步 / 发布」三者间切换：待合并状态与修补上一次提交都要求提交，
 * 没有暂存改动时同步与发布才有意义。判据写成无 React 依赖的纯函数，便于直接单测。
 */

/** 提交框主按钮的动作。 */
export type PrimaryAction = 'commit' | 'sync' | 'publish';

/** 主按钮判据的输入。 */
export interface PrimaryActionInput {
	/** 工作区没有变更条目。 */
	readonly workAreaEmpty: boolean;
	/** 相对上游有领先或落后。 */
	readonly hasRemoteDiff: boolean;
	/** 当前分支是纯本地分支：有分支、无上游。 */
	readonly isUnpublishedBranch: boolean;
	/** 勾选了修补上一次提交。 */
	readonly amend: boolean;
	/** 处于未完成的合并。 */
	readonly merging: boolean;
}

/**
 * 取主按钮的动作。
 *
 * 待合并状态与修补期间优先提交：两者的唯一可做动作都是提交，让位给同步或发布会让它不可达。
 *
 * @param input - 见 {@link PrimaryActionInput}。
 * @returns 主按钮的动作。
 */
export function primaryActionOf(input: PrimaryActionInput): PrimaryAction {
	if (input.merging || input.amend) return 'commit';
	if (input.workAreaEmpty && input.hasRemoteDiff) return 'sync';
	if (input.isUnpublishedBranch && input.workAreaEmpty) return 'publish';
	return 'commit';
}

/** 提交可用性判据的输入。 */
export interface SubmitAvailabilityInput {
	/** 已暂存的路径数。 */
	readonly stagedCount: number;
	/** 勾选了修补上一次提交。 */
	readonly amend: boolean;
	/** 处于未完成的合并。 */
	readonly merging: boolean;
}

/**
 * 提交是否可用。
 *
 * 有暂存改动、勾选修补、或处于未完成的合并即可提交。待合并状态下索引可能与 HEAD 无差异
 * （冲突已按目标内容解决、或无冲突合并），这次提交仍然必须成立：它是结束合并的唯一动作。
 *
 * @param input - 见 {@link SubmitAvailabilityInput}。
 * @returns 可提交时为 true。
 */
export function canSubmitOf(input: SubmitAvailabilityInput): boolean {
	return input.stagedCount > 0 || input.amend || input.merging;
}

/** 提交按钮禁用判据的输入。 */
export interface CommitButtonDisabledInput {
	/** 该仓库有进行中的提交类操作。 */
	readonly busy: boolean;
	/** 提交可用性，见 {@link canSubmitOf}。 */
	readonly canSubmit: boolean;
	/** 提交信息为空。 */
	readonly messageEmpty: boolean;
	/** 处于未完成的合并。 */
	readonly merging: boolean;
}

/**
 * 提交按钮是否禁用。
 *
 * 合并中不因提交信息为空而禁用：此时空信息表示沿用 git 生成的合并信息（`--no-edit`）。
 *
 * @param input - 见 {@link CommitButtonDisabledInput}。
 * @returns 禁用时为 true。
 */
export function commitButtonDisabledOf(input: CommitButtonDisabledInput): boolean {
	if (input.busy || !input.canSubmit) return true;
	return input.messageEmpty && !input.merging;
}
