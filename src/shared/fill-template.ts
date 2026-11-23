/**
 * 代入模板里的 `{name}` 占位符。
 *
 * 用切分拼接而不是 `replace`，避免取值里的 `$&` 等序列被当作替换模式。
 * 运行时无平台依赖，宿主与客户端各自打包。
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
