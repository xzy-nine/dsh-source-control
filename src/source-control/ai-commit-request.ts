/**
 * AI 提交请求的组装：被合并入的提交、二进制清单与 diff 三段的拼接与丢弃说明。
 *
 * 纯函数，不读 git、不碰文件系统，因此可以直接单测。
 */
import { AI_COMMIT_PROMPTS, fillPrompt } from './ai-commit-prompts.js';
import type { CollectedDiff, DroppedFile } from './commit-diff.js';

/** 用户可见的丢弃说明里最多列出的文件数；其余按总数说明。 */
export const DROPPED_LIST_MAX = 20;

/**
 * 把未进入提示词的文件列成一段说明。
 *
 * 超长丢弃只在用户可见处报告，不写进提示词：模型看不到这些改动，写进去只会让它猜测内容。
 *
 * @param dropped - 因长度上限未进入提示词的改动。
 * @returns 告警文本；没有丢弃时为空串。
 */
export function droppedNotice(dropped: readonly DroppedFile[]): string {
	if (dropped.length === 0) return '';
	const shown = dropped.slice(0, DROPPED_LIST_MAX).map((file) => file.path);
	const rest = dropped.length - shown.length;
	const suffix = rest > 0 ? ` 等共 ${String(dropped.length)} 个文件` : '';
	return `${String(dropped.length)} 个改动因超出长度上限未纳入生成（文档让位给代码）：${shown.join('、')}${suffix}`;
}

/**
 * 组装用户请求：被合并入的提交在前，其次是二进制文件清单，最后是 diff。
 *
 * 合并提交先给被合并入的历史信息，diff 只作细节补充；二进制文件只给文件名，内容不进提示词。
 *
 * @param collected - 差异收集结果。
 * @param amend - 是否修补上一次提交。
 * @returns 代入占位符后的请求文本。
 */
export function buildCommitRequest(collected: CollectedDiff, amend: boolean): string {
	const sections: string[] = [];
	if (collected.merged.length > 0) {
		const commits = collected.merged.map((commit) => `${commit.hash} ${commit.body}`).join('\n\n');
		sections.push(fillPrompt(AI_COMMIT_PROMPTS.merged, { commits }));
	}
	if (collected.binary.length > 0) {
		sections.push(fillPrompt(AI_COMMIT_PROMPTS.binary, { paths: collected.binary.join('\n') }));
	}
	const template = amend ? AI_COMMIT_PROMPTS.requestAmend : AI_COMMIT_PROMPTS.request;
	sections.push(fillPrompt(template, { diff: collected.diff }));
	return sections.join('\n\n');
}
