/**
 * 类名拼接：把 CSS 模块给出的作用域化类名按条件组合成 `className`。
 */

/**
 * 拼接类名，跳过未给出的项。
 *
 * @param parts - 类名或条件；`false` / `null` / `undefined` / 空串不参与拼接。
 * @returns 以单个空格分隔的类名。
 */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
	return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}
