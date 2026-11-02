/**
 * 右键菜单的构建上下文与共用构件：分支项置灰、远程分支弹名、复制引用名、确认后执行、标签二级菜单。
 */
import { copyText } from '../../ui/context-menu.ts';
import type { ContextMenuItem } from '../../ui/context-menu.ts';
import { showConfirmation, showText } from '../../ui/dialog.ts';
import type { ConfirmationOptions } from '../../ui/dialog.ts';
import type { MenuActionMeta } from '../menu-actions.ts';
import type { BusyScope, Commit, Remote } from '../../shared/types.ts';

/** 引用菜单识别出的目标。 */
export interface RefMenuTarget {
	/** 引用类型：head / remote / tag / stash。 */
	readonly type: string;
	/** 引用名称。 */
	readonly name: string;
	/** 远程名；远程分支时提供。 */
	readonly remote?: string | null;
}

/** 右键菜单的依赖面。 */
export interface GraphMenuDeps {
	/** 当前工作树路径。 */
	readonly workingTreePath: string | null;
	/**
	 * 执行一次仓库操作并刷新；菜单里的操作都属于 history 影响面。
	 *
	 * `intent` 是给日志用的用户意图描述（如「检出分支 dev」）：日志里只有 git 命令时
	 * 无法把「用户点了什么」和命令对上。
	 */
	readonly run: (scope: BusyScope, operation: () => Promise<void>, intent?: string) => Promise<void>;
	/** 远端列表。 */
	readonly remotes: readonly Remote[];
	/** 创建归档。 */
	readonly handleCreateArchive: (ref: string, refLabel: string) => Promise<void>;
	/** 当前分支名。 */
	readonly head: string | null;
	/** 一般提示：用于说明当前条件下操作无法进行的原因。 */
	readonly notify: (message: string) => Promise<void>;
	/** 创建 Pull Request：由面板负责选目标分支、填标题正文并调用 gh。 */
	readonly handleCreatePullRequest: () => Promise<void>;
	/** 当前分支是否有可创建 PR 的远程：无 GitHub 远程时该项不显示。 */
	readonly canCreatePullRequest: boolean;
	/** 被别的工作树检出的本地分支：照常显示，但检出、删除与重命名不可用。 */
	readonly foreignBranches?: readonly string[];
	/** 写入提交信息框；合并到选中分支后填入 git 生成的初始信息。 */
	readonly setCommitMessage: (message: string) => void;
}

/** 一次构建的上下文。 */
export interface MenuContext {
	readonly deps: GraphMenuDeps;
	readonly commit: Commit;
	/** 引用标记右键时的目标；提交行右键为 null。 */
	readonly ref: RefMenuTarget | null;
	readonly repo: string;
	readonly isUncommitted: boolean;
	/** 以该提交为尖端的本地分支。 */
	readonly tipBranches: readonly string[];
	/** 以该提交为尖端的远程分支，形态为 `远程名/分支名`。 */
	readonly tipRemoteBranches: readonly string[];
	/** 包含该提交的远程分支。 */
	readonly remoteBranches: readonly string[];
	readonly tagNames: readonly string[];
	/** 该提交是否在当前分支上；重置这类改写当前分支的操作据此显示。 */
	readonly onCurrentBranch: boolean;
	/**
	 * 被别的工作树检出的本地分支。
	 *
	 * 这类分支照常作为标签显示，但检出、删除与重命名都会失败或改变别的工作树的检出状态，
	 * 菜单项因此置为不可用并说明原因。
	 */
	readonly foreignBranches: ReadonlySet<string>;
}

/** 一项引用操作：元数据来自 `menu-actions.json`，处理函数在 `BUILDERS` 里按 id 绑定。 */
export interface MenuAction extends MenuActionMeta {
	/**
	 * 构建菜单项。
	 *
	 * @param ctx - 构建上下文。
	 * @returns 菜单项；该上下文下不适用时为 null。
	 */
	build(ctx: MenuContext): ContextMenuItem | null;
}

/**
 * 去掉远程分支短名的远程名前缀。
 *
 * @param name - 远程分支短名，形态为 `远程名/分支名`。
 * @returns 分支名。
 */
export function shortBranchName(name: string): string {
	return name.replace(/^[^/]+\//, '');
}

/**
 * 判定 `git branch -d` 的拒绝原因是否是「分支未合并」。
 *
 * git 的措辞随版本与语言环境不同（英文为 `not fully merged`），执行层已固定英文环境；
 * 其余拒绝原因（被别的工作树检出、分支不存在等）不属于可强制删除的情形，应原样说明。
 *
 * @param message - `git branch -d` 失败时的 stderr 文本。
 * @returns 是未合并导致时为 true。
 */
export function isUnmergedRefusal(message: string): boolean {
	return /not fully merged/i.test(message);
}

/** 分支被别的工作树检出时给出的说明；用于不可用的菜单项。 */
const FOREIGN_BRANCH_HINT = '该分支正被别的工作树检出，不能在此工作树操作';

/**
 * 判定一个本地分支能否在本工作树操作。
 *
 * @param ctx - 构建上下文。
 * @param name - 本地分支名。
 * @returns 被别的工作树检出时为 true。
 */
export function isForeignBranch(ctx: MenuContext, name: string): boolean {
	return ctx.foreignBranches.has(name);
}

/**
 * 把一项本地分支操作渲染成菜单项：被别的工作树检出时置灰并说明原因。
 *
 * @param ctx - 构建上下文。
 * @param name - 本地分支名。
 * @param item - 可用时的菜单项。
 * @returns 菜单项。
 */
export function localBranchItem(ctx: MenuContext, name: string, item: ContextMenuItem): ContextMenuItem {
	if (!isForeignBranch(ctx, name)) return item;
	return { ...item, disabled: true, title: `${item.title}（${FOREIGN_BRANCH_HINT}）` };
}

/**
 * 把一项远程分支操作渲染成菜单项：先问本地分支名，确认后执行。
 *
 * @param ctx - 构建上下文。
 * @param meta - 操作元数据，取菜单名称。
 * @param title - 输入框标题。
 * @param act - 拿到本地分支名后的执行体；入参为已收窄的引用目标。
 * @param placeholder - 输入框占位提示。
 * @returns 菜单项；没有引用目标时为 null。
 */
export function branchFromRemoteItem(
	ctx: MenuContext,
	meta: MenuActionMeta,
	title: string,
	act: (ref: RefMenuTarget, localName: string) => void,
	placeholder = '',
): ContextMenuItem | null {
	const ref = ctx.ref;
	if (ref === null) return null;
	const short = shortBranchName(ref.name);
	return {
		title: meta.title,
		onClick: () => {
			void (async () => {
				const localName = await showText({ title, label: '本地分支名', value: short, placeholder });
				if (localName !== null && localName !== '') act(ref, localName);
			})();
		},
	};
}

/**
 * 把「复制引用名」渲染成菜单项。
 *
 * @param ctx - 构建上下文。
 * @param meta - 操作元数据，取菜单名称。
 * @returns 菜单项；没有引用目标时为 null。
 */
export function copyRefNameItem(ctx: MenuContext, meta: MenuActionMeta): ContextMenuItem | null {
	const ref = ctx.ref;
	if (ref === null) return null;
	return { title: meta.title, onClick: () => { void copyText(ref.name); } };
}

/**
 * 先弹确认框，确认后执行一步仓库操作。
 *
 * @param confirm - 确认框选项。
 * @param act - 确认后的执行体。
 * @returns 点击处理函数。
 */
export function confirmThenRun(confirm: ConfirmationOptions, act: () => void): () => void {
	return () => {
		void (async () => {
			const ok = await showConfirmation(confirm);
			if (ok) act();
		})();
	};
}

/**
 * 取一项标签操作的目标标签。
 *
 * 引用菜单右键时只有被点击的那个标签；提交行右键时是该提交上的全部标签。
 *
 * @param ctx - 构建上下文。
 * @returns 目标标签名；无目标时为空数组。
 */
export function tagTargets(ctx: MenuContext): readonly string[] {
	return ctx.ref !== null ? [ctx.ref.name] : ctx.tagNames;
}

/**
 * 把一项标签操作渲染成菜单项。
 *
 * 只有一个目标时直接显示该项；多个目标时收进以标签名为子项的二级菜单，`danger`
 * 一并带到子项，危险操作在二级菜单里仍保持危险样式。
 *
 * @param targets - 目标标签名。
 * @param parentTitle - 多个目标时二级菜单入口的文案。
 * @param build - 由标签名构造菜单项。
 * @returns 菜单项。
 */
export function tagItem(targets: readonly string[], parentTitle: string, build: (tagName: string) => ContextMenuItem): ContextMenuItem {
	if (targets.length === 1) return build(targets[0]);
	return {
		title: parentTitle,
		children: targets.map((name) => {
			const item = build(name);
			return { title: name, danger: item.danger, onClick: item.onClick };
		}),
	};
}