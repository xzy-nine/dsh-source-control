/**
 * git 失败文本的展示化：把会改写工作区的常见拒绝原因换成可读说明。
 *
 * 匹配依据是 git 的实际措辞；措辞变化时退回原文，不隐藏 git 的输出。
 * 本模块无任何导入，供面板与单元测试直接使用。
 */

/** 一条拒绝原因：匹配 git 措辞的正则与该原因的展示文案。 */
export interface OverwritePattern {
	/** 匹配 git 原文的正则。 */
	readonly pattern: RegExp
	/** 命中时展示的说明。 */
	readonly text: string
}

/** 检出、合并、变基这类会改写工作区的操作。 */
export const OVERWRITE_PATTERNS: ReadonlyArray<OverwritePattern> = [
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
 * 按表查找失败的展示文案。
 *
 * @param patterns - 一张失败原因表。
 * @param error - git 的错误文本。
 * @returns 命中的说明；未命中时返回原文。
 */
function textOfPatterns(patterns: ReadonlyArray<OverwritePattern>, error: string): string {
	for (const entry of patterns) {
		if (entry.pattern.test(error)) return entry.text;
	}
	return error;
}
/** 推送与删除远程分支这类远端往返的失败原因。 */
export const REMOTE_FAILURE_PATTERNS: ReadonlyArray<OverwritePattern> = [
	{
		pattern: /bad repository/i,
		text: '无法解析远程仓库名：请确认该分支所属的远程是否仍然存在，重新抓取后再试。',
	},
	{
		pattern: /does not appear to be a git repository|could not read from remote repository/i,
		text: '无法访问远程仓库：请检查该远程地址、网络与访问权限。',
	},
	{
		pattern: /protected branch|pre-receive hook declined|refusing to delete/i,
		text: '远程拒绝删除该分支：它可能是受保护分支，请在远端解除保护后再试。',
	},
];

/**
 * 把 git 的拒绝原因整理成一句中文说明。
 *
 * @param error - git 的错误文本。
 * @returns 匹配到已知原因时返回中文说明；否则返回原文。
 */
export function checkoutFailureText(error: string): string {
	return textOfPatterns(OVERWRITE_PATTERNS, error);
}

/**
 * 推送与删除远程分支这类远端往返失败的展示化。
 *
 * 远程名解析失败、无法访问远程与远端拒绝删除三类最常见；其余原样返回。
 *
 * @param error - git 的错误文本。
 * @returns 命中已知原因时返回中文说明；否则返回原文。
 */
export function remotePushFailureText(error: string): string {
	return textOfPatterns(REMOTE_FAILURE_PATTERNS, error);
}
