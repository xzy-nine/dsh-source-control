/**
 * 插件图标：插件标识用 logo，分支语义用走向图。
 *
 * 独立成模块，避免 repo-row / graph 反向依赖 index（index 已导入 panel）。
 * logo 取自 assets/icons/plugin-logo.svg，由 scripts/build-client.mjs 以文本形式
 * 内联进 lib/client.js，运行时不访问网络。
 */
import React from 'react';
import logo from '../../assets/icons/plugin-logo.svg';
import css from './css/shared.module.css';
import { cx } from './css/cx.ts';

/** 插件图标的属性。 */
export interface PluginIconProps {
	/** 图标边长（像素）。 */
	readonly size?: number;
	/** 附加类名。 */
	readonly className?: string;
}

/**
 * logo 的行内标记：只去掉根元素上的尺寸，其余内容（含背景矩形）原样保留。
 *
 * 不能整篇按 `width` / `height` 属性剥离：logo 的背景圆角矩形自带这两个属性，
 * 一并删掉会让它塌成 0 尺寸、背景随之消失。
 */
const LOGO_MARKUP = logo
	.replace(/^<svg\b[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, ''))
	.replace(/\s+/g, ' ')
	.trim();

/**
 * 画插件 logo：圆角蓝框内是带 Logo 的提交图。
 *
 * 用于插件自身的标识：侧栏页标签、会话 header 入口与引导页条目。
 *
 * @param props - 见 {@link PluginIconProps}。
 * @returns 图标元素。
 */
export function PluginLogoIcon({ size = 16, className }: PluginIconProps): React.ReactElement {
	const markup = LOGO_MARKUP.replace('<svg', `<svg width="${size}" height="${size}"`);
	return React.createElement('span', {
		className: cx(css.icon, className),
		'aria-hidden': 'true',
		dangerouslySetInnerHTML: { __html: markup },
	});
}

/**
 * 画分支走向图标：一条主干与一条并入的分支。
 *
 * 用于分支语义：提交行上的分支标记、引用筛选、仓库行分支名与「筛选分支与标签」按钮。
 *
 * @param props - 见 {@link PluginIconProps}。
 * @returns 图标元素。
 */
export function GitGraphIcon({ size = 16, className }: PluginIconProps): React.ReactElement {
	return React.createElement(
		'svg',
		{
			width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor',
			className, 'aria-hidden': 'true', focusable: 'false',
		},
		React.createElement('path', {
			d: 'M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6A1 1 0 005 9.5v1.878a2.251 2.251 0 11-1.5 0V4.622a2.251 2.251 0 111.5 0v1.58A2.49 2.49 0 006 7h4a1 1 0 001-1v-.578A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z',
		}),
	);
}
