/**
 * 数字补零：日志时间戳、日文件夹名与文件名共用。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

/**
 * 补零到两位。
 *
 * @param value - 待补零的非负整数。
 * @returns 两位文本。
 */
export function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

/**
 * 补零到三位。
 *
 * @param value - 待补零的非负整数。
 * @returns 三位文本。
 */
export function pad3(value: number): string {
	return String(value).padStart(3, '0');
}
