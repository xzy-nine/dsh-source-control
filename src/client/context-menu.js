/**
 * 自建右键浮层：MenuSurface 挂到 document.body，按指针坐标固定定位。
 *
 * 承载提交、分支、远程、标签、贮藏等目标的右键菜单项。
 * 不依赖浏览器原生 contextmenu 的默认外观，统一走 DSH 的浮层外观。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
	MenuSurface, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives';

/**
 * 把文本写入剪贴板：优先异步剪贴板接口，回退到 execCommand。
 *
 * @param {string} text - 待复制文本。
 * @returns {Promise<boolean>} 写入成功返回 true。
 */
export async function copyText(text) {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return false;
		}
	}
	try {
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand('copy');
		textarea.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * 在光标位置弹出右键菜单。
 *
 * @param {object} options - 选项。
 * @param {Array<object>} options.items - 菜单项：{ type?:'divider', title, visible?, checked?, disabled?, danger?, onClick }。
 * @param {number} options.x - 触发点横坐标。
 * @param {number} options.y - 触发点纵坐标。
 * @returns 无。
 */
export function showContextMenu({ items, x, y }) {
	const visibleItems = items.filter((item) => item.visible !== false);
	if (visibleItems.length === 0) return;
	const mount = document.createElement('div');
	document.body.appendChild(mount);
	const root = createRoot(mount);
	const close = () => {
		root.unmount();
		mount.remove();
	};
	function MenuContent() {
		const anchor = React.useRef(mount);
		const panel = React.useRef(null);
		const [open, setOpen] = React.useState(true);
		useDismissOnOutsidePointer(anchor, open, setOpen);
		React.useEffect(() => {
			if (open === false) close();
		}, [open]);
		const width = 220;
		const left = Math.min(x, window.innerWidth - width - 8);
		const top = Math.min(y, window.innerHeight - 8);
		return React.createElement(
			MenuSurface,
			{ ref: panel, style: { position: 'fixed', left, top, width, zIndex: 1100 } },
			visibleItems.map((item, index) => {
				if (item.type === 'divider') {
					return React.createElement('div', { key: `divider-${index}`, className: 'ggg-menu-divider' });
				}
				return React.createElement(
					'button',
					{
						key: `item-${index}`,
						type: 'button',
						role: 'menuitem',
						className: `ggg-menu-item${item.danger ? ' ggg-menu-item-danger' : ''}${item.checked ? ' ggg-menu-item-checked' : ''}`,
						disabled: item.disabled === true,
						onClick: () => {
							setOpen(false);
							item.onClick?.();
						},
					},
					item.title,
				);
			}),
		);
	}
	root.render(React.createElement(MenuContent));
}
