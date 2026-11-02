/**
 * 丢弃改动的结局提示：把宿主回报的子模块结局与未删除的嵌套仓库拼成一句提示。
 *
 * 子模块条目的丢弃只移动其 HEAD，不清理子模块内部的未提交改动；这些情形必须告知，
 * 否则用户会以为改动已被丢弃。纯函数、无 React 依赖，可直接单测。
 */
import type { DiscardReport, SubmoduleDiscardReport } from '../shared/types.ts';

/** 丢弃结局提示的文案。文案归此处，调用方与测试都按引用取用。 */
export const DISCARD_TEXT = {
	/** 子模块被拒绝移动；`{name}` 为子模块路径。 */
	blocked: '{name} 有未提交的改动，未能移动它指向的提交。',
	/** 子模块尚未初始化；`{name}` 为子模块路径。 */
	uninitialized: '{name} 尚未初始化，未移动它指向的提交。',
	/** 子模块已移动但内部仍有改动；`{name}` 为子模块路径。 */
	movedDirty: '{name} 只移动了它指向的提交，内部的未提交改动未清理。',
	/** 子模块未移动但内部有改动；`{name}` 为子模块路径。 */
	unchangedDirty: '{name} 内部有未提交的改动，未清理。',
	/** 未删除的嵌套仓库；`{names}` 为仓库路径列表。 */
	skippedRepos: '{names} 内是独立仓库，未删除。',
} as const;

/** 一条结局对应的提示。 */
function noticeOfOne(report: SubmoduleDiscardReport): string | null {
	const name = report.path;
	if (report.status === 'blocked') {
		const reason = report.reason === null || report.reason === '' ? '' : `\n${report.reason}`;
		return DISCARD_TEXT.blocked.replace('{name}', name) + reason;
	}
	if (report.status === 'uninitialized') return DISCARD_TEXT.uninitialized.replace('{name}', name);
	if (report.status === 'moved') {
		return report.dirty ? DISCARD_TEXT.movedDirty.replace('{name}', name) : null;
	}
	return report.dirty ? DISCARD_TEXT.unchangedDirty.replace('{name}', name) : null;
}

/**
 * 生成一次丢弃的提示文本。
 *
 * @param report - 宿主回报的丢弃结局。
 * @returns 提示文本；无需告知时为空串。
 */
export function discardNoticeOf(report: DiscardReport): string {
	const lines: string[] = [];
	for (const submodule of report.submodules) {
		const line = noticeOfOne(submodule);
		if (line !== null) lines.push(line);
	}
	if (report.skippedRepositories.length > 0) {
		lines.push(DISCARD_TEXT.skippedRepos.replace('{names}', report.skippedRepositories.join('、')));
	}
	return lines.join('\n');
}
