/**
 * 丢弃改动的结局提示：把宿主回报的子模块结局与未删除的嵌套仓库拼成一句提示。
 *
 * 子模块条目的丢弃只移动其 HEAD，不清理子模块内部的未提交改动；这些情形必须告知，
 * 否则用户会以为改动已被丢弃。纯函数、无 React 依赖，可直接单测。
 */
import type { DiscardReport, SubmoduleDiscardReport } from '../shared/types.ts';

/** 一条结局对应的提示。 */
function noticeOfOne(report: SubmoduleDiscardReport): string | null {
	const name = report.path;
	if (report.status === 'blocked') {
		const reason = report.reason === null || report.reason === '' ? '' : `\n${report.reason}`;
		return `${name} 有未提交的改动，未能移动它指向的提交。${reason}`;
	}
	if (report.status === 'uninitialized') return `${name} 尚未初始化，未移动它指向的提交。`;
	if (report.status === 'moved') {
		return report.dirty ? `${name} 只移动了它指向的提交，内部的未提交改动未清理。` : null;
	}
	return report.dirty ? `${name} 内部有未提交的改动，未清理。` : null;
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
		lines.push(`${report.skippedRepositories.join('、')} 内是独立仓库，未删除。`);
	}
	return lines.join('\n');
}
