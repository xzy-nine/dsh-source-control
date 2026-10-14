/**
 * 忽略规则的纯计算：目标路径规范化、规则写法、去重与追加。
 *
 * 规则以 `/` 锚定到忽略文件所在目录，避免匹配到同名的其它层级；目录带尾斜杠。
 * 本模块无任何导入，供宿主与单元测试直接使用。
 */

/**
 * 把路径规范化为相对仓库根、`/` 分隔、无前后斜杠的形式。
 *
 * @param path - 原始路径。
 * @returns 规范化后的路径。
 */
export function normalizeIgnoreTarget(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * 生成一条忽略规则。
 *
 * @param relativePath - 目标相对忽略文件所在目录的路径。
 * @param isFolder - 目标是否为目录。
 * @returns 规则文本；路径为空时为空串。
 */
export function ignoreRuleOf(relativePath: string, isFolder: boolean): string {
	const target = normalizeIgnoreTarget(relativePath);
	if (target === '') return '';
	return `/${target}${isFolder ? '/' : ''}`;
}

/**
 * 现有内容里是否已有该规则。
 *
 * @param content - 忽略文件的现有内容。
 * @param rule - 待检查的规则。
 * @returns 已存在时为 true。
 */
export function hasIgnoreRule(content: string, rule: string): boolean {
	return content.split('\n').some((line) => line.trim() === rule);
}

/**
 * 取有效条目：去掉空行与注释。
 *
 * @param content - 忽略文件的现有内容。
 * @returns 条目列表。
 */
export function ignoreEntriesOf(content: string): string[] {
	return content.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * 追加一条规则。
 *
 * 原内容末尾没有换行时先补一个，保证规则独占一行。
 *
 * @param content - 忽略文件的现有内容。
 * @param rule - 待追加的规则。
 * @returns 追加后的内容。
 */
export function appendIgnoreRule(content: string, rule: string): string {
	if (content === '') return `${rule}\n`;
	const body = content.endsWith('\n') ? content : `${content}\n`;
	return `${body}${rule}\n`;
}

/**
 * 路径是否可用于写入忽略规则：不能为空，也不能指向仓库之外。
 *
 * @param target - 规范化后的路径。
 * @returns 可用于写入时为 true。
 */
export function isIgnorableTarget(target: string): boolean {
	return target !== '' && target !== '..' && !target.startsWith('../') && !target.includes('/../');
}
