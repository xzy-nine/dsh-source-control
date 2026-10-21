/**
 * `.gitmodules` 的纯解析：从文件正文取出子模块的相对路径。
 *
 * 无任何导入，供发现层、补齐层与子模块初始化共用，也可被测试直接导入。
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 解析 `.gitmodules` 中的子模块路径。
 *
 * 只认 `[submodule "…"]` 段内的 `path = …` 行；段外的同名键、注释行与空行忽略。
 *
 * @param source - `.gitmodules` 文本。
 * @returns 相对仓库根的子模块路径，按出现顺序，分隔符统一为 `/`。
 */
export function parseSubmodulePaths(source: string): string[] {
	const paths: string[] = [];
	const section = /^\s*\[.*\]\s*$/;
	const submodule = /^\s*\[submodule\s+"/;
	const pathProperty = /^\s*path\s*=\s*(.*)$/;
	let inSubmodule = false;
	for (const line of source.split(/\r?\n/)) {
		if (section.test(line)) {
			inSubmodule = submodule.test(line);
			continue;
		}
		if (!inSubmodule) continue;
		const match = pathProperty.exec(line);
		const value = match === null ? '' : match[1].trim();
		if (value !== '') paths.push(value.replace(/\\/g, '/'));
	}
	return paths;
}

/**
 * 判定一个声明的子模块路径是否落在仓库根之内。
 *
 * `.gitmodules` 是仓库内可被改写的普通文件，其中的路径不保证相对仓库根：越界的写法
 * （`../outside`、`a/../../escape`）与绝对路径都会指向仓库之外。读这些路径等于读仓库外的
 * 文件或监视仓库外的目录，因此按仓库根逐项核对。
 *
 * 判据：路径不是绝对路径，且解析后仍位于仓库根之下。仓库根本身不算子模块目录。
 *
 * @param root - 仓库根的绝对路径。
 * @param relativePath - `.gitmodules` 里声明的相对路径，分隔符为 `/`。
 * @returns 落在仓库根之内时为 true。
 */
export function isSubmodulePathWithin(root: string, relativePath: string): boolean {
	if (relativePath === '') return false;
	// 绝对路径（含 Windows 的盘符写法）不由仓库根限定，直接排除。
	if (isAbsolute(relativePath) || /^[a-zA-Z]:\//.test(relativePath)) return false;
	const base = resolve(root);
	const target = resolve(base, relativePath);
	if (target === base) return false;
	const inside = relative(base, target);
	// 越界的路径的相对形式以 `..` 开头；同级的兄弟目录形如 `../sibling`。
	return inside !== '' && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside);
}

/**
 * 取落在仓库根之内的子模块路径。
 *
 * @param root - 仓库根的绝对路径。
 * @param paths - `.gitmodules` 里声明的相对路径。
 * @returns 落在仓库根之内的相对路径，保持入参顺序。
 */
export function submodulePathsWithin(root: string, paths: readonly string[]): string[] {
	return paths.filter((path) => isSubmodulePathWithin(root, path));
}
