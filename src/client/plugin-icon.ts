/**
 * 插件图标：侧栏页标识与分支名前的小图标共用。
 *
 * 独立成模块，避免 repo-row / graph 反向依赖 index（index 已导入 panel）。
 */
import React from 'react';

/** 插件图标的属性。 */
export interface PluginIconProps {
	/** 图标边长（像素）。 */
	readonly size?: number;
	/** 附加类名。 */
	readonly className?: string;
}

/**
 * 画插件图标：分支走向。
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
