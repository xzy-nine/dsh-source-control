/**
 * 变更区的目录树：把带路径的条目组成可折叠的文件树，以及菜单路径的绝对化。
 *
 * 与 React 无关的纯变换，便于直接单测。
 */
import type { WorkingTreeEntry } from '../shared/types.ts';

/** 带路径的树条目：工作区条目与提交改动文件都满足。 */
export interface TreeEntry {
	readonly path: string;
}

/**
 * 把菜单里的路径拼成绝对路径。
 *
 * 菜单给出的路径相对仓库根（git 的输出形态），而仓库根是绝对路径。已经是绝对路径的
 * 输入原样返回：本地排除文件这类目标在 `.git` 目录内，客户端持有的就是绝对路径。
 * 分隔符沿用仓库根的写法，Windows 上得到 `E:\repo\src\a.ts` 这样的原生形式。
 *
 * @param repoRoot - 仓库根的绝对路径。
 * @param path - 菜单给出的路径，相对仓库根或已是绝对路径。
 * @returns 绝对路径。
 */
export function absolutePathOf(repoRoot: string, path: string): string {
	const root = repoRoot.replace(/[\\/]+$/, '');
	const target = path;
	// 绝对路径：盘符（`C:/`、`C:\`）、POSIX 前导斜杠或 UNC（`\\server\share`）。
	if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/') || /^\\\\/.test(target)) return target;
	if (root === '') return target;
	const separator = root.includes('\\') ? '\\' : '/';
	return `${root}${separator}${target.replace(/^[\\/]+/, '').split(/[\\/]/).join(separator)}`;
}

/** 变更树节点。 */
export interface ChangeTreeNode<Entry extends TreeEntry> {
	readonly folders: Map<string, ChangeTreeNode<Entry>>;
	readonly files: Entry[];
	/** 子树（含自身节点）的文件总数；建树时累加，拍平时直接读。 */
	count: number;
}

/** 变更树的一行：文件夹行或文件行。 */
export type ChangeRow<Entry extends TreeEntry = WorkingTreeEntry> =
	| { readonly kind: 'folder'; readonly name: string; readonly path: string; readonly depth: number; readonly open: boolean; readonly count: number }
	| { readonly kind: 'file'; readonly entry: Entry; readonly depth: number };

/** 空树节点：文件夹挂在 folders，文件挂在 files。 */
function emptyTree<Entry extends TreeEntry>(): ChangeTreeNode<Entry> {
	return { folders: new Map(), files: [], count: 0 };
}

/** 把变更条目按「目录/文件」拆成可折叠的文件夹树。 */
function buildChangeTree<Entry extends TreeEntry>(entries: readonly Entry[]): ChangeTreeNode<Entry> {
	const root = emptyTree<Entry>();
	for (const entry of entries) {
		const parts = entry.path.split('/');
		let node = root;
		// 沿路径逐级累加：每个祖先节点的 count 都含该条目。
		node.count += 1;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			if (!node.folders.has(part)) node.folders.set(part, emptyTree<Entry>());
			node = node.folders.get(part) as ChangeTreeNode<Entry>;
			node.count += 1;
		}
		node.files.push(entry);
	}
	return root;
}

/** 把文件夹树拍平成可见行；出现在 collapsed 里的文件夹不展开其子节点。 */
function flattenChangeTree<Entry extends TreeEntry>(
	node: ChangeTreeNode<Entry>, prefix: string, depth: number, collapsed: ReadonlySet<string>, out: ChangeRow<Entry>[],
): void {
	const folderNames = [...node.folders.keys()].sort();
	for (const name of folderNames) {
		// 单链合并：目录下只有一个子目录、自身又没有文件时，逐级并入同一行。
		// 否则每级都只含一个子目录，会得到一串没有信息量的层级。
		let label = name;
		let path = prefix === '' ? name : `${prefix}/${name}`;
		let child = node.folders.get(name) as ChangeTreeNode<Entry>;
		while (child.files.length === 0 && child.folders.size === 1) {
			const entry = [...child.folders.entries()].at(0);
			if (entry === undefined) break;
			const [onlyName, onlyChild] = entry;
			label = `${label}/${onlyName}`;
			path = `${path}/${onlyName}`;
			child = onlyChild;
		}
		const open = !collapsed.has(path);
		out.push({ kind: 'folder', name: label, path, depth, open, count: child.count });
		if (open) flattenChangeTree(child, path, depth + 1, collapsed, out);
	}
	const files = node.files.slice().sort((a, b) => a.path.localeCompare(b.path));
	for (const entry of files) out.push({ kind: 'file', entry, depth });
}

/**
 * 把条目排成变更树的行。
 *
 * 从最早出现分叉的公共目录开始显示，而不是从根逐级展开：根到该目录之间每级都只有一个
 * 子目录，逐级展示只会得到一串没有信息量的层级。
 *
 * @param entries - 条目列表，路径以 `/` 分隔且相对仓库根。
 * @param collapsed - 已折叠的目录路径集合。
 * @returns 可见行序列。
 */
export function changeRowsOf<Entry extends TreeEntry>(
	entries: readonly Entry[], collapsed: ReadonlySet<string>,
): ChangeRow<Entry>[] {
	const rows: ChangeRow<Entry>[] = [];
	flattenChangeTree(buildChangeTree(entries), '', 1, collapsed, rows);
	return rows;
}
