/**
 * git 失败文本的展示化：把会改写工作区的常见拒绝原因换成可读说明。
 *
 * 匹配依据是 git 的实际措辞；措辞变化时退回原文，不隐藏 git 的输出。
 * 本模块无任何导入，供面板与单元测试直接使用。
 */

/** 检出、合并、变基这类会改写工作区的操作。 */
const OVERWRITE_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly text: string }> = [
	{
		pattern: /Your local changes to the following files would be overwritten by (?:checkout|merge|rebase)/i,
		text: '本地未提交的改动会被该操作覆盖：请先提交或贮藏这些改动，再重试。',
	},
	{
		pattern: /Your local changes to the following files would be overwritten/i,
		text: '本地未提交的改动会被该操作覆盖：请先提交或贮藏这些改动，再重试。',
	},
	{
		pattern: /untracked working tree files would be overwritten|untracked working tree files would be removed/i,
		text: '未跟踪的文件会被该操作覆盖或删除：请先移动、提交或删除它们，再重试。',
	},
	{
		pattern: /You have not concluded your merge|MERGE_HEAD exists/i,
		text: '当前有一次未完成的合并：请先提交或中止合并，再重试。',
	},
	{
		pattern: /rebase in progress|It seems that there is already a rebase-merge directory/i,
		text: '当前有一次未完成的变基：请先继续或中止变基，再重试。',
	},
	{
		pattern: /you need to resolve your current index first|Unmerged paths/i,
		text: '暂存区里还有未解决的冲突：请先解决冲突并提交，再重试。',
	},
	{
		pattern: /already exists/i,
		text: '同名本地分支已存在：请换一个分支名，或先检出该分支。',
	},
];

/**
 * 把 git 的拒绝原因整理成一句中文说明。
 *
 * @param error - git 的错误文本。
 * @returns 匹配到已知原因时返回中文说明；否则返回原文。
 */
export function checkoutFailureText(error: string): string {
	for (const entry of OVERWRITE_PATTERNS) {
		if (entry.pattern.test(error)) return entry.text;
	}
	return error;
}
