/**
 * 差异页的评论引用：把「哪个文件的哪几行、在哪一侧」写成一段可直接交给模型的定位文本。
 *
 * 定位的关键是「行号属于哪个版本」。同一个行号在工作区、暂存区与某个提交里含义不同，
 * 因此引用里必须带上作用域：提交哈希、工作区或暂存区。旧侧行号另外标明它编号的是哪
 * 一侧的内容。
 */

import type { GitDiffScope } from './resource-path.ts';

/** 引用里被评论的那几行。 */
export interface CommentRange {
	/** 注释所在的一侧：新侧（改动后）或旧侧（改动前）。 */
	readonly side: 'L' | 'R';
	/** 起始行号，闭区间。 */
	readonly startLine: number;
	/** 结束行号，闭区间；单行时等于 {@link startLine}。 */
	readonly endLine: number;
}

/**
 * 作用域在引用里的写法。
 *
 * @param scope - 比较作用域。
 * @returns 一句描述，例如 `提交 abc1234`、`工作区`、`暂存区`。
 */
export function scopeLabel(scope: GitDiffScope): string {
	if (scope.kind === 'worktree') return scope.staged ? '暂存区' : '工作区';
	if (scope.kind === 'commit') return `提交 ${scope.hash.slice(0, 7)}`;
	return `提交 ${scope.baseHash.slice(0, 7)} → ${scope.hash.slice(0, 7)}`;
}

/**
 * 行号在引用里的来源说明。
 *
 * 新侧行号就是该版本文件的行号；旧侧行号编号的是改动前的内容，只出现在差异里，
 * 因此要说明它对应哪一个版本。
 *
 * @param scope - 比较作用域。
 * @param side - 注释所在的一侧。
 * @returns 行号来源的说明。
 */
function sideNote(scope: GitDiffScope, side: CommentRange['side']): string {
	if (side === 'R') return '（行号为该版本文件的行号）';
	if (scope.kind === 'commit') return `（行号为改动前的提交 ${scope.hash.slice(0, 7)}~1 的行号）`;
	if (scope.kind === 'compare') return `（行号为改动前侧 ${scope.baseHash.slice(0, 7)} 的行号）`;
	return '（行号为改动前内容的行号）';
}

/**
 * 构造评论引用正文。
 *
 * 顺序是「版本 → 文件地址 → 行号」，形如 `工作区 Docs/实现/代码结构.md 第 12-14 行`：
 * 版本在前，读到的人先知道行号属于哪一份内容，再看是哪个文件的哪些行。旧侧追加行号
 * 来源说明。
 *
 * @param path - 文件路径，相对仓库根。
 * @param scope - 比较作用域。
 * @param range - 被评论的行。
 * @returns 一行定位文本。
 */
export function commentReference(path: string, scope: GitDiffScope, range: CommentRange): string {
	const lines = range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`;
	const where = range.side === 'R' ? '' : ` 旧侧${sideNote(scope, range.side)}`;
	return `${scopeLabel(scope)} ${path} 第 ${lines} 行${where}`;
}

/**
 * 构造评论的引用：一行定位，必要时接用户正文。
 *
 * 只给行号，不给代码片段：定位到具体版本与行号后，模型按需自己读文件，
 * 比把片段抄进消息更省 token，也不会因为片段过期而与实际内容不符。
 *
 * @param path - 文件路径，相对仓库根。
 * @param scope - 比较作用域。
 * @param range - 被评论的行。
 * @param body - 用户写的评论正文；空白时不追加正文。
 * @returns 可插入对话输入框的文本。
 */
export function formatCommentQuote(path: string, scope: GitDiffScope, range: CommentRange, body: string): string {
	const header = commentReference(path, scope, range);
	const note = body.trim();
	return note === '' ? header : `${header}\n${note}`;
}
