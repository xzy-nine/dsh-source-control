/**
 * 合并区间：把「基线→我方」与「基线→对方」两组差异对齐成可逐段处理的单元。
 *
 * 这是合并视图的模型层，对应 VS Code 的 `ModifiedBaseRange`：基线里一段被任一方改过的行，
 * 加上两侧各自换成什么。两个差异区间在基线上相交或相邻就并成同一个合并区间，
 * 因此「双方改了同一处」自然落在同一段里，而相隔较远的改动各自成段。
 *
 * 行差异与区间对齐同处一个模块：共享模块不互相 import（两侧的模块解析规则不同），
 * 而这几段只服务合并视图。
 *
 * 纯函数：输入是行数组，输出是区间与取侧后的行。
 */

/** 一处替换：左侧若干行被右侧若干行替代。 */
export interface LineChange {
	/** 左侧起始下标，0 起。 */
	readonly baseStart: number;
	/** 左侧被替换的行数；0 表示纯插入。 */
	readonly baseLength: number;
	/** 右侧起始下标，0 起。 */
	readonly otherStart: number;
	/** 右侧用于替换的行数；0 表示纯删除。 */
	readonly otherLength: number;
}

/** 中段做 LCS 的行数预算：超过则整段按一次替换处理，避免大文件卡死。 */
const LCS_BUDGET = 4_000_000;

/**
 * 把文本切成行。
 *
 * @param text - 全文。
 * @returns 行数组；末尾换行不产生额外空行。
 */
export function linesOf(text: string): string[] {
	if (text === '') return [];
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * 计算两份行的替换区间。
 *
 * 先剥公共前后缀，中段按最长公共子序列对齐；相邻的删除与插入合成一个替换区间。
 *
 * @param base - 左侧的行。
 * @param other - 右侧的行。
 * @returns 替换区间，按左侧下标升序。
 */
export function diffLines(base: readonly string[], other: readonly string[]): LineChange[] {
	let prefix = 0;
	while (prefix < base.length && prefix < other.length && base[prefix] === other[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < base.length - prefix
		&& suffix < other.length - prefix
		&& base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
	) suffix += 1;
	const a = base.slice(prefix, base.length - suffix);
	const b = other.slice(prefix, other.length - suffix);
	if (a.length === 0 && b.length === 0) return [];
	if (a.length === 0) return [{ baseStart: prefix, baseLength: 0, otherStart: prefix, otherLength: b.length }];
	if (b.length === 0) return [{ baseStart: prefix, baseLength: a.length, otherStart: prefix, otherLength: 0 }];
	if (a.length * b.length > LCS_BUDGET) {
		return [{ baseStart: prefix, baseLength: a.length, otherStart: prefix, otherLength: b.length }];
	}
	return lcsChanges(a, b, prefix, suffix);
}

/**
 * 对中段求最长公共子序列并回溯成替换区间。
 *
 * 回溯按「相同就前进，不同则按长度表决定丢哪一侧」走；连续的丢左 / 丢右收成同一段，
 * 因此一处替换不会拆成「先删后插」两条记录。
 *
 * @param a - 左侧中段。
 * @param b - 右侧中段。
 * @param offset - 公共前缀长度。
 * @param suffix - 公共后缀长度；用于把右侧下标还原到全文坐标系。
 * @returns 替换区间。
 */
function lcsChanges(a: readonly string[], b: readonly string[], offset: number, suffix: number): LineChange[] {
	const n = a.length;
	const m = b.length;
	// 长度表：table[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度。
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			table[i * width + j] = a[i] === b[j]
				? table[(i + 1) * width + j + 1] + 1
				: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	const changes: LineChange[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) { i += 1; j += 1; continue; }
		const startI = i;
		const startJ = j;
		// 到达一个「匹配」或中段尽头为止，把这一整块收成一处替换。
		while (i < n || j < m) {
			if (i < n && j < m && a[i] === b[j]) break;
			if (j >= m) { i += 1; continue; }
			if (i >= n) { j += 1; continue; }
			if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1;
			else j += 1;
		}
		changes.push({
			baseStart: offset + startI,
			baseLength: i - startI,
			otherStart: offset + startJ,
			otherLength: j - startJ,
		});
	}
	void suffix;
	return changes;
}

/** 一方在一个合并区间里的内容。 */
export interface MergeSide {
	/** 该侧在此区间的行；该侧删除时为 0 行。 */
	readonly lines: readonly string[];
	/** 该侧是否改动过这一区间：未改动意味着这一侧就是基线内容。 */
	readonly changed: boolean;
}

/** 一个合并区间。 */
export interface MergeRange {
	/** 区间序号，从 0 开始。 */
	readonly index: number;
	/** 基线里对应的行范围（半开）。 */
	readonly baseStart: number;
	readonly baseLength: number;
	/** 我方。 */
	readonly ours: MergeSide;
	/** 对方。 */
	readonly theirs: MergeSide;
	/** 双方是否都改动过：true 即真正的冲突，false 是只有一侧改动。 */
	readonly conflicting: boolean;
}

/** 一次合并解析的结果。 */
export interface MergeAnalysis {
	/** 基线全文的行。 */
	readonly baseLines: readonly string[];
	/** 各方全文的行，用于取未改动部分的上下文。 */
	readonly oursLines: readonly string[];
	readonly theirsLines: readonly string[];
	/** 各合并区间，按基线位置升序。 */
	readonly ranges: readonly MergeRange[];
}

/**
 * 取出某个引用区间在另一侧对应的行。
 *
 * @param change - 一侧的差异区间。
 * @param otherLines - 该侧全文的行。
 * @returns 该侧在这段基线区间里换上的行。
 */
function sideLinesOf(change: LineChange | null, otherLines: readonly string[]): readonly string[] {
	if (change === null) return [];
	return otherLines.slice(change.otherStart, change.otherStart + change.otherLength);
}

/** 两个半开区间是否相交或相邻。 */
function touches(aStart: number, aLength: number, bStart: number, bLength: number): boolean {
	const aEnd = aStart + aLength;
	const bEnd = bStart + bLength;
	// 纯插入（长度为 0）时按端点相等也算相邻：0 长度区间没有任何行，只可能贴着别的区间。
	if (aLength === 0 && bLength === 0) return aStart === bStart;
	return aStart < bEnd && bStart < aEnd;
}

/**
 * 解析一次三方合并。
 *
 * @param baseText - 基线全文（共同祖先）。
 * @param oursText - 我方全文。
 * @param theirsText - 对方全文。
 * @returns 各合并区间与三方行。
 */
export function analyzeMerge(baseText: string, oursText: string, theirsText: string): MergeAnalysis {
	const baseLines = linesOf(baseText);
	const oursLines = linesOf(oursText);
	const theirsLines = linesOf(theirsText);
	const oursDiffs = diffLines(baseLines, oursLines);
	const theirsDiffs = diffLines(baseLines, theirsLines);

	// 两侧的差异按基线下标归并：相交或相邻的并成一个合并区间。
	const all: { side: 'ours' | 'theirs'; change: LineChange }[] = [
		...oursDiffs.map((change) => ({ side: 'ours' as const, change })),
		...theirsDiffs.map((change) => ({ side: 'theirs' as const, change })),
	].sort((left, right) => left.change.baseStart - right.change.baseStart || left.change.baseLength - right.change.baseLength);

	const groups: { start: number; length: number; ours: LineChange | null; theirs: LineChange | null }[] = [];
	for (const item of all) {
		// 用显式长度判断而不是 `last !== undefined`：oxlint 把「数组末项可能为空」的判空
		// 当成对非空类型的多余检查，而空数组在运行时确实是常态。
		const last = groups.length === 0 ? null : groups[groups.length - 1];
		const start = item.change.baseStart;
		const length = item.change.baseLength;
		if (last !== null && touches(last.start, last.length, start, length)) {
			const end = Math.max(last.start + last.length, start + length);
			last.start = Math.min(last.start, start);
			last.length = end - last.start;
			if (item.side === 'ours') last.ours = mergeChanges(last.ours, item.change);
			else last.theirs = mergeChanges(last.theirs, item.change);
			continue;
		}
		groups.push({
			start,
			length,
			ours: item.side === 'ours' ? item.change : null,
			theirs: item.side === 'theirs' ? item.change : null,
		});
	}

	const ranges = groups.map<MergeRange>((group, index) => ({
		index,
		baseStart: group.start,
		baseLength: group.length,
		ours: { lines: sideLinesOf(group.ours, oursLines), changed: group.ours !== null },
		theirs: { lines: sideLinesOf(group.theirs, theirsLines), changed: group.theirs !== null },
		conflicting: group.ours !== null && group.theirs !== null,
	}));
	return { baseLines, oursLines, theirsLines, ranges };
}

/**
 * 把同一侧在同一合并区间里的多个差异并成一段。
 *
 * @param existing - 已有差异。
 * @param next - 新增差异。
 * @returns 合并后的差异；两侧都是 0 长度时保留先到的。
 */
function mergeChanges(existing: LineChange | null, next: LineChange): LineChange {
	if (existing === null) return next;
	const start = Math.min(existing.otherStart, next.otherStart);
	const end = Math.max(existing.otherStart + existing.otherLength, next.otherStart + next.otherLength);
	return {
		baseStart: Math.min(existing.baseStart, next.baseStart),
		baseLength: Math.max(existing.baseStart + existing.baseLength, next.baseStart + next.baseLength) - Math.min(existing.baseStart, next.baseStart),
		otherStart: start,
		otherLength: end - start,
	};
}

/** 取哪一侧。 */
export type MergeChoice = 'ours' | 'theirs' | 'both' | 'base' | 'none';

/**
 * 取一个区间按选择换上的行。
 *
 * @param range - 合并区间。
 * @param choice - 取哪一侧。
 * @returns 替换进结果的行。
 */
export function linesForChoice(range: MergeRange, choice: MergeChoice): string[] {
	switch (choice) {
		case 'ours': return [...range.ours.lines];
		case 'theirs': return [...range.theirs.lines];
		case 'both': return [...range.ours.lines, ...range.theirs.lines];
		case 'base': return [];
		case 'none': return [];
		default: return [];
	}
}

/**
 * 按各区间当前的选择拼出结果全文。
 *
 * 未给出选择的区间保持基线内容，因此这是一个纯函数视图：调用方每次传入完整选择表，
 * 得到的就是「若现在提交会写成什么」。
 *
 * @param analysis - 解析结果。
 * @param choices - 区间序号到选择；缺省表示尚未处理，保留基线。
 * @returns 结果的行。
 */
export function resultLinesOf(analysis: MergeAnalysis, choices: ReadonlyMap<number, MergeChoice>): string[] {
	const out: string[] = [];
	let at = 0;
	for (const range of analysis.ranges) {
		out.push(...analysis.baseLines.slice(at, range.baseStart));
		const choice = choices.get(range.index);
		if (choice === undefined) {
			out.push(...analysis.baseLines.slice(range.baseStart, range.baseStart + range.baseLength));
		} else if (choice === 'base') {
			out.push(...analysis.baseLines.slice(range.baseStart, range.baseStart + range.baseLength));
		} else {
			out.push(...linesForChoice(range, choice));
		}
		at = range.baseStart + range.baseLength;
	}
	out.push(...analysis.baseLines.slice(at));
	return out;
}