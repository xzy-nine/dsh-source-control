/**
 * 右键菜单入口：宿主提供共享菜单时交给它，否则由本模块自建浮层。
 *
 * 承载提交、分支、远程、标签、贮藏等目标的右键菜单项；带 children 的项成为二级菜单。
 * 自建浮层把菜单项交给 DSH 的 Menu 渲染，菜单项的圆角、悬停填充、键盘导航与视口夹取
 * 都由 Menu 提供，本模块只负责把自建的菜单项定义转成 Menu 的条目，并把指针坐标当作
 * 锚点矩形喂给它。共享菜单（`ctx.contextMenus`）的登记与注销在 `context-menu-host.ts`。
 *
 * 对菜单包只有类型依赖：宿主未提供该服务时包本身不在运行栈里，实体导入会让插件加载失败。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
	IconChevronRightOutlineRegular, Menu, type MenuEntry, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives';
import * as MenuPrimitives from '@deepseek-ai/dsh-client-ui-primitives';
import { SUBMENU_FLIP_ATTR } from '../css/state-classes.ts';
import type { ContextMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client';
import css from '../css/context-menu.module.css';
import { showSharedContextMenu } from './context-menu-host.ts';

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
	/** 菜单项列表；菜单打开后仍可被 {@link ShowContextMenuOptions.pendingItems} 替换。 */
	readonly items: readonly ContextMenuItem[];
	/**
	 * 稍后补齐的菜单项。
	 *
	 * 需要向 git 查询才完整的菜单（如「包含该提交的分支」）先用已算好的部分弹出，再把
	 * 查询结果整体替换进来：菜单不再等子进程往返，用户看到的是立刻响应。返回 null 表示
	 * 放弃替换（菜单已关闭或查询失败）。
	 */
	readonly pendingItems?: Promise<readonly ContextMenuItem[] | null>;
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
 * 宿主原语是否属于「CSS 锚点」这一代。
 *
 * 判据是 `usePointerGrace`：它与锚点定位重构同批引入，只有该代才导出。不能用
 * `MENU_TRANSITION_MS.prepare`——那个字段在 0.2.2-rc.1 就已经存在，用它会把 rc.1
 * 误判成新代。
 *
 * 这个判据决定二级菜单的翻向由谁负责：新代的子卡片用 `anchor-name` 定位并自带左翻
 * 回退，旧补丁的正负偏移会与它叠加；旧代子卡片固定向右展开且不夹取，必须由补丁翻转。
 */
const modernMenu = typeof (MenuPrimitives as { usePointerGrace?: unknown }).usePointerGrace === 'function';

/** 向右展开二级菜单所需的右侧余量（像素）。 */
const SUBMENU_RIGHT_ROOM = 400;

/**
 * 二级菜单的展开方向令牌。
 *
 * 旧宿主原语把二级菜单固定为向上、向右展开且不做视口夹取，在本插件贴右缘的面板里
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
 * 在光标位置弹出右键菜单。
 *
 * 宿主提供共享菜单时走它，否则由本模块自建浮层。
 *
 * @param options - 见 {@link ShowContextMenuOptions}。
 * @returns 无。
 */
export function showContextMenu({ items, pendingItems, x, y, onClose }: ShowContextMenuOptions): void {
	if (sharedMenus !== null) {
		showSharedContextMenu(sharedMenus, items, pendingItems, x, y, onClose);
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
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		root.unmount();
		mount.remove();
		onClose?.();
	};
	/*
	 * 补齐项：先按已算好的条目弹出，异步结果到达后整份替换。
	 *
	 * 替换在同一个组件实例里完成，菜单不重开也不闪；回调映射与勾选集一并重建，避免旧 id
	 * 残留到新条目上。
	 */
	const state = { entries, handlers, selectedIds };
	if (pendingItems !== undefined) {
		void pendingItems.then((next) => {
			if (closed || next === null) return;
			const visible = next.filter((item) => item.visible !== false);
			if (visible.length === 0) return;
			state.handlers = new Map<string, () => void>();
			state.selectedIds = [];
			state.entries = toEntries(visible, state.handlers, state.selectedIds);
			publish?.(state.entries);
		}).catch(() => { /* 补齐失败时保留首屏条目 */ });
	}
	/** 由组件实例装入：在补齐项到达后触发一次重渲染。 */
	let publish: ((entries: MenuEntry[]) => void) | null = null;
	/*
	 * 二级菜单方向：旧宿主的原语固定向上、向右展开且不夹取，贴右缘的面板里会被裁掉，
	 * 因此在打开期间挂一个属性让样式翻转。新宿主的子卡片用 CSS 锚点定位并自带左翻回退，
	 * 不需要也不理会这条补丁，故只在旧宿主上设置。
	 */
	const hasSubmenu = visibleItems.some((item) => (item.children ?? []).some((child) => child.visible !== false));
	const flipTokens = hasSubmenu && !modernMenu ? submenuFlipTokens(x, y, window.innerWidth, window.innerHeight) : '';
	if (flipTokens !== '') document.body.setAttribute(SUBMENU_FLIP_ATTR, flipTokens);
	/*
	 * 锚点同时按两代原语给出：新宿主认 `anchorPoint`（客户端坐标，自行夹取视口），
	 * 旧宿主认 `getAnchorRect`（自己量矩形）。两者互不认识对方那一个，多传的属性只被
	 * 忽略，因此同一份代码在两侧都能把菜单放到指针处。
	 *
	 * 旧宿主把菜单放在锚点矩形下方 4px，故矩形上移 4px 抵消；新宿主从坐标点直接展开，
	 * 不需要这个补偿，它也不读这个函数。
	 */
	const anchorProps = {
		anchorPoint: { x, y },
		getAnchorRect: () => new DOMRect(x, y - 4, 0, 0),
	};
	/*
	 * `contextual` 是新宿主的指针菜单模式：去掉首行上方留白、按上下文菜单排布。旧宿主
	 * 不认识这个属性而直接忽略，因此两侧可以共用同一份 props。
	 */
	const contextualProps = modernMenu ? { contextual: true } : {};
	function MenuContent(): React.ReactElement {
		const [open, setOpen] = React.useState(true);
		const [current, setCurrent] = React.useState(state.entries);
		React.useEffect(() => {
			publish = setCurrent;
			return () => { publish = null; };
		}, []);
		React.useEffect(() => {
			if (!open) close();
		}, [open]);
		return React.createElement(Menu, {
			open,
			anchor: null,
			items: current,
			selectedIds: state.selectedIds,
			portal: true,
			...anchorProps,
			...contextualProps,
			onSelect: (id: string) => {
				setOpen(false);
				state.handlers.get(id)?.();
			},
			onClose: () => { setOpen(false); },
		});
	}
	root.render(React.createElement(MenuContent));
}
