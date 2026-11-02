/**
 * 提交行与引用标记的右键菜单：菜单装配与依赖面。
 *
 * 操作元数据（id、`refTypes`、`commitTarget`、菜单名称与排列顺序）以 `menu-actions.json` 为唯一
 * 数据源，经 ./menu-actions.ts 补缺省后读入；处理函数按域放在 ./menu/ 下，由 ./menu/registry.ts
 * 合成一张表。新增一项操作 = 在 JSON 里加一条 + 在对应域模块里补一个同 id 的处理函数。
 *
 * 提交菜单的顺序另在本文件的 `buildCommitItems` 中给出：新增作用于提交行的操作时需在那里列出，
 * 引用菜单则自动按 `refTypes` 过滤。
 */
import {
	addTag, branchesContaining, checkoutCommit, cherrypickCommit, createBranch, resetToCommit, revertCommit, throwIfError,
} from '../api/index.ts';
import { copyText, openExternal, showContextMenu, type ContextMenuItem } from '../ui/context-menu.ts';
import { showCheckbox, showSelect, showText } from '../ui/dialog.ts';
import { githubCommitUrl, githubRemoteNames, remoteNameOfBranch } from './github.ts';
import { checkoutFailureText } from './git-messages.ts';
import { COMMIT_MENU, MENU_ACTIONS } from './menu-actions.ts';
import type { Commit } from '../shared/types.ts';
import { MENU_TARGET_CLASS } from '../css/state-classes.ts';
import type { GraphMenuDeps, MenuAction, MenuContext, RefMenuTarget } from './menu/shared.ts';
export type { GraphMenuDeps, RefMenuTarget } from './menu/shared.ts';
import { BUILDERS } from './menu/registry.ts';


/**
 * 注册表：元数据取自生成的 `MENU_ACTIONS`，处理函数按 id 绑定。
 *
 * 数组顺序即 JSON 里的顺序，提交菜单与引用菜单都按它渲染。
 */
const ACTIONS: readonly MenuAction[] = MENU_ACTIONS.map((meta) => ({
	...meta,
	/*
	 * 每个操作各自给 `run` 注入意图：菜单项的处理函数在构建时就绑定了操作，日志因此能记下
	 * 用户点的是哪一项，而不只是随后执行了哪条 git 命令。
	 */
	build: (ctx: MenuContext) => BUILDERS[meta.id](
		{ ...ctx, deps: { ...ctx.deps, run: (scope, operation) => ctx.deps.run(scope, operation, meta.title) } },
		meta,
	),
}));

/** 按 id 取一项引用操作。 */
const ACTION_BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));

/**
 * 构建一次菜单的上下文。
 *
 * @param deps - 菜单依赖面。
 * @param commit - 目标提交。
 * @param ref - 引用目标；提交行右键为 null。
 * @param currentHashes - 当前分支可达的提交哈希集合。
 * @returns 构建上下文。
 */
async function makeContext(deps: GraphMenuDeps, commit: Commit, ref: RefMenuTarget | null, currentHashes: ReadonlySet<string>): Promise<MenuContext> {
	const repo = deps.workingTreePath as string;
	const isUncommitted = commit.hash === '*';
	// 分支只由尖端提交标识，中间提交需按「包含」关系查询；查询失败时退回该提交自身的引用。
	// 包含关系只用于判断提交是否已在远程上（GitHub 入口），不作为可操作的分支候选。
	const containing = deps.workingTreePath === null || isUncommitted
		? { local: [], remote: [], foreign: [] }
		: await branchesContaining(repo, commit.hash).catch(() => ({ local: [], remote: [], foreign: [] }));
	return {
		deps, commit, ref, repo, isUncommitted,
		tipBranches: isUncommitted ? [] : (commit.heads ?? []),
		// 远程 HEAD 是指向分支的符号引用，不作为可签出的目标。
		tipRemoteBranches: isUncommitted
			? []
			: (commit.remotes ?? []).map((remote) => remote.name).filter((name) => !name.endsWith('/HEAD')),
		remoteBranches: containing.remote.length > 0
			? containing.remote
			: (commit.remotes ?? []).map((remote) => remote.name),
		tagNames: (commit.tags ?? []).map((tag) => tag.name),
		onCurrentBranch: isUncommitted || currentHashes.has(commit.hash),
		foreignBranches: new Set([...(deps.foreignBranches ?? []), ...containing.foreign]),
	};
}

/**
 * 构建提交行右键菜单项。
 *
 * 分支与标签操作都取自注册表：分支操作直接渲染，标签操作按 `commitTarget` 属性渲染，
 * 因此提交菜单与引用菜单共用同一份定义。
 *
 * @param ctx - 构建上下文。
 * @returns 菜单项。
 */
function buildCommitItems(ctx: MenuContext): ContextMenuItem[] {
	const { commit, deps, isUncommitted } = ctx;
	// 只有已同步到 GitHub 远程的提交才有对应网页：本地独有的提交打开会得到 404。
	const githubRemotes = githubRemoteNames(deps.remotes);
	const onGithub = ctx.remoteBranches.some((branch) => githubRemotes.has(remoteNameOfBranch(branch)));
	const githubUrl = isUncommitted || !onGithub ? null : githubCommitUrl(deps.remotes, commit.hash);
	const byId = (id: string): ContextMenuItem | null => ACTION_BY_ID.get(id)?.build(ctx) ?? null;
	const push = (items: ContextMenuItem[], item: ContextMenuItem | null): void => { if (item !== null) items.push(item); };
	/**
	 * 构建作用于提交标签的操作。
	 *
	 * 这些操作与引用菜单共用注册表，按 `commitTarget` 属性取出。Menu 只渲染一层二级菜单，
	 * 因此这里平铺、不再套一层「标签」分组；多标签时各操作自身已收进以标签名为子项的
	 * 二级菜单，再加一层会超出 Menu 的能力而无法点击。
	 *
	 * @returns 标签操作的菜单项；无适用项时为空数组。
	 */
	const tagActions = (): ContextMenuItem[] => {
		if (isUncommitted) return [];
		const built: ContextMenuItem[] = [];
		for (const action of ACTIONS) {
			if (action.commitTarget !== 'tag') continue;
			push(built, action.build(ctx));
		}
		return built;
	};
	const tagItems = tagActions();

	const items: ContextMenuItem[] = [];
	push(items, { title: COMMIT_MENU.openOnGitHub, visible: githubUrl !== null, onClick: () => { openExternal(githubUrl as string); } });
	// 首项隐藏时不留一条悬空的分隔线在菜单顶部。
	items.push({ type: 'divider', visible: githubUrl !== null });
	push(items, byId('checkoutBranch'));
	push(items, { title: COMMIT_MENU.checkoutDetached, disabled: isUncommitted, onClick: () => { void deps.run('history', async () => { throwIfError(await checkoutCommit(ctx.repo, commit.hash), checkoutFailureText); }); } });
	items.push({ type: 'divider' });
	push(items, { title: COMMIT_MENU.createBranch, disabled: isUncommitted, onClick: () => {
		void (async () => {
			const name = await showText({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' });
			if (name !== null && name !== '') void deps.run('history', async () => { throwIfError(await createBranch(ctx.repo, name, commit.hash, true)); });
		})();
	} });
	push(items, byId('deleteBranch'));
	// PR 是分支级操作，作用于当前分支而非选中的提交；条件不满足时该项自身返回 null。
	push(items, byId('createPullRequest'));
	// 标签相关操作自成一组：用分割线与上方的分支操作、下方的提交操作隔开。
	// 未提交伪提交上既不能创建标签、也没有标签可操作，整组不显示。
	if (!isUncommitted) {
		items.push({ type: 'divider' });
		push(items, { title: COMMIT_MENU.createTag, onClick: () => {
			void (async () => {
				const name = await showText({ title: '创建标签', label: '标签名', placeholder: 'v1.0.0' });
				if (name === null || name === '') return;
				/*
				 * 创建后一并推送到远程：标签与它指向的提交一起发布，不需要单独推送。
				 * 没有远程时只创建本地标签；多个远程时由用户选一个，不静默挑第一个。
				 */
				const { remotes } = deps;
				const remote = remotes.length === 0 ? null
					: remotes.length === 1 ? remotes[0].name
						: await showSelect({ title: '推送标签到远程', options: remotes.map((item) => ({ value: item.name, label: item.name })) });
				// 多远程时取消（null）与空选择都按用户取消处理；没有远程时 remote 为 null，只创建本地标签。
				if (remotes.length > 1 && (remote === null || remote === '')) return;
				void deps.run('history', async () => { throwIfError(await addTag(ctx.repo, name, commit.hash, 0, '', false, remote)); });
			})();
		} });
		for (const item of tagItems) items.push(item);
	}
	items.push({ type: 'divider' });
	push(items, { title: COMMIT_MENU.cherrypick, hint: COMMIT_MENU.cherrypickHint, disabled: isUncommitted, onClick: () => { void deps.run('history', async () => { throwIfError(await cherrypickCommit(ctx.repo, commit.hash)); }); } });
	push(items, { title: COMMIT_MENU.revert, hint: COMMIT_MENU.revertHint, disabled: isUncommitted, onClick: () => { void deps.run('history', async () => { throwIfError(await revertCommit(ctx.repo, commit.hash)); }); } });
	items.push({ type: 'divider' });
	// 重置只对当前分支可达的提交有意义：重置到其他分支的提交会改写当前分支。
	push(items, ctx.onCurrentBranch ? { title: COMMIT_MENU.resetHere, danger: true, disabled: isUncommitted, children: [
		{ title: COMMIT_MENU.resetSoft, hint: COMMIT_MENU.resetSoftHint, onClick: () => { void deps.run('history', async () => { throwIfError(await resetToCommit(ctx.repo, commit.hash, 'soft')); }); } },
		{ title: COMMIT_MENU.resetMixed, hint: COMMIT_MENU.resetMixedHint, onClick: () => { void deps.run('history', async () => { throwIfError(await resetToCommit(ctx.repo, commit.hash, 'mixed')); }); } },
		{ title: COMMIT_MENU.resetHard, hint: COMMIT_MENU.resetHardHint, danger: true, onClick: () => {
			void (async () => {
				const ok = await showCheckbox({
					title: '重置当前分支',
					message: `当前分支将重置到 ${commit.hash.slice(0, 7)}（硬重置）。未提交的改动会丢失。`,
					checkboxLabel: '我已知晓并继续', danger: true,
				});
				if (ok) void deps.run('history', async () => { throwIfError(await resetToCommit(ctx.repo, commit.hash, 'hard')); });
			})();
		} },
	] } : null);
	push(items, byId('rebaseOnto'));
	push(items, byId('mergeIntoBranch'));
	items.push({ type: 'divider' });
	push(items, { title: COMMIT_MENU.copyHash, onClick: () => { void copyText(commit.hash); } });
	push(items, { title: COMMIT_MENU.copyMessage, onClick: () => { void copyText(commit.message ?? ''); } });
	return items;
}

/**
 * 提交行右键菜单。
 *
 * @param deps - 见 {@link GraphMenuDeps}。
 * @param args - 目标提交、当前分支可达的提交集合与触发事件。
 * @returns 无。
 */
export async function openCommitMenu(
	deps: GraphMenuDeps,
	{ commit, event, currentHashes }: { commit: Commit; event: React.MouseEvent<HTMLElement>; currentHashes: ReadonlySet<string> },
): Promise<void> {
	// React 的 currentTarget 只在事件派发期间有效，本函数会 await，因此先在同步段取出。
	const target = event.currentTarget;
	const { clientX, clientY } = event;
	const ctx = await makeContext(deps, commit, null, currentHashes);
	target.classList.add(MENU_TARGET_CLASS);
	showContextMenu({
		x: clientX, y: clientY,
		onClose: () => { target.classList.remove(MENU_TARGET_CLASS); },
		items: buildCommitItems(ctx),
	});
}

/**
 * 引用标记（分支 / 远程分支 / 标签 / 贮藏）右键菜单。
 *
 * 菜单项取自与提交菜单相同的注册表，按被点击引用的类型过滤；因此引用菜单只显示该类型的
 * 相关操作，不另行维护一份定义。
 *
 * @param deps - 见 {@link GraphMenuDeps}。
 * @param args - 目标提交、引用信息、当前分支可达的提交集合与触发事件。
 * @returns 无。
 */
export async function openRefMenu(
	deps: GraphMenuDeps,
	{ commit, refInfo, event, currentHashes }: { commit: Commit; refInfo: RefMenuTarget; event: React.MouseEvent<HTMLElement>; currentHashes: ReadonlySet<string> },
): Promise<void> {
	const target = event.currentTarget;
	const { clientX, clientY } = event;
	const ctx = await makeContext(deps, commit, refInfo, currentHashes);
	const items: ContextMenuItem[] = [];
	for (const action of ACTIONS) {
		if (!action.refTypes.includes(refInfo.type)) continue;
		const item = action.build(ctx);
		if (item !== null) items.push(item);
	}
	if (items.length === 0) return;
	target.classList.add(MENU_TARGET_CLASS);
	showContextMenu({
		x: clientX, y: clientY,
		onClose: () => { target.classList.remove(MENU_TARGET_CLASS); },
		items,
	});
}