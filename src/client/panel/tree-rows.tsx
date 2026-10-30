/**
 * 树行的公共展示件：按层级生成的竖线占位，以及复用变更区行的文件夹行与可点文件行。
 *
 * 变更区与日志文件树共用同一套外观，避免两侧各写一份建行代码而逐渐走样。
 */
import React from 'react';
import {
	FileTypeIcon, IconChevronDownOutlineRegular,
	IconFolderCloseRegular, IconFolderOpenOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { forKey } from '../shared/cache.ts';
import shared from '../css/shared.module.css';
import changesCss from '../css/changes.module.css';
import { cx } from '../css/cx.ts';
import { splitPath } from './changes.ts';

/** 按 depth 生成的竖线层级占位；元素数组按 depth 缓存，同一深度复用同一份元素。 */
export const guidesOf = forKey((depth: number): React.ReactElement[] => {
	const guides: React.ReactElement[] = [];
	for (let index = 0; index < depth; index++) guides.push(React.createElement('span', { key: index, className: shared.repoGuide }));
	return guides;
}, { limit: 64 });

/**
 * 一个文件夹行。
 *
 * @param props.path - 文件夹路径，用作悬停提示。
 * @param props.name - 显示名（已做单链合并）。
 * @param props.depth - 层级。
 * @param props.open - 是否展开。
 * @param props.count - 子树文件数。
 * @param props.onToggle - 点击回调。
 * @returns 行元素。
 */
export function FolderRow({ path, name, depth, open, count, onToggle }: {
	readonly path: string;
	readonly name: string;
	readonly depth: number;
	readonly open: boolean;
	readonly count: number;
	readonly onToggle: () => void;
}): React.ReactElement {
	return React.createElement('div', {
		className: cx(changesCss.change, changesCss.folder), title: path, onClick: onToggle,
	},
		...guidesOf(depth),
		React.createElement('span', {
			className: cx(shared.repoChevron, !open && shared.isCollapsed),
		}, React.createElement(IconChevronDownOutlineRegular, { size: 12 })),
		React.createElement(open ? IconFolderOpenOutlineRegular : IconFolderCloseRegular, { size: 14 }),
		React.createElement('span', { className: changesCss.changeName }, name),
		React.createElement('span', { className: changesCss.count }, String(count)),
	);
}

/**
 * 一个可点击打开的文件行。
 *
 * @param props.fileName - 文件名（行上显示的部分）。
 * @param props.title - 悬停提示（完整路径）。
 * @param props.depth - 层级。
 * @param props.tail - 行尾文本，如日志体积；省略时不给。
 * @param props.onOpen - 点击回调。
 * @returns 行元素。
 */
export function FileRow({ fileName, title, depth, tail, onOpen }: {
	readonly fileName: string;
	readonly title: string;
	readonly depth: number;
	readonly tail?: string | undefined;
	readonly onOpen: () => void;
}): React.ReactElement {
	const { name } = splitPath(fileName);
	return React.createElement('button', {
		type: 'button', className: cx(changesCss.change, changesCss.changeOpenable, changesCss.rowButton), title, onClick: onOpen,
	},
		...guidesOf(depth),
		React.createElement(FileTypeIcon, { path: name, size: 14 }),
		React.createElement('span', { className: changesCss.changeName },
			React.createElement('span', { className: changesCss.changeText }, name)),
		tail !== undefined && React.createElement('span', { className: changesCss.fileTail }, tail),
	);
}
