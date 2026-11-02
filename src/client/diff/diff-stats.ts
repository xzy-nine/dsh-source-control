/**
 * 差异行数统计：从 hunk 行前缀数出新增与删除的行数。
 *
 * 头部计数只反映渲染所用的 hunk，因此与逐行显示的内容始终一致。
 */

/** 一组 hunk 的新增与删除行数。 */
export interface DiffStats {
	/** `+` 开头的行数。 */
	readonly added: number;
	/** `-` 开头的行数。 */
	readonly deleted: number;
}

/**
 * 统计一组 hunk 的新增与删除行数。
 *
 * @param hunks - 待统计的 hunk；空数组表示没有改动。
 * @returns 新增与删除的行数。
 */
export function diffStats(hunks: ReadonlyArray<{ readonly lines: readonly string[] }>): DiffStats {
	let added = 0;
	let deleted = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.startsWith('+')) added += 1;
			else if (line.startsWith('-')) deleted += 1;
		}
	}
	return { added, deleted };
}
