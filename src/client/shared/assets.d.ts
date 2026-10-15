/**
 * 构建期资源声明：esbuild 以 text loader 把 SVG 内联为字符串，
 * 以 local-css loader 把 CSS 模块转成类名映射。
 */
declare module '*.svg' {
	const content: string;
	export default content;
}

declare module '*.module.css' {
	const classes: Readonly<Record<string, string>>;
	export default classes;
}
