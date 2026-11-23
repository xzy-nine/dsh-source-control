/**
 * 宿主共享菜单（`ctx.contextMenus`）的承载：把自建菜单项登记成动作贡献，关闭时注销。
 *
 * 弹窗、键盘导航与视口夹取都在宿主侧；本模块只把菜单项转成宿主的动作表、为补齐项提供
 * 一个刷新信号，并判定这份贡献何时作废。菜单项定义在 `context-menu.ts`。
 *
 * 对菜单包只有类型依赖：宿主未提供该服务时包本身不在运行栈里，实体导入会让插件加载失败。
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { ContextMenus, ContextMenuTarget, MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client';
import type { ContextMenuItem } from './context-menu.ts';

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
	interface ContextMenuTargetMap {
		/** 本插件自有目标：动作在打开期间按 menuId 捕获，菜单关闭即丢弃。 */
		'source-control': { readonly menuId: string };
	}
}

/** 打开中的共享菜单编号；每次打开递增，保证贡献 id 在宿主侧唯一。 */
let sharedMenuSeq = 0;

/**
 * 把一条自建菜单项转成共享菜单的动作。
 *
 * 共享菜单的条目类型没有勾选；分隔线转成下一条动作的 `separatorBefore`，末位单独的分隔线
 * 没有对应落点，直接略过。
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
 * @param pendingItems - 稍后补齐的菜单项；省略表示不补齐。
 * @param x - 触发点横坐标。
 * @param y - 触发点纵坐标。
 * @param onClose - 关闭后的回调。
 * @returns 无。
 */
export function showSharedContextMenu(
	menus: ContextMenus, items: readonly ContextMenuItem[], pendingItems: Promise<readonly ContextMenuItem[] | null> | undefined,
	x: number, y: number, onClose: (() => void) | undefined,
): void {
	const visibleItems = items.filter((item) => item.visible !== false);
	if (visibleItems.length === 0) return;
	const actions = toSharedActions(visibleItems);
	if (actions.length === 0) return;
	const menuId = `source-control-${String(++sharedMenuSeq)}`;
	const target: ContextMenuTarget = { kind: 'source-control', value: { menuId } };
	let released = false;
	/*
	 * 补齐项：共享菜单的 resolve 同步返回，异步结果要主动触发一次重新解析。注册表在 resolve
	 * 时对 `observe` 给出的每个源订阅一次并重新准备，因此这里用一个快照源充当刷新信号，
	 * 它的值不参与呈现。
	 */
	const signal = createSnapshotStore(0);
	let current = actions;
	if (pendingItems !== undefined) {
		void pendingItems.then((next) => {
			if (next === null || released) return;
			const visible = next.filter((item) => item.visible !== false);
			const nextActions = toSharedActions(visible);
			if (nextActions.length === 0) return;
			current = nextActions;
			signal.set(signal.getSnapshot() + 1);
		}).catch(() => { /* 补齐失败时保留首屏条目 */ });
	}
	// 一次性贡献：动作表按 open 前登记、关闭后注销，插件因此不需要跨打开保存任何菜单状态。
	const unregister = menus.register({
		id: menuId, target: 'source-control', order: 0,
		...(pendingItems === undefined ? {} : { observe: () => [signal] }),
		resolve: () => current,
	});
	/*
	 * 收尾推迟到选中动作之后，且判据是「活动目标已不是这一份」。
	 *
	 * select 的顺序是「置空 active → 再执行选中的 run」：在 active 变空的那一刻就注销贡献，
	 * registry 记住的回调会先被 abort 清掉，随后的 select 找不到动作而静默返回，菜单能弹出、
	 * 点击却没有任何效果。而打开菜单的顺序是「置空 active → 置入新目标」：紧跟着上一份菜单
	 * 再右键时，这一拍的空值落在刚登记的订阅上，据它收尾就会在弹窗出现前注销本份贡献——
	 * 菜单没有条目，活动目标又留在非空态，下一次右键重演同一过程，菜单从此打不开。因此空值
	 * 只当待复核信号，微任务里再看活动目标：仍是本份就继续活着，留空（真关闭）或换成别的
	 * 目标（被替换）才收尾。订阅仍须在 open 之前建立，否则首个快照变化会被漏掉。
	 */
	const isOwnTarget = (active: ContextMenuTarget | null): boolean =>
		active !== null && active.kind === 'source-control' && active.value.menuId === menuId;
	const release = (): void => {
		if (released) return;
		released = true;
		unsubscribe();
		unregister();
		onClose?.();
	};
	const unsubscribe = menus.active.subscribe(() => {
		if (isOwnTarget(menus.active.getSnapshot())) return;
		queueMicrotask(() => { if (!isOwnTarget(menus.active.getSnapshot())) release(); });
	});
	menus.open(target, { x, y });
}
