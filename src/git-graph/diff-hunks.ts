/**
 * 统一差异（unified diff）的 hunk 解析：把 git 的输出切成逐块的新旧两侧内容。
 *
 * 差异视图按 hunk 逐块渲染，而不是把整份文件交给前端本地算 diff：
 * 后者在改动量超过本地搜索上限时会退化成整文件「全删全加」。
 */

/** 一个 hunk 的新旧两侧内容（含各自的上下文行）。 */
export interface DiffHunkText {
	/** 旧侧内容：上下文行与删除行。 */
	readonly oldText: string;
	/** 新侧内容：上下文行与新增行。 */
	readonly newText: string;
}

/** hunk 头，形如 `@@ -1,3 +1,4 @@`。 */
const HUNK_HEADER = /^@@ /;

/**
 * 解析统一差异为逐块的新旧内容。
 *
 * 只读取 hunk：文件头（`diff --git`、`---`、`+++`、`index` 等）在首个 `@@` 之前一律跳过；
 * `\ No newline at end of file` 不进入任何一侧。二进制差异没有 hunk，返回空数组。
 *
 * @param diffText - `git diff --no-color` 的输出。
 * @returns 逐块的新旧内容，按出现顺序。
 */
export function parseUnifiedDiffHunks(diffText: string): DiffHunkText[] {
	const hunks: DiffHunkText[] = [];
	let oldLines: string[] | null = null;
	let newLines: string[] | null = null;

	const flush = (): void => {
		if (oldLines !== null && newLines !== null) {
			hunks.push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') });
		}
		oldLines = null;
		newLines = null;
	};

	// 末尾换行是行终止符而非额外空行，先去掉再切分。
	const body = diffText.endsWith('\n') ? diffText.slice(0, -1) : diffText;
	if (body === '') return hunks;

	for (const line of body.split('\n')) {
		if (HUNK_HEADER.test(line)) {
			flush();
			oldLines = [];
			newLines = [];
			continue;
		}
		// 首个 hunk 之前是文件头，与 hunk 无关。
		if (oldLines === null || newLines === null) continue;
		if (line.startsWith('\\')) continue;
		if (line.startsWith('+')) {
			newLines.push(line.slice(1));
		} else if (line.startsWith('-')) {
			oldLines.push(line.slice(1));
		} else if (line.startsWith(' ')) {
			const text = line.slice(1);
			oldLines.push(text);
			newLines.push(text);
		} else if (line === '') {
			// 空上下文行：git 会带前导空格，这里兜住被去尾的实现。
			oldLines.push('');
			newLines.push('');
		}
	}
	flush();
	return hunks;
}
