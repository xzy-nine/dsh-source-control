/**
 * `blueimp-md5` 的模块声明。
 *
 * 该包只发 CommonJS 与压缩版，不带类型声明。
 */
declare module 'blueimp-md5' {
	/**
	 * 计算字符串的 MD5 摘要。
	 *
	 * @param value - 待摘要的字符串。
	 * @returns 32 位小写十六进制摘要。
	 */
	export default function md5(value: string): string;
}
