/**
 * 条目上限的按树选取：深度更浅的整层优先保留，阈值深度上按目录整块保留。
 *
 * 路径的完整深度按段数计（`a.txt` 为 1、`pkg/sub/a.txt` 为 3）。上限容不下全部条目时：
 * 深度小于阈值的一律保留，阈值深度上按父目录成组保留 —— 一组放不下就跳过该组，
 * 因此不会出现只显示了一半的目录。
 */

/**
 * 路径的完整深度：按 `/` 分隔的段数。
 *
 * @param path - 相对仓库根的路径，`/` 分隔。
 * @returns 段数；空串按 0。
 */
export function pathDepth(path: string): number {
	if (path === '') return 0;
	let depth = 1;
	for (let at = 0; at < path.length; at += 1) {
		if (path.charCodeAt(at) === 47) depth += 1;
	}
	return depth;
}

/**
 * 取路径的父目录；顶层路径的父目录为空串。
 *
 * @param path - 相对仓库根的路径。
 * @returns 父目录路径。
 */
function parentOf(path: string): string {
	const at = path.lastIndexOf('/');
	return at === -1 ? '' : path.slice(0, at);
}

/**
 * 按完整深度保留条目。
 *
 * @param entries - 全部条目。
 * @param limit - 最多保留的条目数。
 * @param pathOf - 取条目路径的函数。
 * @returns 保留下来的条目，顺序与原列表一致。
 */
export function pickByDepth<T>(entries: readonly T[], limit: number, pathOf: (entry: T) => string): T[] {
	const counts = new Map<number, number>();
	for (const entry of entries) {
		const depth = pathDepth(pathOf(entry));
		counts.set(depth, (counts.get(depth) ?? 0) + 1);
	}
	const depths = [...counts.keys()].sort((left, right) => left - right);
	let below = 0;
	let cut = Number.POSITIVE_INFINITY;
	for (const depth of depths) {
		const count = counts.get(depth) ?? 0;
		if (below + count > limit) {
			cut = depth;
			break;
		}
		below += count;
	}
	if (cut === Number.POSITIVE_INFINITY) return [...entries];
	/* 阈值深度上按父目录成组：整组放得下才保留，目录因此不会只显示一半。 */
	const groups = new Map<string, number>();
	for (const entry of entries) {
		if (pathDepth(pathOf(entry)) !== cut) continue;
		const parent = parentOf(pathOf(entry));
		groups.set(parent, (groups.get(parent) ?? 0) + 1);
	}
	const accepted = new Set<string>();
	let remaining = limit - below;
	for (const [parent, size] of groups) {
		if (size > remaining) continue;
		accepted.add(parent);
		remaining -= size;
	}
	/*
	 * 仓库根下的条目不属于任何子目录，不存在「只显示一半的目录」的问题：名额还有剩就按顺序补满。
	 * 子目录里的条目不放宽 —— 一组放不下就整组不留，目录因此不会只显示一半。
	 */
	let spare = remaining;
	const kept: T[] = [];
	for (const entry of entries) {
		const path = pathOf(entry);
		const depth = pathDepth(path);
		if (depth < cut) { kept.push(entry); continue; }
		if (depth !== cut) continue;
		if (accepted.has(parentOf(path))) { kept.push(entry); continue; }
		if (parentOf(path) === '' && spare > 0) { spare -= 1; kept.push(entry); }
	}
	return kept;
}