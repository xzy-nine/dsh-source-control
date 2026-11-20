/**
 * 差异块的切分：把行数过多的 hunk 拆成若干连续小块。
 *
 * forge 的差异渲染按块一次性展开行数组（`rows.push(...hunkRows(hunk))`），展开的实参
 * 个数等于该块的可见行数；单个块的可见行数超过运行时上限时该展开抛 `RangeError`，
 * 渲染随之失败。切分把每个块压在上限以内，两侧行号与渲染结果保持不变：相邻小块首尾
 * 相接，不产生未变更区段的折叠行。
 */
import type { HunkRange } from '../../shared/patch-hunks.ts';

/** 单个差异块允许的可见行数上限。 */
export const MAX_HUNK_LINES = 4000;

/** 带两侧行号区间与行内容的差异块；形状与宿主算出的 hunk 一致。 */
export interface HunkSpan extends HunkRange {
	/** 行内容，首字符是加号、减号或空格；以反斜杠开头的行是「文件末尾无换行」标记。 */
	readonly lines: readonly string[];
}

/** 一个块的进行中状态。 */
interface Accumulator {
	readonly oldStart: number;
	readonly newStart: number;
	oldLines: number;
	newLines: number;
	/** 已装入的行；末尾可能跟着「文件末尾无换行」标记。 */
	readonly lines: string[];
	/** 已装入的可见行数；标记行不计入。 */
	visible: number;
}

/** 「文件末尾无换行」标记行的行首字符。 */
const NO_NEWLINE_MARK = '\\';

/**
 * 把一组差异块切成不超过上限的小块。
 *
 * 两侧行号按行首字符推进：加号只增新侧，减号只增旧侧，空格两者都增，标记行两者都不增
 * 且必须跟随它前一行。可见行数达到上限时在下一条可见行到来时收尾，下一块从当时的两侧
 * 行号起，因此相邻小块首尾相接、行号连续。
 *
 * @param hunks - 原始差异块。
 * @param limit - 每块的可见行数上限。
 * @returns 切分后的块；每项都是新对象。
 */
export function chunkHunks(hunks: readonly HunkSpan[], limit: number = MAX_HUNK_LINES): HunkSpan[] {
	const size = Math.max(1, Math.floor(limit));
	const out: HunkSpan[] = [];
	for (const hunk of hunks) {
		let oldNo = hunk.oldStart;
		let newNo = hunk.newStart;
		let current: Accumulator | null = null;
		/** 收尾当前块。 */
		const flush = (): void => {
			if (current === null) return;
			out.push({
				oldStart: current.oldStart, oldLines: current.oldLines,
				newStart: current.newStart, newLines: current.newLines,
				lines: current.lines,
			});
			current = null;
		};
		for (const line of hunk.lines) {
			const sign = line.charAt(0);
			const marker = sign === NO_NEWLINE_MARK;
			// 满块只在下一条可见行到来时收尾：末尾的标记行仍属于它前面那一行所在的块。
			if (current !== null && current.visible >= size && !marker) flush();
			if (current === null) {
				current = { oldStart: oldNo, newStart: newNo, oldLines: 0, newLines: 0, lines: [], visible: 0 };
			}
			current.lines.push(line);
			// 标记行不推进行号，也不计入上限：它画不出任何行。
			if (sign === '+') { current.newLines += 1; current.visible += 1; newNo += 1; }
			else if (sign === '-') { current.oldLines += 1; current.visible += 1; oldNo += 1; }
			else if (!marker) {
				current.oldLines += 1; current.newLines += 1; current.visible += 1; oldNo += 1; newNo += 1;
			}
		}
		flush();
	}
	return out;
}
