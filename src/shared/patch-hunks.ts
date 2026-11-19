/**
 * 补丁块的切分与按块重放：分段暂存、取消暂存与冲突分段取一侧都建立在它上面。
 *
 * `git diff` 的一份补丁由文件头与若干 `@@` 块组成。把某一块单独交回 git
 * （`git apply --cached` 暂存、`--cached -R` 取消暂存）就能只动这一块，
 * 不必整文件进出索引。纯函数：输入输出都是文本，不调用 git。
 */

/** 一个补丁块：`@@` 头与其后的行。 */
export interface PatchHunk {
	/** 块在整个补丁里的下标，从 0 开始。 */
	readonly index: number;
	/** `@@ -a,b +c,d @@` 头，含行尾换行。 */
	readonly header: string;
	/** 块体，每行以空格、`+` 或 `-` 开头；末行保证带换行。 */
	readonly body: string;
	/** 旧侧起始行号。 */
	readonly oldStart: number;
	/** 旧侧行数。 */
	readonly oldLines: number;
	/** 新侧起始行号。 */
	readonly newStart: number;
	/** 新侧行数。 */
	readonly newLines: number;
}

/** 一份切开的补丁：文件头与各块。 */
export interface ParsedPatch {
	/** `diff --git` 起、首个 `@@` 前的全部行；末尾带换行。 */
	readonly header: string;
	/** 各块，按出现顺序。 */
	readonly hunks: readonly PatchHunk[];
}

/** 块头：`@@ -a,b +c,d @@`，行数可省略（表示 1 行）。 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 取块头里的行数；省略时表示 1 行。
 *
 * @param value - 捕获到的行数字符串。
 * @returns 行数。
 */
function countOf(value: string | undefined): number {
	if (value === undefined) return 1;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * 把一份补丁按块切开。
 *
 * 没有 `@@`（二进制差异、纯模式改动、改名）时返回空块表，块级操作对它们无从下手；
 * 二进制文件的行首没有 `@@`，正好落在这里。
 *
 * @param diffText - `git diff --no-color` 的输出。
 * @returns 文件头与各块；不含 hunk 时 `hunks` 为空。
 */
export function parsePatch(diffText: string): ParsedPatch {
	const first = diffText.search(/^@@/m);
	if (first < 0) return { header: diffText, hunks: [] };
	const header = diffText.slice(0, first);
	const parts = diffText.slice(first).split(/^(?=@@)/m);
	const hunks: PatchHunk[] = [];
	for (const [index, part] of parts.entries()) {
		if (!part.startsWith('@@')) continue;
		const newline = part.indexOf('\n');
		if (newline < 0) continue;
		const head = part.slice(0, newline);
		const match = HUNK_HEADER.exec(head);
		if (match === null) continue;
		hunks.push({
			index,
			header: head + '\n',
			// git 要求补丁以换行结束：缺它时整份补丁被判成 corrupt。
			body: part.slice(newline + 1).replace(/\n*$/, '\n'),
			oldStart: Number(match[1]),
			// 可选捕获组未匹配时是 undefined，`Number(undefined)` 为 NaN，因此按 1 行处理。
			oldLines: countOf(match[2]),
			newStart: Number(match[3]),
			newLines: countOf(match[4]),
		});
	}
	return { header, hunks };
}

/**
 * 按块下标重放出一份可交给 `git apply` 的补丁。
 *
 * @param patch - 已切开的补丁。
 * @param indexes - 要保留的块下标。
 * @returns 补丁文本；`indexes` 为空时为空串。
 */
export function patchOf(patch: ParsedPatch, indexes: readonly number[]): string {
	const picked = new Set(indexes);
	const kept = patch.hunks.filter((hunk) => picked.has(hunk.index));
	if (kept.length === 0) return '';
	return patch.header + kept.map((hunk) => hunk.header + hunk.body).join('');
}

/**
 * 把补丁块按行号排在给定的一侧，供左右分栏对照。
 *
 * @param hunks - 补丁块。
 * @returns 各块的旧侧行数、新侧行数与块头，按出现顺序。
 */
export function hunkRanges(hunks: readonly PatchHunk[]): Array<{ readonly oldStart: number; readonly oldLines: number; readonly newStart: number; readonly newLines: number }> {
	return hunks.map((hunk) => ({
		oldStart: hunk.oldStart,
		oldLines: hunk.oldLines,
		newStart: hunk.newStart,
		newLines: hunk.newLines,
	}));
}
