/**
 * `.gitmodules` 的纯解析：从文件正文取出子模块的相对路径。
 *
 * 无任何导入，供发现层、补齐层与子模块初始化共用，也可被测试直接导入。
 */

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
