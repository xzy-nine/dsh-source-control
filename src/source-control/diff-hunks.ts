/**
 * 统一差异（unified diff）的 hunk 解析：把 git 的输出切成逐块内容与行号区间。
 *
 * 差异视图按 hunk 逐块渲染，而不是把整份文件交给前端本地算 diff：
 * 后者在改动量超过本地搜索上限时会退化成整文件「全删全加」。
 * 输出形状与 DSH 的 WorkspaceDiffHunk 一致，供复制来的 FileDiff 直接使用。
 */

/** 一个 hunk：两侧行号区间与带 `+`/`-`/空格前缀的行。 */
export interface DiffHunkText {
	/** 旧侧起始行号（从 1 开始）。 */
	readonly oldStart: number;
	/** 旧侧行数。 */
	readonly oldLines: number;
	/** 新侧起始行号（从 1 开始）。 */
	readonly newStart: number;
	/** 新侧行数。 */
	readonly newLines: number;
	/** 行内容，首字符是 `+`、`-` 或空格。 */
	readonly lines: string[];
}

/** hunk 头，形如 `@@ -1,3 +1,4 @@`；行数可省略（`@@ -1 +1 @@`）。 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 解析 hunk 头。
 *
 * @param line - 以 `@@` 开头的行。
 * @returns 行号区间；无法解析时返回 null。
 */
function parseHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
	const match = HUNK_HEADER.exec(line);
	if (match === null) return null;
	/* 可选捕获组未匹配时对应下标为 undefined。 */
	const groups: ReadonlyArray<string | undefined> = match;
	return {
		oldStart: Number(groups[1]),
		// 省略行数表示 1 行。
		oldLines: groups[2] === undefined ? 1 : Number(groups[2]),
		newStart: Number(groups[3]),
		newLines: groups[4] === undefined ? 1 : Number(groups[4]),
	};
}

/**
 * 解析统一差异为逐块内容。
 *
 * 只读取 hunk：文件头（`diff --git`、`---`、`+++`、`index` 等）在首个 `@@` 之前一律跳过；
 * `\ No newline at end of file` 不进入任何一行。二进制差异没有 hunk，返回空数组。
 *
 * @param diffText - `git diff --no-color` 的输出。
 * @returns 逐块内容，按出现顺序。
 */
export function parseUnifiedDiffHunks(diffText: string): DiffHunkText[] {
	const hunks: DiffHunkText[] = [];
	let current: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } | null = null;

	const flush = (): void => {
		if (current !== null) hunks.push(current);
		current = null;
	};

	// 末尾换行是行终止符而非额外空行，先去掉再切分。
	const body = diffText.endsWith('\n') ? diffText.slice(0, -1) : diffText;
	if (body === '') return hunks;

	for (const line of body.split('\n')) {
		if (line.startsWith('@@')) {
			const header = parseHeader(line);
			if (header === null) continue;
			flush();
			current = { ...header, lines: [] };
			continue;
		}
		// 首个 hunk 之前是文件头，与 hunk 无关。
		if (current === null) continue;
		if (line.startsWith('\\')) continue;
		if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
			current.lines.push(line);
		} else if (line === '') {
			// 空上下文行：git 会带前导空格，这里兜住被去尾的实现。
			current.lines.push(' ');
		}
	}
	flush();
	return hunks;
}
