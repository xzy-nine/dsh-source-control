/**
 * 冲突分段：把三份内容（基线 / 我方 / 对方）切成可逐段处理的片段。
 *
 * 冲突文件在工作区里是带 `<<<<<<< / ======= / >>>>>>>` 标记的全文。逐段处理需要知道
 * 每一段两侧各自是什么，因此这里把工作区全文按标记切开，再逐段取两侧的行：
 * 标记之间的内容就是本次冲突的两侧，标记之外是双方一致的部分。
 *
 * 纯函数：只做行切分与配对，不读文件、不调用 git。
 */

/** 冲突标记的种类。 */
export type ConflictMarker = 'start' | 'separator' | 'end' | 'end-separator';

/** 冲突区间一侧的内容。 */
export interface ConflictSide {
	/** 该侧的行，不含标记行。 */
	readonly lines: readonly string[];
	/** 该侧在标记里的标签，如 `HEAD` 或分支名；无标签为空串。 */
	readonly label: string;
}

/** 一个冲突区间。 */
export interface ConflictSection {
	/** 区间在文件里的序号，从 0 开始。 */
	readonly index: number;
	/** 我方（当前分支）的行。 */
	readonly ours: ConflictSide;
	/** 对方（被合并的一侧）的行。 */
	readonly theirs: ConflictSide;
	/** 基线段的行；diff3 风格标记才有，普通标记为空数组。 */
	readonly base: readonly string[];
	/** 区间起始行在文件里的行号（从 1 开始，指向 `<<<<<<<` 行）。 */
	readonly startLine: number;
	/** 区间结束行在文件里的行号（从 1 开始，指向 `>>>>>>>` 行）。 */
	readonly endLine: number;
}

/** 文件按冲突区间切开后的结果。 */
export interface SplitConflict {
	/** 冲突区间之外的行，按出现顺序；每项是「一段普通行 + 其后紧邻的冲突下标」。 */
	readonly commons: readonly { readonly lines: readonly string[]; readonly nextSection: number | null }[];
	/** 各冲突区间。 */
	readonly sections: readonly ConflictSection[];
	/** 是否识别出冲突标记：为 false 时内容已不是冲突态。 */
	readonly hasMarkers: boolean;
}

/** 起始标记 `<<<<<<< <标签>`。 */
const START = /^<{7}(?:\s+(.*))?$/;
/** 分隔标记，整行七等号。 */
const SEPARATOR = /^={7}$/;
/** diff3 风格的基线分隔，`|||||||`。 */
const BASE_SEPARATOR = /^\|{7}(?:\s+(.*))?$/;
/** 结束标记 `>>>>>>> <标签>`。 */
const END = /^>{7}(?:\s+(.*))?$/;

/**
 * 把带冲突标记的全文切成普通段与冲突区间。
 *
 * 未闭合的标记按普通行处理：用户手改到一半时不能让整份解析失败。
 *
 * @param text - 工作区全文。
 * @returns 普通段与冲突区间。
 */
export function splitConflict(text: string): SplitConflict {
	/*
	 * 换行统一去掉 `\r`：Windows 上 git 写出的行尾是 CRLF，标记行会变成 `"<<<<<<< HEAD\r"`，
	 * 按 `$` 锚定的标记正则匹配不到，整份文件会被当成没有冲突。
	 */
	const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
	// 末尾换行是行终止符，不是额外空行。
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	const commons: { lines: string[]; nextSection: number | null }[] = [];
	const sections: ConflictSection[] = [];
	let pending: string[] = [];
	let at = 0;
	while (at < lines.length) {
		const line = lines[at];
		const start = START.exec(line);
		if (start === null) { pending.push(line); at += 1; continue; }
		/*
		 * 可选捕获组未匹配时运行时是 undefined，而 TS 把 exec 的捕获组一律标成 string：
		 * 这里显式放宽回 string | undefined，让判空在类型与运行时都成立。
		 */
		const label = start[1] as string | undefined;
		const section = readSection(lines, at, label ?? '', sections.length);
		if (section === null) { pending.push(line); at += 1; continue; }
		commons.push({ lines: pending, nextSection: section.section.index });
		pending = [];
		sections.push(section.section);
		at = section.next;
	}
	commons.push({ lines: pending, nextSection: null });
	return { commons, sections, hasMarkers: sections.length > 0 };
}

/**
 * 从起始标记行读出一个完整区间。
 *
 * @param lines - 全文的行。
 * @param from - 起始标记所在下标。
 * @param oursLabel - 起始标记给的标签。
 * @param index - 区间序号。
 * @returns 区间与区间之后的下标；标记不完整时为 null。
 */
function readSection(lines: readonly string[], from: number, oursLabel: string, index: number): { section: ConflictSection; next: number } | null {
	const ours: string[] = [];
	const theirs: string[] = [];
	const base: string[] = [];
	let at = from + 1;
	/** 对方标签：由结束标记给出，读到时写入。 */
	let theirsLabel = '';
	let seenSeparator = false;
	let seenBase = false;
	while (at < lines.length) {
		const line = lines[at];
		const end = END.exec(line);
		if (end !== null) {
			if (!seenSeparator) return null;
			theirsLabel = end[1];
			return {
				section: {
					index,
					ours: { lines: ours, label: oursLabel },
					// 对方的标签由结束标记给出：git 把被合并的一侧名字写在 `>>>>>>>` 后面。
					theirs: { lines: theirs, label: theirsLabel },
					base,
					startLine: from + 1,
					endLine: at + 1,
				},
				next: at + 1,
			};
		}
		const baseSeparator = BASE_SEPARATOR.exec(line);
		if (baseSeparator !== null) {
			seenBase = true;
			at += 1;
			continue;
		}
		if (SEPARATOR.test(line)) {
			seenSeparator = true;
			at += 1;
			continue;
		}
		if (!seenSeparator) { if (seenBase) base.push(line); else ours.push(line); }
		else theirs.push(line);
		at += 1;
	}
	return null;
}

/**
 * 取冲突区间里某一侧的内容行。
 *
 * @param section - 冲突区间。
 * @param side - `ours` 或 `theirs`。
 * @returns 该侧的行。
 */
export function sideLinesOf(section: ConflictSection, side: 'ours' | 'theirs'): readonly string[] {
	return side === 'ours' ? section.ours.lines : section.theirs.lines;
}
