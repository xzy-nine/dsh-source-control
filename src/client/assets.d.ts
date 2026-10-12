/**
 * 构建期资源声明：esbuild 以 text loader 把 SVG 内联为字符串。
 */
declare module '*.svg' {
	const content: string;
	export default content;
}
