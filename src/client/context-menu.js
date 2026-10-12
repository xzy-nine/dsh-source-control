/**
 * 自建右键浮层：MenuSurface 挂到 document.body，按指针坐标固定定位。
 *
 * 承载提交、分支、远程、标签、贮藏等目标的右键菜单项；带 children 的项在右侧
 * 弹出二级菜单。不依赖浏览器原生 contextmenu 的默认外观，统一走 DSH 的浮层外观。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
	IconChevronRightOutlineRegular, MenuSurface, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** 菜单宽度（一级与二级一致）。 */
const MENU_WIDTH = 220;

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
 * 在新标签页打开链接。
 *
 * @param {string} url - 目标地址。
 * @returns 无。
 */
export function openExternal(url) {
	const link = document.createElement('a');
	link.href = url;
	link.target = '_blank';
	link.rel = 'noreferrer';
	document.body.appendChild(link);
	link.click();
	link.remove();
}

/** 菜单项类名。 */
function itemClass(item, extra = '') {
	return `ggg-menu-item${item.danger ? ' ggg-menu-item-danger' : ''}`
		+ `${item.checked ? ' ggg-menu-item-checked' : ''}`
		+ `${extra === '' ? '' : ` ${extra}`}`;
}

/**
 * 在光标位置弹出右键菜单。
 *
 * @param {object} options - 选项。
 * @param {Array<object>} options.items - 菜单项：{ type?:'divider', title, visible?, checked?, disabled?, danger?, children?, onClick }；
 *   children 非空时该项作为二级菜单入口，点击或悬停展开。
 * @param {number} options.x - 触发点横坐标。
 * @param {number} options.y - 触发点纵坐标。
 * @param {function} [options.onClose] - 菜单关闭（选中或点击外部）后的回调。
 * @returns 无。
 */
export function showContextMenu({ items, x, y, onClose }) {
	const visibleItems = items.filter((item) => item.visible !== false);
	if (visibleItems.length === 0) return;
	const mount = document.createElement('div');
	document.body.appendChild(mount);
	const root = createRoot(mount);
	const close = () => {
		root.unmount();
		mount.remove();
		onClose?.();
	};
	function MenuContent() {
		const anchor = React.useRef(mount);
		const panel = React.useRef(null);
		const [open, setOpen] = React.useState(true);
		/** 展开的二级菜单：{ children, top }，top 为触发项在菜单内的纵向偏移。 */
		const [submenu, setSubmenu] = React.useState(null);
		useDismissOnOutsidePointer(anchor, open, setOpen);
		React.useEffect(() => {
			if (open === false) close();
		}, [open]);
		const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
		const top = Math.min(y, window.innerHeight - 8);
		return React.createElement(
			React.Fragment,
			null,
			React.createElement(
				MenuSurface,
				{ ref: panel, style: { position: 'fixed', left, top, width: MENU_WIDTH, zIndex: 1100 } },
				visibleItems.map((item, index) => {
					if (item.type === 'divider') {
						return React.createElement('div', { key: `divider-${index}`, className: 'ggg-menu-divider' });
					}
					const children = Array.isArray(item.children)
						? item.children.filter((child) => child.visible !== false)
						: [];
					const hasChildren = item.disabled !== true && children.length > 0;
					return React.createElement(
						'button',
						{
							key: `item-${index}`,
							type: 'button',
							role: 'menuitem',
							className: itemClass(item, hasChildren ? 'ggg-menu-item-parent' : ''),
							disabled: item.disabled === true,
							onPointerEnter: (event) => {
								if (!hasChildren) {
									setSubmenu(null);
									return;
								}
								setSubmenu({ children, top: event.currentTarget.offsetTop });
							},
							onClick: (event) => {
								if (hasChildren) {
									// 触屏没有悬停：点击同样展开二级菜单。
									setSubmenu({ children, top: event.currentTarget.offsetTop });
									return;
								}
								setOpen(false);
								item.onClick?.();
							},
						},
						item.title,
						hasChildren && React.createElement(IconChevronRightOutlineRegular, { size: 13, className: 'ggg-menu-chevron' }),
					);
				}),
			),
			submenu !== null && React.createElement(
				MenuSurface,
				{
					style: {
						position: 'fixed',
						left: Math.min(left + MENU_WIDTH + 4, Math.max(8, window.innerWidth - MENU_WIDTH - 8)),
						top: Math.min(top + submenu.top, Math.max(8, window.innerHeight - submenu.children.length * 32 - 16)),
						width: MENU_WIDTH,
						zIndex: 1101,
					},
				},
				submenu.children.map((child, index) => React.createElement(
					'button',
					{
						key: `submenu-${index}`,
						type: 'button',
						role: 'menuitem',
						className: itemClass(child),
						disabled: child.disabled === true,
						onClick: () => {
							setOpen(false);
							child.onClick?.();
						},
					},
					child.title,
				)),
			),
		);
	}
	root.render(React.createElement(MenuContent));
}
