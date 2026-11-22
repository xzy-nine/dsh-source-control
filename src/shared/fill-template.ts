/**
 * 代入模板里的 `{name}` 占位符。
 *
 * 用切分拼接而不是 `replace`：取值里可能出现 `$&` 这类会被 `replace` 当作替换模式的序列。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

/**
 * 代入模板里的 `{name}` 占位符。
 *
 * @param template - 含 `{name}` 占位符的模板。
 * @param values - 占位符取值。
 * @returns 代入后的文本。
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
	let text = template;
	for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(value);
	return text;
}
