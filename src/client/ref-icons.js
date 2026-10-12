/**
 * 引用标记的本地图标：标签与远端。
 *
 * 资源文件取自 Google Material Symbols Outlined（24px、FILL 0、wght 400、
 * GRAD 0、opsz 24），置于 assets/icons/，由 scripts/build-client.mjs 以文本
 * 形式内联进 lib/client.js，运行时不访问网络。
 */
import React from 'react';
import cloudSvg from '../../assets/icons/cloud.svg';
import tagSvg from '../../assets/icons/shoppingmode.svg';

/** 图标边长（像素）。 */
const ICON_SIZE = 12;

/**
 * 把资源 SVG 转成行内标记：改为图标边长，并让颜色随外层文字色。
 *
 * @param svg - 资源文件内容。
 * @returns HTML 字符串。
 */
function iconMarkup(svg) {
	return svg
		.replace(/\s(?:width|height)="[^"]*"/g, '')
		.replace('<svg', `<svg fill="currentColor" width="${ICON_SIZE}" height="${ICON_SIZE}"`)
		.replace(/\s+/g, ' ')
		.trim();
}

/** 标签图标的行内标记。 */
const TAG_MARKUP = iconMarkup(tagSvg);
/** 远端图标的行内标记。 */
const CLOUD_MARKUP = iconMarkup(cloudSvg);

/**
 * 标签引用图标。
 *
 * @returns 图标元素。
 */
export function TagRefIcon() {
	return React.createElement('span', {
		className: 'ggg-ref-icon',
		'aria-hidden': 'true',
		dangerouslySetInnerHTML: { __html: TAG_MARKUP },
	});
}

/**
 * 远端引用图标。
 *
 * @returns 图标元素。
 */
export function RemoteRefIcon() {
	return React.createElement('span', {
		className: 'ggg-ref-icon',
		'aria-hidden': 'true',
		dangerouslySetInnerHTML: { __html: CLOUD_MARKUP },
	});
}
