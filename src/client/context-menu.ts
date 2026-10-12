/**
 * 自建右键浮层：MenuSurface 挂到 document.body，按指针坐标固定定位。
 *
 * 承载提交、分支、远程、标签、贮藏等目标的右键菜单项；带 children 的项在右侧
 * 弹出二级菜单。不依赖浏览器原生 contextmenu 的默认外观，统一走 DSH 的浮层外观。
 * 菜单尺寸在挂载后实测，再按视口边缘避让（见 ./menu-placement.ts）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
	IconChevronRightOutlineRegular, MenuSurface, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { placeMenu, placeSubmenu } from './menu-placement.ts';

/** 菜单宽度（一级与二级一致）。 */
const MENU_WIDTH = 220;

/**
 * 把文本写入剪贴板：优先异步剪贴板接口，回退到 execCommand。
 *
 * @param text - 待复制文本。
 * @returns 写入成功返回 true。
 */
export async function copyText(text: string): Promise<boolean> {
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
 * @param url - 目标地址。
 * @returns 无。
 */
export function openExternal(url: string): void {
	const link = document.createElement('a');
	link.href = url;
	link.target = '_blank';
	link.rel = 'noreferrer';
	document.body.appendChild(link);
	link.click();
	link.remove();
}

/** 一条菜单项。 */
export interface ContextMenuItem {
	/** `divider` 为分隔线，其余为可点击项。 */
	readonly type?: 'divider';
	/** 显示文案。 */
	readonly title?: string;
	/** 为 false 时该项不渲染。 */
	readonly visible?: boolean;
	/** 是否显示为已勾选。 */
	readonly checked?: boolean;
	/** 是否禁用。 */
	readonly disabled?: boolean;
	/** 是否使用危险样式。 */
	readonly danger?: boolean;
	/** 二级菜单项；非空时该项作为二级菜单入口。 */
	readonly children?: readonly ContextMenuItem[];
	/** 点击回调。 */
	readonly onClick?: () => void;
}

/** 弹出右键菜单的选项。 */
export interface ShowContextMenuOptions {
	/** 菜单项列表。 */
	readonly items: readonly ContextMenuItem[];
	/** 触发点横坐标。 */
	readonly x: number;
	/** 触发点纵坐标。 */
	readonly y: number;
	/** 菜单关闭（选中或点击外部）后的回调。 */
	readonly onClose?: () => void;
}

/** 菜单项类名。 */
function itemClass(item: ContextMenuItem, extra = ''): string {
	return `ggg-menu-item${item.danger ? ' ggg-menu-item-danger' : ''}`
		+ `${item.checked ? ' ggg-menu-item-checked' : ''}`
		+ `${extra === '' ? '' : ` ${extra}`}`;
}

/**
 * 在光标位置弹出右键菜单。
 *
 * @param options - 见 {@link ShowContextMenuOptions}。
 * @returns 无。
 */
export function showContextMenu({ items, x, y, onClose }: ShowContextMenuOptions): void {
	const visibleItems = items.filter((item) => item.visible !== false);
	if (visibleItems.length === 0) return;
	const mount = document.createElement('div');
	document.body.appendChild(mount);
	const root = createRoot(mount);
	const close = (): void => {
		root.unmount();
		mount.remove();
		onClose?.();
	};
	function MenuContent(): React.ReactElement {
		const anchor = React.useRef<HTMLDivElement>(mount);
		const panel = React.useRef<HTMLDivElement>(null);
		const submenuRef = React.useRef<HTMLDivElement>(null);
		const [open, setOpen] = React.useState(true);
		/** 展开的二级菜单：{ children, top }，top 为触发项在菜单内的纵向偏移。 */
		const [submenu, setSubmenu] = React.useState<{ children: readonly ContextMenuItem[]; top: number } | null>(null);
		/** 实测尺寸；挂载前为 null，此时先按估算值定位以免闪出屏幕外。 */
		const [panelSize, setPanelSize] = React.useState<{ width: number; height: number } | null>(null);
		const [submenuSize, setSubmenuSize] = React.useState<{ width: number; height: number } | null>(null);
		useDismissOnOutsidePointer(anchor, open, setOpen);
		React.useEffect(() => {
			if (open === false) close();
		}, [open]);
		// 挂载后量一次实际尺寸：菜单高度取决于项数与换行，只能实测。
		React.useLayoutEffect(() => {
			const element = panel.current;
			if (element === null) return;
			const rect = element.getBoundingClientRect();
			setPanelSize({ width: rect.width, height: rect.height });
		}, []);
		React.useLayoutEffect(() => {
			const element = submenuRef.current;
			if (element === null) return;
			const rect = element.getBoundingClientRect();
			setSubmenuSize({ width: rect.width, height: rect.height });
		}, [submenu]);
		// 二级菜单收起后清掉旧尺寸，避免下次按旧高度定位。
		React.useEffect(() => {
			if (submenu === null) setSubmenuSize(null);
		}, [submenu]);

		/** 一级菜单落点：实测优先，未量到时用项数估算高度。 */
		const estimatedHeight = visibleItems.reduce(
			(total, item) => total + (item.type === 'divider' ? 9 : 30), 16,
		);
		const placed = placeMenu(
			{ x, y },
			panelSize ?? { width: MENU_WIDTH, height: estimatedHeight },
			{ width: window.innerWidth, height: window.innerHeight },
		);
		const top = placed.top;
		const left = placed.left;
		return React.createElement(
			React.Fragment,
			null,
			React.createElement(
				MenuSurface,
				{
					ref: panel,
					style: {
						position: 'fixed', left, top, width: MENU_WIDTH, zIndex: 1100,
						// 量到尺寸前先隐藏，避免用估算位置闪一下再跳。
						visibility: panelSize === null ? 'hidden' : undefined,
					},
				},
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
							onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => {
								if (!hasChildren) {
									setSubmenu(null);
									return;
								}
								setSubmenu({ children, top: event.currentTarget.offsetTop });
							},
							onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
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
			submenu !== null && (() => {
				const submenuPlaced = placeSubmenu(
					{ left, top, width: MENU_WIDTH },
					submenu.top,
					submenuSize ?? { width: MENU_WIDTH, height: submenu.children.length * 30 + 16 },
					{ width: window.innerWidth, height: window.innerHeight },
				);
				return React.createElement(
					MenuSurface,
					{
						ref: submenuRef,
						style: {
							position: 'fixed', left: submenuPlaced.left, top: submenuPlaced.top,
							width: MENU_WIDTH, zIndex: 1101,
							visibility: submenuSize === null ? 'hidden' : undefined,
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
				);
			})(),
		);
	}
	root.render(React.createElement(MenuContent));
}
