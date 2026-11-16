/**
 * 右键菜单入口：菜单项定义与弹出调用，弹窗由宿主的共享菜单渲染。
 *
 * 承载提交、分支、远程、标签、贮藏等目标的右键菜单项；带 children 的项成为二级菜单。
 * 弹窗、键盘导航与视口夹取在宿主侧，动作贡献的登记与注销见 `context-menu-host.ts`。
 *
 * 对菜单包只有类型依赖：实体导入会让不装该包的宿主在加载插件时失败。
 */
import type { ContextMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client';
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
	/** 为 false 时该项不渲染。 */
	readonly visible?: boolean;
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
 * 宿主共享菜单服务；未装载时为 null。
 *
 * 由插件入口在 `ctx.inject(['contextMenus'])` 里装入。该服务是菜单弹窗唯一的承载，
 * 缺席时右键不弹出菜单（引擎下限已保证宿主提供它）。
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
 * @param options - 见 {@link ShowContextMenuOptions}。
 * @returns 无。
 */
export function showContextMenu({ items, pendingItems, x, y, onClose }: ShowContextMenuOptions): void {
	if (sharedMenus === null) return;
	showSharedContextMenu(sharedMenus, items, pendingItems, x, y, onClose);
}
