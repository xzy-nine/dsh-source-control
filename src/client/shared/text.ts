/**
 * 未知值到文本的窄化取值。
 *
 * 弹窗表单与宿主回投的载荷在类型上都是 unknown，直接 String(...) 会把对象拼成
 * `[object Object]`。本模块只接受字符串、数字与布尔三种标量，其余一律给回退值。
 */

/**
 * 取标量值的文本形式。
 *
 * @param value - 待取值。
 * @param fallback - 值不是标量时的回退文本。
 * @returns 字符串原样返回；数字与布尔转成文本；其余返回回退值。
 */
export function textOf(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return fallback;
}

/**
 * 取标量值的去空白文本。
 *
 * @param value - 待取值。
 * @param fallback - 值不是标量时的回退文本。
 * @returns 去空白后的文本。
 */
export function trimmedTextOf(value: unknown, fallback = ''): string {
	return textOf(value, fallback).trim();
}
