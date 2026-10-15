/**
 * 变更区的右键菜单：单一操作注册表。
 *
 * 文件夹行、文件行与分组标题行原本各手写一份菜单，新增操作时容易只改其中一处（丢弃改动
 * 曾只挂在文件行上）。这里把三者收敛到一份定义：操作元数据与菜单名称取自
 * change-menu-actions.json，处理函数在本文件的 BUILDERS 里按 id 绑定；菜单按目标过滤后
 * 依次构建，相邻操作分组不同时自动插分隔线。
 *
 * 与 React 无关的纯模块，可直接单测：新增操作 = JSON 加一条 + 这里补一个同 id 的处理函数。
 */
import type { ContextMenuItem } from '../ui/context-menu.ts';
import type { WorkingTreeEntry } from '../shared/types.ts';
import { CHANGE_MENU_ACTIONS, groupOf, titleOf, type ChangeMenuActionMeta, type ChangeMenuTarget } from './change-menu-actions.ts';

export type { ChangeMenuTarget } from './change-menu-actions.ts';

/** 右键一个目标时已算好的数据与回调。 */
export interface ChangeMenuDeps {
	/** 面板是否正在执行仓库操作。 */
	readonly busy: boolean;
	/** 该行是否属于「已暂存的更改」分组。 */
	readonly staged: boolean;
	/** 暂存路径。 */
	readonly onStage: (paths: readonly string[]) => void;
	/** 取消暂存路径。 */
	readonly onUnstage: (paths: readonly string[]) => void;
	/** 丢弃一个文件行的改动。 */
	readonly onDiscard: (paths: readonly string[], untracked: boolean) => void;
	/** 丢弃某个文件夹下的全部改动。 */
	readonly onDiscardFolder: (folderPath: string) => void;
	/** 丢弃该分组内全部改动。 */
	readonly onDiscardGroup: () => void;
	/** 打开文件。 */
	readonly onOpen: (entry: WorkingTreeEntry, isNew: boolean) => void;
	/** 把路径加入最近的 .gitignore。 */
	readonly onAddToGitignore: (path: string) => void;
	/** 把路径加入本地排除文件。 */
	readonly onAddToLocalExclude: (path: string) => void;
	/** 复制路径到剪贴板。 */
	readonly onCopyPath: (path: string) => void;
}

/** 一次菜单构建的上下文。 */
export interface ChangeMenuContext {
	/** 被右键的目标。 */
	readonly target: ChangeMenuTarget;
	/** 数据与回调。 */
	readonly deps: ChangeMenuDeps;
	/** 文件夹行或文件行的路径；分组菜单为 null。 */
	readonly path: string | null;
	/** 文件夹行下的路径集合、文件行的单一路径、分组内的全部路径。 */
	readonly paths: readonly string[];
	/** 文件行的条目；文件夹行与分组菜单为 null。 */
	readonly entry: WorkingTreeEntry | null;
	/** 文件行是否对应新增文件（没有旧侧内容，按普通文件打开）。 */
	readonly isNew: boolean;
	/** 文件行是否是未跟踪文件。 */
	readonly untracked: boolean;
}

/**
 * 取一项操作在当前目标下的菜单名称。
 *
 * @param meta - 操作元数据。
 * @param ctx - 构建上下文。
 * @returns 菜单名称；已代入路径数量。
 */
function labelOf(meta: ChangeMenuActionMeta, ctx: ChangeMenuContext): string {
	if (ctx.target === 'file' && ctx.isNew) return meta.newTitle;
	return titleOf(meta, ctx.target).replace('{count}', String(ctx.paths.length));
}

/** 是否禁用：忙碌或没有可操作的路径。 */
function disabledFor(ctx: ChangeMenuContext): boolean {
	return ctx.deps.busy || ctx.paths.length === 0;
}

/** 各操作的处理函数；键为 JSON 里给出的 id，缺一个会编译报错。 */
const BUILDERS: Readonly<Record<string, (ctx: ChangeMenuContext, meta: ChangeMenuActionMeta) => ContextMenuItem | null>> = {
	open: (ctx, meta) => (ctx.entry === null
		? null
		: { title: labelOf(meta, ctx), onClick: () => ctx.deps.onOpen(ctx.entry as WorkingTreeEntry, ctx.isNew) }),
	stage: (ctx, meta) => (ctx.deps.staged
		? null
		: { title: labelOf(meta, ctx), disabled: disabledFor(ctx), onClick: () => ctx.deps.onStage(ctx.paths) }),
	discard: (ctx, meta) => {
		if (ctx.deps.staged) return null;
		const base = { title: labelOf(meta, ctx), danger: meta.danger, disabled: disabledFor(ctx) };
		if (ctx.target === 'group') return { ...base, onClick: () => ctx.deps.onDiscardGroup() };
		if (ctx.target === 'folder') return { ...base, onClick: () => ctx.deps.onDiscardFolder(ctx.path as string) };
		return { ...base, onClick: () => ctx.deps.onDiscard(ctx.paths, ctx.untracked) };
	},
	unstage: (ctx, meta) => (ctx.deps.staged
		? { title: labelOf(meta, ctx), disabled: disabledFor(ctx), onClick: () => ctx.deps.onUnstage(ctx.paths) }
		: null),
	// 忽略规则只对未暂存的路径提出：已暂存的内容已经在版本控制里。
	addToGitignore: (ctx, meta) => (ctx.deps.staged || ctx.path === null
		? null
		: { title: meta.title, disabled: ctx.deps.busy, onClick: () => ctx.deps.onAddToGitignore(ctx.path as string) }),
	addToLocalExclude: (ctx, meta) => (ctx.deps.staged || ctx.path === null
		? null
		: { title: meta.title, disabled: ctx.deps.busy, onClick: () => ctx.deps.onAddToLocalExclude(ctx.path as string) }),
	copyPath: (ctx, meta) => (ctx.path === null
		? null
		: { title: meta.title, onClick: () => ctx.deps.onCopyPath(ctx.path as string) }),
};

/** 注册表：元数据取自 JSON，处理函数按 id 绑定。 */
const ACTIONS = CHANGE_MENU_ACTIONS.map((meta) => ({ ...meta, build: (ctx: ChangeMenuContext) => BUILDERS[meta.id](ctx, meta) }));

/**
 * 构建一次右键菜单的条目。
 *
 * 按目标过滤操作，构建出非空项后按分组插分隔线：相邻两项分组不同才插，因此首项之前与
 * 末项之后不留悬空的分隔线。
 *
 * @param ctx - 构建上下文。
 * @returns 菜单项；该目标下无可用项时为空数组。
 */
export function changeMenuItems(ctx: ChangeMenuContext): ContextMenuItem[] {
	const items: ContextMenuItem[] = [];
	let lastGroup: string | null = null;
	for (const action of ACTIONS) {
		if (!action.targets.includes(ctx.target)) continue;
		const item = action.build(ctx);
		if (item === null) continue;
		const group = groupOf(action, ctx.target);
		if (lastGroup !== null && group !== lastGroup) items.push({ type: 'divider' });
		items.push(item);
		lastGroup = group;
	}
	return items;
}
