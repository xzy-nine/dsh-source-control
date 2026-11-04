/**
 * 右键菜单：宿主提供共享菜单时交给它，否则由本模块自建浮层。
 *
 * 承载提交、分支、远程、标签、贮藏等目标的右键菜单项；带 children 的项成为二级菜单。
 * 自建浮层把菜单项交给 DSH 的 Menu 渲染，菜单项的圆角、悬停填充、键盘导航与视口夹取
 * 都由 Menu 提供，本模块只负责把自建的菜单项定义转成 Menu 的条目，并把指针坐标当作
 * 锚点矩形喂给它。共享菜单（`ctx.contextMenus`）由宿主渲染弹窗，本模块只登记一次性的
 * 动作贡献并按 menuId 在打开期间捕获动作。
 *
 * 对菜单包只有类型依赖：宿主未提供该服务时包本身不在运行栈里，实体导入会让插件加载失败。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
	IconChevronRightOutlineRegular, Menu, type MenuEntry, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { ContextMenus, MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client';
import css from '../css/context-menu.module.css';
import { SUBMENU_FLIP_ATTR } from '../css/state-classes.ts';

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
	interface ContextMenuTargetMap {
		/** 本插件自有目标：动作在打开期间按 menuId 捕获，菜单关闭即丢弃。 */
		'source-control': { readonly menuId: string };
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
	/** 悬浮提示；不提供时不带提示。 */
	readonly hint?: string;
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
 * Menu 的 label 接受任意节点，箭头由这里提供——组件本身不画。`hint` 以原生 title
 * 挂在文案节点上，鼠标停留时由浏览器显示。
 *
 * @param title - 显示文案。
 * @param hasChildren - 是否带二级菜单。
 * @param hint - 悬浮提示；不提供时不带提示。
 * @returns 文案节点。
 */
function labelOf(title: string, hasChildren: boolean, hint?: string): React.ReactNode {
	const inner = hasChildren
		? React.createElement(
			'span',
			{ className: css.menuLabel },
			React.createElement('span', { className: css.menuLabelText }, title),
			React.createElement(IconChevronRightOutlineRegular, { size: 13, className: css.menuChevron }),
		)
		: title;
	return hint === undefined ? inner : React.createElement('span', { title: hint }, inner);
}

/**
 * 把一条自建菜单项登记进 handlers / selectedIds，并给出它是否带二级菜单。
 *
 * @param item - 自建菜单项。
 * @param id - 该项在所属层级里的 id。
 * @param handlers - 收集 id 到点击回调的映射。
 * @param selectedIds - 收集需要显示勾选的 id。
 * @returns 已过滤可见性的子项。
 */
function registerItem(
	item: ContextMenuItem,
	id: string,
	handlers: Map<string, () => void>,
	selectedIds: string[],
): ContextMenuItem[] {
	const children = (item.children ?? []).filter((child) => child.visible !== false);
	if (item.onClick !== undefined) handlers.set(id, item.onClick);
	if (item.checked === true) selectedIds.push(id);
	return children;
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
		const children = registerItem(item, id, handlers, selectedIds);
		entries.push({
			id,
			label: labelOf(item.title ?? '', children.length > 0, item.hint),
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
		const children = registerItem(item, id, handlers, selectedIds);
		entries.push({
			id,
			label: item.hint === undefined ? (item.title ?? '') : React.createElement('span', { title: item.hint }, item.title ?? ''),
			disabled: item.disabled === true,
			danger: item.danger === true,
			...(children.length > 0 ? { submenu: toSubItems(children, `${id}.`, handlers, selectedIds) } : {}),
		});
	});
	return entries;
}

/**
 * 向右展开二级菜单所需的右侧余量（像素）。
 *
 * 按宿主 Menu 原语的几何估算：主卡片最宽 360、卡片与二级卡片间隔 10、
 * 二级卡片最小宽度 163、视口留白 12。估算偏保守，最坏只是提前左翻，
 * 不会翻进新的溢出。
 */
const SUBMENU_RIGHT_ROOM = 400;

/**
 * 二级菜单的展开方向令牌。
 *
 * 宿主原语把二级菜单固定为向上、向右展开且不做视口夹取，在本插件贴右缘的面板里
 * 向右展开必被裁掉。
 *
 * @param x - 触发点横坐标。
 * @param y - 触发点纵坐标。
 * @param vw - 视口宽度。
 * @param vh - 视口高度。
 * @returns 空白分隔的令牌：`left` 改向左展开，`down` 改向下展开；空串表示沿用原语默认。
 */
function submenuFlipTokens(x: number, y: number, vw: number, vh: number): string {
	const tokens: string[] = [];
	// 触发点在上半屏时卡片向下展开，二级菜单仍向上展开就会顶出视口上缘。
	if (y < vh / 2) tokens.push('down');
	if (x + SUBMENU_RIGHT_ROOM > vw) tokens.push('left');
	return tokens.join(' ');
}

/**
 * 宿主共享菜单服务；未装载时为 null。
 *
 * 由插件入口在 `ctx.inject(['contextMenus'])` 里装入：宿主没有该服务时它保持 null，
 * 菜单走自建浮层。
 */
let sharedMenus: ContextMenus | null = null;

/** 打开中的共享菜单编号；每次打开递增，保证贡献 id 在宿主侧唯一。 */
let sharedMenuSeq = 0;

/**
 * 接入宿主共享菜单服务。
 *
 * @param menus - `ctx.contextMenus`；宿主卸载该服务时传 null。
 * @returns 无。
 */
export function useSharedContextMenu(menus: ContextMenus | null): void {
	sharedMenus = menus;
}

/**
 * 把一条自建菜单项转成共享菜单的动作。
 *
 * 共享菜单的条目类型没有悬浮提示与勾选，`hint` 与 `checked` 在此丢弃；分隔线转成
 * 下一条动作的 `separatorBefore`，末位单独的分隔线没有对应落点，直接略过。
 *
 * @param item - 自建菜单项。
 * @param id - 该项在该层级的 id；子项在此基础上追加层级段。
 * @returns 动作；分隔线返回 null。
 */
function toSharedAction(item: ContextMenuItem, id: string): MenuAction | null {
	if (item.type === 'divider') return null;
	const children = (item.children ?? []).filter((child) => child.visible !== false);
	const actions: MenuAction[] = [];
	children.forEach((child, index) => {
		const action = toSharedAction(child, `${id}.${String(index)}`);
		if (action !== null) actions.push(action);
	});
	const onClick = item.onClick;
	return {
		id,
		label: item.title ?? '',
		disabled: item.disabled === true,
		danger: item.danger === true,
		...(onClick === undefined ? {} : { run: onClick }),
		...(actions.length > 0 ? { children: actions } : {}),
	};
}

/**
 * 把自建菜单项转成共享菜单的动作列表。
 *
 * @param items - 自建菜单项，已过滤可见性。
 * @returns 动作列表。
 */
function toSharedActions(items: readonly ContextMenuItem[]): MenuAction[] {
	const actions: MenuAction[] = [];
	let separator = false;
	items.forEach((item, index) => {
		if (item.type === 'divider') {
			// 首个分隔线与相邻分隔线都没有落点：菜单卡片画不出空行。
			if (actions.length > 0) separator = true;
			return;
		}
		const action = toSharedAction(item, `i${String(index)}`);
		if (action === null) return;
		actions.push(separator ? { ...action, separatorBefore: true } : action);
		separator = false;
	});
	return actions;
}

/**
 * 经宿主共享菜单弹出。
 *
 * 动作在打开前登记一次，菜单关闭（选中、点击外部、Escape）时注销；因此宿主侧始终只有
 * 当前打开的这一份贡献。
 *
 * @param menus - 宿主共享菜单服务。
 * @param items - 自建菜单项。
 * @param x - 触发点横坐标。
 * @param y - 触发点纵坐标。
 * @param onClose - 关闭后的回调。
 * @returns 无。
 */
function showSharedContextMenu(
	menus: ContextMenus, items: readonly ContextMenuItem[], x: number, y: number, onClose: (() => void) | undefined,
): void {
	const visibleItems = items.filter((item) => item.visible !== false);
	if (visibleItems.length === 0) return;
	const actions = toSharedActions(visibleItems);
	if (actions.length === 0) return;
	const menuId = `source-control-${String(++sharedMenuSeq)}`;
	// 一次性贡献：动作表按 open 前登记、关闭即注销，插件因此不需要跨打开保存任何菜单状态。
	const unregister = menus.register({ id: menuId, target: 'source-control', order: 0, resolve: () => actions });
	/*
	 * 关闭与选中共用同一条收尾：共享菜单把 active 置为 null 表示本次打开结束，选中时
	 * 也会先置空。订阅必须在 open 之前建立，否则首个快照变化会被漏掉。
	 */
	const unsubscribe = menus.active.subscribe(() => {
		if (menus.active.getSnapshot() !== null) return;
		unsubscribe();
		unregister();
		onClose?.();
	});
	menus.open({ kind: 'source-control', value: { menuId } }, { x, y });
}

/**
 * 在光标位置弹出右键菜单。
 *
 * 宿主提供共享菜单时走它，否则由本模块自建浮层。
 *
 * @param options - 见 {@link ShowContextMenuOptions}。
 * @returns 无。
 */
export function showContextMenu({ items, x, y, onClose }: ShowContextMenuOptions): void {
	if (sharedMenus !== null) {
		showSharedContextMenu(sharedMenus, items, x, y, onClose);
		return;
	}
	const visibleItems = items.filter((item) => item.visible !== false);
	if (visibleItems.length === 0) return;
	const handlers = new Map<string, () => void>();
	const selectedIds: string[] = [];
	const entries = toEntries(visibleItems, handlers, selectedIds);
	const mount = document.createElement('div');
	document.body.appendChild(mount);
	const root = createRoot(mount);
	// 只有带二级菜单的菜单才需要翻转方向；属性存在期间样式才生效。
	const hasSubmenu = visibleItems.some((item) => (item.children ?? []).some((child) => child.visible !== false));
	const flipTokens = hasSubmenu ? submenuFlipTokens(x, y, window.innerWidth, window.innerHeight) : '';
	if (flipTokens !== '') document.body.setAttribute(SUBMENU_FLIP_ATTR, flipTokens);
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		document.body.removeAttribute(SUBMENU_FLIP_ATTR);
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
			if (!open) close();
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
			onClose: () => { setOpen(false); },
		});
	}
	root.render(React.createElement(MenuContent));
}
