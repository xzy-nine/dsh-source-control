/**
 * 本地资源图标：引用标记（标签、远端）与存储库行。
 *
 * 资源文件取自 Google Material Symbols Outlined（24px、FILL 0、wght 400、
 * GRAD 0、opsz 24），置于 assets/icons/，由 scripts/build-client.mjs 以文本
 * 形式内联进 lib/client.js，运行时不访问网络。
 */
import React from 'react';
import bookSvg from '../../assets/icons/book_2.svg';
import cloudSvg from '../../assets/icons/cloud.svg';
import tagSvg from '../../assets/icons/shoppingmode.svg';

/** 引用标记的图标边长（像素）。 */
const REF_ICON_SIZE = 12;
/** 存储库行的图标边长（像素）。 */
const REPO_ICON_SIZE = 14;

/**
 * 把资源 SVG 转成行内标记：改为图标边长，并让颜色随外层文字色。
 *
 * @param svg - 资源文件内容。
 * @param size - 图标边长（像素）。
 * @returns HTML 字符串。
 */
function iconMarkup(svg, size) {
	return svg
		.replace(/\s(?:width|height)="[^"]*"/g, '')
		.replace('<svg', `<svg fill="currentColor" width="${size}" height="${size}"`)
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * 画一个本地资源图标。
 *
 * @param markup - 行内标记。
 * @returns 图标元素。
 */
function ResourceIcon(markup) {
	return React.createElement('span', {
		className: 'ggg-icon',
		'aria-hidden': 'true',
		dangerouslySetInnerHTML: { __html: markup },
	});
}

/** 标签图标的行内标记。 */
const TAG_MARKUP = iconMarkup(tagSvg, REF_ICON_SIZE);
/** 远端图标的行内标记。 */
const CLOUD_MARKUP = iconMarkup(cloudSvg, REF_ICON_SIZE);
/** 存储库图标的行内标记。 */
const BOOK_MARKUP = iconMarkup(bookSvg, REPO_ICON_SIZE);

/**
 * 标签引用图标。
 *
 * @returns 图标元素。
 */
export function TagRefIcon() {
	return ResourceIcon(TAG_MARKUP);
}

/**
 * 远端引用图标。
 *
 * @returns 图标元素。
 */
export function RemoteRefIcon() {
	return ResourceIcon(CLOUD_MARKUP);
}

/**
 * 存储库图标。
 *
 * @returns 图标元素。
 */
export function RepoIcon() {
	return ResourceIcon(BOOK_MARKUP);
}
