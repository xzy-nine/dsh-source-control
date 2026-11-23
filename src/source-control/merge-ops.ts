/**
 * 合并视图的三方取数与按选择写回。
 *
 * 三方文本取自 `git show :1:` / `:2:` / `:3:`，结果由选择表算得并写回工作区；
 * 写回不自动 `add`，索引由调用方显式更新。
 */
import fs from 'node:fs/promises';
import { errorText } from '../shared/error-text.js';
import nodePath from 'node:path';
import { contentAt, worktreeText } from './conflict-ops.js';
import { analyzeMerge, resultLinesOf, type MergeChoice } from '../shared/merge-ranges.js';
import type { MergeContents } from '../shared/merge-contents.js';

export type { MergeContents } from '../shared/merge-contents.js';

/**
 * 取一个路径某个阶段的全文。
 *
 * @param repo - 仓库路径。
 * @param stage - 阶段号，1 为基线、2 为我方、3 为对方。
 * @param path - 文件路径，相对仓库根。
 * @returns 全文；该阶段不存在时为 null。
 */
async function stageText(repo: string, stage: 1 | 2 | 3, path: string): Promise<string | null> {
	return contentAt(repo, path, `:${String(stage)}:`);
}

/**
 * 取一个未合并路径的三方内容。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @returns 三方全文；缺失的一侧为 null。
 */
export async function mergeContentsOf(repo: string, path: string): Promise<MergeContents> {
	const [base, ours, theirs] = await Promise.all([
		stageText(repo, 1, path),
		stageText(repo, 2, path),
		stageText(repo, 3, path),
	]);
	return { base, ours, theirs };
}

/** 一次写回的结果。 */
export interface ApplyMergeOutcome {
	/** 写回后是否仍有未处理的冲突区间。 */
	readonly unresolved: number;
	/** 失败原因；成功为 null。 */
	readonly error: string | null;
}

/**
 * 按选择表算出结果并写回工作区。
 *
 * 选择表只含用户处理过的区间：未给出的区间保留基线内容，与合并编辑器里「尚未处理」一致。
 *
 * 文件写入失败时 `error` 非空，`unresolved` 仍按选择表给出未处理区间数。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根；写入时按 `/` 拆为路径片段。
 * @param choices - 区间序号到选择。
 * @returns 未处理区间数与失败原因。
 */
export async function applyMergeChoices(
	repo: string, path: string, choices: ReadonlyMap<number, MergeChoice>,
): Promise<ApplyMergeOutcome> {
	const contents = await mergeContentsOf(repo, path);
	const base = contents.base ?? '';
	const ours = contents.ours ?? '';
	const theirs = contents.theirs ?? '';
	const analysis = analyzeMerge(base, ours, theirs);
	const unresolved = analysis.ranges.filter((range) => range.conflicting && !choices.has(range.index)).length;
	const lines = resultLinesOf(analysis, choices);
	const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
	try {
		await fs.writeFile(nodePath.join(repo, ...path.split('/')), text, 'utf8');
		return { unresolved, error: null };
	} catch (error) {
		return { unresolved, error: errorText(error) };
	}
}

/**
 * 读一个文件的当前全文，供合并视图在写回前显示。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @returns 全文；不存在时为 null。
 */
export { worktreeText as readWorktreeText };
