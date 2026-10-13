/**
 * 自建右键浮层：把菜单项交给 DSH 的 Menu 渲染，按指针坐标定位。
 *
 * 承载提交、分支、远程、标签、贮藏等目标的右键菜单项；带 children 的项成为二级菜单。
 * 菜单项的圆角、悬停填充、键盘导航与视口夹取都由 Menu 提供，本模块只负责把自建的
 * 菜单项定义转成 Menu 的条目，并把指针坐标当作锚点矩形喂给它。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
	IconChevronRightOutlineRegular, Menu, type MenuEntry, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives';

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

/**
 * 菜单项文案：有二级菜单时在右侧补一个箭头标识。
 *
 * Menu 的 label 接受任意节点，箭头由这里提供——组件本身不画。
 *
 * @param title - 显示文案。
 * @param hasChildren - 是否带二级菜单。
 * @returns 文案节点。
 */
function labelOf(title: string, hasChildren: boolean): React.ReactNode {
	if (!hasChildren) return title;
	return React.createElement(
		'span',
		{ className: 'ggg-menu-label' },
		React.createElement('span', { className: 'ggg-menu-label-text' }, title),
		React.createElement(IconChevronRightOutlineRegular, { size: 13, className: 'ggg-menu-chevron' }),
	);
}

/**
 * 把自建菜单项转成 Menu 的一级条目，并把可点击项的 id 收集进 handlers。
 *
 * @param items - 自建菜单项。
 * @param handlers - 收集 id 到点击回调的映射。
 * @param selectedIds - 收集需要显示勾选的 id。
 * @returns Menu 条目序列。
 */
function toEntries(
	items: readonly ContextMenuItem[],
	handlers: Map<string, () => void>,
	selectedIds: string[],
): MenuEntry[] {
	const entries: MenuEntry[] = [];
	items.forEach((item, index) => {
		const id = `i${index}`;
		if (item.type === 'divider') {
			entries.push({ type: 'separator', id: `sep-${id}` });
			return;
		}
		const children = (item.children ?? []).filter((child) => child.visible !== false);
		if (item.onClick !== undefined) handlers.set(id, item.onClick);
		if (item.checked === true) selectedIds.push(id);
		entries.push({
			id,
			label: labelOf(item.title ?? '', children.length > 0),
			disabled: item.disabled === true,
			danger: item.danger === true,
			// 二级菜单只接受普通项，分隔线在 Menu 的 submenu 里没有对应类型。
			...(children.length > 0 ? { submenu: toSubItems(children, `${id}.`, handlers, selectedIds) } : {}),
		});
	});
	return entries;
}

/**
 * 把自建菜单项转成二级菜单项。
 *
 * @param items - 自建菜单项。
 * @param prefix - id 前缀，保证层级间唯一。
 * @param handlers - 收集 id 到点击回调的映射。
 * @param selectedIds - 收集需要显示勾选的 id。
 * @returns 二级菜单项序列。
 */
function toSubItems(
	items: readonly ContextMenuItem[],
	prefix: string,
	handlers: Map<string, () => void>,
	selectedIds: string[],
): MenuItem[] {
	const entries: MenuItem[] = [];
	items.forEach((item, index) => {
		if (item.type === 'divider') return;
		const id = `${prefix}${index}`;
		const children = (item.children ?? []).filter((child) => child.visible !== false);
		if (item.onClick !== undefined) handlers.set(id, item.onClick);
		if (item.checked === true) selectedIds.push(id);
		entries.push({
			id,
			label: item.title ?? '',
			disabled: item.disabled === true,
			danger: item.danger === true,
			...(children.length > 0 ? { submenu: toSubItems(children, `${id}.`, handlers, selectedIds) } : {}),
		});
	});
	return entries;
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
	const handlers = new Map<string, () => void>();
	const selectedIds: string[] = [];
	const entries = toEntries(visibleItems, handlers, selectedIds);
	const mount = document.createElement('div');
	document.body.appendChild(mount);
	const root = createRoot(mount);
	const close = (): void => {
		root.unmount();
		mount.remove();
		onClose?.();
	};
	// 指针位置当作零宽锚点：Menu 在锚点下方 4px 展开，故把矩形上移 4px 抵消，
	// 使菜单左上角正好落在指针处。视口夹取由 Menu 负责。
	const anchorRect = (): DOMRect => new DOMRect(x, y - 4, 0, 0);
	function MenuContent(): React.ReactElement {
		const [open, setOpen] = React.useState(true);
		React.useEffect(() => {
			if (open === false) close();
		}, [open]);
		return React.createElement(Menu, {
			open,
			anchor: null,
			items: entries,
			selectedIds,
			portal: true,
			getAnchorRect: anchorRect,
			onSelect: (id: string) => {
				setOpen(false);
				handlers.get(id)?.();
			},
			onClose: () => setOpen(false),
		});
	}
	root.render(React.createElement(MenuContent));
}
