/**
 * 子模块操作：初始化子模块、解析其声明路径、路径写法归一。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { gitOrThrow } from './git-exec.js';
import { isSubmodulePathWithin, parseSubmodulePaths, submodulePathsWithin } from './submodule-parse.js';

/**
 * 统一分隔符并去掉尾斜杠。
 *
 * @param value - 路径。
 * @returns 以 `/` 分隔的路径。
 */
export function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 判定路径是否为绝对路径。
 *
 * @param path - 待判定路径。
 * @returns 绝对路径时为 true。
 */
function isAbsolutePath(path: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\');
}

/**
 * 初始化一个子模块。
 *
 * `submodule update --init` 按 `.gitmodules` 与索引里的 gitlink 检出子模块工作区；
 * `--recursive` 一并初始化其内部声明的子模块。该命令可能访问远端。
 *
 * 子模块尚未检出时目录里没有 `.git`，因此 `repo` 给出的是子模块路径时先向上找声明它的父
 * 仓库；`submodulePath` 为绝对路径时同样如此。
 *
 * @param repo - 父仓库路径，或子模块路径。
 * @param submodulePath - 子模块路径，相对仓库根或绝对路径。
 * @returns 无。
 */
export async function initSubmodule(repo: string, submodulePath: string): Promise<void> {
	if (!isAbsolutePath(submodulePath)) {
		// 相对路径必须落在仓库根之内：越界的路径不指向本仓库的子模块。
		if (!isSubmodulePathWithin(repo, normalizeSlashes(submodulePath))) {
			throw new Error('子模块路径不在仓库内');
		}
		await gitOrThrow(['submodule', 'update', '--init', '--recursive', '--', submodulePath], repo);
		return;
	}
	const target = normalizeSlashes(submodulePath);
	const found = await declaringRepoOf(target);
	if (found === null) throw new Error('子模块路径不在任何含 .gitmodules 的仓库内');
	await gitOrThrow(['submodule', 'update', '--init', '--recursive', '--', found.relative], found.root);
}

/**
 * 向上查找声明了某个子模块路径的父仓库。
 *
 * 判定只读 `.gitmodules`：从目标路径起逐级取父目录，第一个在 `.gitmodules` 里声明了该路径
 * 的目录即为父仓库。Windows 上路径比较忽略盘符大小写。
 *
 * @param target - 子模块绝对路径，已统一分隔符。
 * @returns 父仓库根与子模块相对路径；找不到时为 null。
 */
async function declaringRepoOf(target: string): Promise<{ root: string; relative: string } | null> {
	const fold = (value: string): string => (/^[a-zA-Z]:\//.test(value) ? value.toLowerCase() : value);
	const wanted = fold(target);
	let dir = nodePath.dirname(target);
	for (;;) {
		const root = normalizeSlashes(dir);
		const prefix = fold(root);
		if (wanted.startsWith(`${prefix}/`)) {
			const relative = target.slice(root.length + 1);
			const declared = await declaredSubmodules(root);
			if (declared.includes(relative)) return { root, relative };
		}
		const parent = nodePath.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * 读取一个仓库在 `.gitmodules` 里声明的子模块相对路径。
 *
 * 只取落在仓库根之内的声明：越界的路径不指向本仓库的子模块。
 *
 * @param root - 仓库根。
 * @returns 相对路径列表；没有 `.gitmodules` 时为空数组。
 */
async function declaredSubmodules(root: string): Promise<string[]> {
	try {
		const source = await fs.readFile(nodePath.join(root, '.gitmodules'), 'utf8');
		return submodulePathsWithin(root, parseSubmodulePaths(source));
	} catch {
		return [];
	}
}
