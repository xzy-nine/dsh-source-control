/**
 * 提交行与引用标记的右键菜单：单一操作注册表。
 *
 * 每个分支/引用操作声明它适用的引用类型（`refTypes`）。提交行右键把分支操作渲染为以
 * 候选分支为目标的二级菜单，引用标记右键则直接作用于被点击的引用；两处菜单由同一份
 * 定义驱动，不再各自维护一份。提交菜单的顺序另在 `buildCommitItems` 中给出：新增作用于
 * 提交行的操作时需在那里列出，引用菜单则自动按 `refTypes` 过滤。
 */
import {
	addTag, applyStash, branchFromStash, branchesContaining, checkoutBranch, checkoutCommit,
	cherrypickCommit, createBranch, deleteBranch, deleteRemoteBranch, deleteTag, dropStash,
	fetchIntoLocalBranch, merge, mergeIntoBranch, popStash, pushTag, rebase, renameBranch,
	resetToCommit, revertCommit, throwIfError,
} from '../api/index.ts';
import { copyText, openExternal, showContextMenu, type ContextMenuItem } from '../context-menu.ts';
import { showCheckbox, showConfirmation, showSelect, showText } from '../dialog.ts';
import { githubCommitUrl, githubRemoteNames, remoteNameOfBranch } from './github.ts';
import { checkoutFailureText } from './git-messages.ts';
import type { BusyScope, Commit, Remote } from '../types.ts';
import { MENU_TARGET_CLASS } from '../css/state-classes.ts';
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
	/** 执行一次仓库操作并刷新；菜单里的操作都属于 history 影响面。 */
	readonly run: (scope: BusyScope, operation: () => Promise<void>) => Promise<void>;
	/** 远端列表。 */
	readonly remotes: readonly Remote[];
	/** 创建归档。 */
	readonly handleCreateArchive: (ref: string, refLabel: string) => Promise<void>;
	/** 当前分支名。 */
	readonly head: string | null;
	/** 一般提示：用于说明当前条件下操作无法进行的原因。 */
	readonly notify: (message: string) => Promise<void>;
	/** 查看标签详情。 */
	readonly handleTagDetails: (tagName: string, commitHash: string) => Promise<void>;
	/** 创建 Pull Request：由面板负责选目标分支、填标题正文并调用 gh。 */
	readonly handleCreatePullRequest: () => Promise<void>;
	/** 当前分支是否有可创建 PR 的远程：无 GitHub 远程时该项不显示。 */
	readonly canCreatePullRequest: boolean;
	/** 写入提交信息框；合并到选中分支后填入 git 生成的初始信息。 */
	readonly setCommitMessage: (message: string) => void;
}

/** 一次构建的上下文。 */
interface MenuContext {
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
}

/** 一项引用操作。 */
interface MenuAction {
	/** 稳定标识，供提交菜单按序引用。 */
	readonly id: string;
	/** 适用的引用类型；引用菜单据此过滤。 */
	readonly refTypes: readonly string[];
	/**
	 * 在提交行菜单中的呈现方式。
	 *
	 * `tag` 表示该操作作用于提交上的标签；省略表示不在提交行菜单中出现（贮藏等只在
	 * 对应引用上才有目标，储藏行右键会被识别为它的贮藏引用，同样走引用菜单）。
	 */
	readonly commitTarget?: 'tag';
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
function shortBranchName(name: string): string {
	return name.replace(/^[^/]+\//, '');
}

/**
 * 取一项标签操作的目标标签。
 *
 * 引用菜单右键时只有被点击的那个标签；提交行右键时是该提交上的全部标签。
 *
 * @param ctx - 构建上下文。
 * @returns 目标标签名；无目标时为空数组。
 */
function tagTargets(ctx: MenuContext): readonly string[] {
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
function tagItem(targets: readonly string[], parentTitle: string, build: (tagName: string) => ContextMenuItem): ContextMenuItem {
	if (targets.length === 1) return build(targets[0]);
	return {
		title: parentTitle,
		children: targets.map((name) => {
			const item = build(name);
			return { title: name, danger: item.danger, onClick: item.onClick };
		}),
	};
}

/** 全部引用操作；提交菜单与引用菜单共用这一份定义。 */
const ACTIONS: readonly MenuAction[] = [
	{
		id: 'checkoutBranch',
		refTypes: ['head'],
		build: (ctx) => {
			const { deps } = ctx;
			if (ctx.ref !== null) {
				const name = ctx.ref.name;
				return {
					title: '检出此分支', disabled: name === deps.head,
					onClick: () => { void deps.run('history', async () => { throwIfError(await checkoutBranch(ctx.repo, name, null), checkoutFailureText); }); },
				};
			}
			/*
			 * 提交行右键：本地尖端分支与远程尖端分支都列。远程分支按去掉远程名的短名检出，由 git 决定
			 * 是新建跟踪分支（本地没有同名分支）还是检出已有本地分支；本地已有同名尖端分支时不重复列出。
			 */
			const localNames = new Set(ctx.tipBranches);
			const remoteTips = ctx.tipRemoteBranches.filter((name) => !localNames.has(shortBranchName(name)));
			if (localNames.size === 0 && remoteTips.length === 0) return null;
			return {
				title: '签出到',
				children: [
					...ctx.tipBranches.map((name) => ({
						title: name === deps.head ? `${name}（当前）` : name,
						disabled: name === deps.head,
						onClick: () => { void deps.run('history', async () => { throwIfError(await checkoutBranch(ctx.repo, name, null), checkoutFailureText); }); },
					})),
					...remoteTips.map((name) => ({
						title: `${name}（远程）`,
						onClick: () => { void deps.run('history', async () => { throwIfError(await checkoutBranch(ctx.repo, shortBranchName(name), null), checkoutFailureText); }); },
					})),
				],
			};
		},
	},
	{
		id: 'createBranchFromRef',
		refTypes: ['head'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			return {
				title: '从此分支创建新分支…',
				onClick: async () => {
					const newName = await showText({ title: '创建分支', label: '新分支名', value: name, placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void ctx.deps.run('history', async () => { throwIfError(await createBranch(ctx.repo, newName, `refs/heads/${name}`, true)); });
				},
			};
		},
	},
	{
		id: 'renameBranch',
		refTypes: ['head'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			return {
				title: '重命名分支…', disabled: name === ctx.deps.head,
				onClick: async () => {
					const newName = await showText({ title: '重命名分支', label: '新分支名', value: name });
					if (newName !== null && newName !== '' && newName !== name) void ctx.deps.run('history', async () => { throwIfError(await renameBranch(ctx.repo, name, newName)); });
				},
			};
		},
	},
	{
		id: 'mergeIntoBranch',
		refTypes: ['head'],
		build: (ctx) => {
			const { deps } = ctx;
			/* 目标必须是该提交所在的分支尖端：非尖端时合并位置无法确定。 */
			const mergeInto = (name: string) => async (): Promise<void> => {
				const ok = await showConfirmation({
					title: '合并到选中分支',
					message: `检出 ${name}，并把当前分支合并过去，保持未提交状态？`,
					confirmLabel: '合并', danger: true,
				});
				if (!ok) return;
				// 冲突提示放在刷新之后：run 内部先刷新面板，提示框不应挡住刷新。
				let conflicted = false;
				await deps.run('history', async () => {
					const result = await mergeIntoBranch(ctx.repo, name, ctx.commit.hash);
					if (result.error !== null) throw new Error(result.error);
					if (result.mergeMessage !== null) deps.setCommitMessage(result.mergeMessage);
					conflicted = result.conflicted;
				});
				if (conflicted) {
					await deps.notify('已检出到该分支并保持待合并状态，请在变更列表中解决冲突后再提交。');
				}
			};
			if (ctx.ref !== null) {
				const name = ctx.ref.name;
				if (name === deps.head || !ctx.tipBranches.includes(name)) return null;
				return { title: '合并到选中分支…', onClick: mergeInto(name) };
			}
			const tips = ctx.tipBranches.filter((name) => name !== deps.head);
			if (tips.length === 0) return null;
			if (tips.length === 1) return { title: `合并到 ${tips[0]}…`, onClick: mergeInto(tips[0]) };
			return {
				title: '合并到分支',
				children: tips.map((name) => ({ title: name, onClick: mergeInto(name) })),
			};
		},
	},
	{
		id: 'rebaseOnto',
		refTypes: ['head', 'remote'],
		build: (ctx) => {
			const obj = ctx.ref !== null ? ctx.ref.name : ctx.commit.hash;
			const label = ctx.ref !== null ? ctx.ref.name : ctx.commit.hash.slice(0, 7);
			return {
				title: '变基当前分支到此处…', disabled: ctx.isUncommitted,
				onClick: async () => {
					const ok = await showConfirmation({ title: '变基', message: `把当前分支变基到 ${label}？`, confirmLabel: '变基', danger: true });
					if (ok) void ctx.deps.run('history', async () => { throwIfError(await rebase(ctx.repo, obj)); });
				},
			};
		},
	},
	{
		id: 'copyBranchName',
		refTypes: ['head'],
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '复制分支名', onClick: async () => { await copyText(ctx.ref!.name); } }),
	},
	{
		id: 'createPullRequest',
		refTypes: ['head'],
		build: (ctx) => {
			// PR 是分支级操作：提交行右键时只在当前分支上有意义，引用右键时针对该分支。
			const branch = ctx.ref !== null ? ctx.ref.name : ctx.deps.head;
			if (branch === null || branch !== ctx.deps.head) return null;
			if (!ctx.deps.canCreatePullRequest) return null;
			return {
				title: '创建 Pull Request…',
				onClick: () => { void ctx.deps.handleCreatePullRequest(); },
			};
		},
	},
	{
		id: 'createArchiveFromRef',
		refTypes: ['head', 'tag'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			const kind = ctx.ref.type === 'tag' ? '标签' : '分支';
			return { title: '创建归档…', onClick: () => { void ctx.deps.handleCreateArchive(name, `${kind} ${name}`); } };
		},
	},
	{
		id: 'deleteBranch',
		refTypes: ['head'],
		build: (ctx) => {
			const { deps } = ctx;
			const remove = (name: string) => async (): Promise<void> => {
				// 当前分支不可删除：直接说明原因，而不是置灰等 git 报错。
				if (name === deps.head) {
					await deps.notify(`分支 ${name} 是当前检出的分支，不能删除。请先切换到其他分支再删除。`);
					return;
				}
				const ok = await showCheckbox({
					title: '删除本地分支', message: `确定删除本地分支 ${name}？`,
					checkboxLabel: '同时强制删除未合并分支', danger: true,
				});
				if (ok) void deps.run('history', async () => { throwIfError(await deleteBranch(ctx.repo, name, true)); });
			};
			const removeRemote = (name: string) => async (): Promise<void> => {
				const remote = remoteNameOfBranch(name);
				if (remote === '') return;
				const ok = await showCheckbox({
					title: '删除远程分支', message: `确定删除远程分支 ${name}？`,
					checkboxLabel: '我已知晓并继续', danger: true,
				});
				if (ok) void deps.run('history', async () => { throwIfError(await deleteRemoteBranch(ctx.repo, shortBranchName(name), remote)); });
			};
			if (ctx.ref !== null) {
				return { title: '删除分支…', danger: true, onClick: remove(ctx.ref.name) };
			}
			/*
			 * 提交行右键只列以该提交为尖端的本地与远程分支：包含该提交的分支（在其之上的分支）
			 * 删除后不影响此提交，列入会让「删除分支」指向与所选提交无关的分支。
			 * 远程分支名自带远程名前缀，不再另加后缀。
			 */
			const localTips = ctx.tipBranches.filter((name) => name !== deps.head);
			const remoteTips = ctx.tipRemoteBranches;
			if (localTips.length === 0 && remoteTips.length === 0) return null;
			return {
				title: '删除分支', danger: true,
				children: [
					...localTips.map((name) => ({ title: name, onClick: remove(name) })),
					...remoteTips.map((name) => ({ title: name, onClick: removeRemote(name) })),
				],
			};
		},
	},
	{
		id: 'checkoutRemoteBranch',
		refTypes: ['remote'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			const short = shortBranchName(name);
			return {
				title: '检出远程分支…',
				onClick: async () => {
					const localName = await showText({ title: '检出远程分支', label: '本地分支名', value: short, placeholder: 'feature/xxx' });
					if (localName !== null && localName !== '') void ctx.deps.run('history', async () => { throwIfError(await checkoutBranch(ctx.repo, localName, name), checkoutFailureText); });
				},
			};
		},
	},
	{
		id: 'fetchIntoLocalBranch',
		refTypes: ['remote'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			const short = shortBranchName(name);
			return {
				title: '从远程分支创建本地分支…',
				onClick: async () => {
					const localName = await showText({ title: '创建本地分支', label: '本地分支名', value: short });
					if (localName !== null && localName !== '') {
						void ctx.deps.run('history', async () => { throwIfError(await fetchIntoLocalBranch(ctx.repo, ctx.ref!.remote ?? '', short, localName, false)); });
					}
				},
			};
		},
	},
	{
		id: 'mergeRemoteIntoCurrent',
		refTypes: ['remote'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			return {
				title: '合并到当前分支…',
				onClick: async () => {
					const ok = await showConfirmation({ title: '合并', message: `把 ${name} 合并进当前分支？`, confirmLabel: '合并', danger: true });
					if (ok) void ctx.deps.run('history', async () => { throwIfError(await merge(ctx.repo, name), checkoutFailureText); });
				},
			};
		},
	},
	{
		id: 'deleteRemoteBranch',
		refTypes: ['remote'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			const short = name.replace(/^[^/]+\//, '');
			return {
				title: '删除远程分支…', danger: true,
				onClick: async () => {
					const ok = await showCheckbox({
						title: '删除远程分支', message: `确定删除远程分支 ${name}？`,
						checkboxLabel: '我已知晓并继续', danger: true,
					});
					if (ok) void ctx.deps.run('history', async () => { throwIfError(await deleteRemoteBranch(ctx.repo, short, ctx.ref!.remote ?? '')); });
				},
			};
		},
	},
	{
		id: 'copyRemoteName',
		refTypes: ['remote'],
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '复制远程分支名', onClick: async () => { await copyText(ctx.ref!.name); } }),
	},
	{
		id: 'checkoutTag',
		refTypes: ['tag'],
		commitTarget: 'tag',
		build: (ctx) => {
			const targets = tagTargets(ctx);
			if (targets.length === 0) return null;
			return tagItem(targets, '检出标签', () => ({
				title: '检出此标签',
				onClick: () => { void ctx.deps.run('history', async () => { throwIfError(await checkoutCommit(ctx.repo, ctx.commit.hash), checkoutFailureText); }); },
			}));
		},
	},
	{
		id: 'createBranchFromTag',
		refTypes: ['tag'],
		commitTarget: 'tag',
		build: (ctx) => {
			const targets = tagTargets(ctx);
			if (targets.length === 0) return null;
			return tagItem(targets, '从标签创建分支…', () => ({
				title: '从此标签创建分支…',
				onClick: async () => {
					const newName = await showText({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void ctx.deps.run('history', async () => { throwIfError(await createBranch(ctx.repo, newName, ctx.commit.hash, true)); });
				},
			}));
		},
	},
	{
		id: 'pushTag',
		refTypes: ['tag'],
		commitTarget: 'tag',
		build: (ctx) => {
			const targets = tagTargets(ctx);
			if (targets.length === 0) return null;
			return tagItem(targets, '推送标签到远程…', (tagName) => ({
				title: '推送标签到远程…',
				onClick: async () => {
					const { remotes } = ctx.deps;
					// 没有远程时该操作无法进行，原因是未配置远程。
					if (remotes.length === 0) return ctx.deps.notify('未配置远程仓库，请先在设置中添加远程。');
					const remote = remotes.length === 1 ? remotes[0].name : await showSelect({
						title: '推送标签到远程', options: remotes.map((item) => ({ value: item.name, label: item.name })),
					});
					if (remote !== null && remote !== '') void ctx.deps.run('history', async () => { throwIfError(await pushTag(ctx.repo, tagName, [remote], ctx.commit.hash, false)); });
				},
			}));
		},
	},
	{
		id: 'viewTagDetails',
		refTypes: ['tag'],
		commitTarget: 'tag',
		build: (ctx) => {
			const targets = tagTargets(ctx);
			if (targets.length === 0) return null;
			return tagItem(targets, '查看标签详情…', (tagName) => ({
				title: '查看标签详情…',
				onClick: () => { void ctx.deps.handleTagDetails(tagName, ctx.commit.hash); },
			}));
		},
	},
	{
		id: 'copyTagName',
		refTypes: ['tag'],
		commitTarget: 'tag',
		build: (ctx) => {
			const targets = tagTargets(ctx);
			if (targets.length === 0) return null;
			return tagItem(targets, '复制标签名', (tagName) => ({
				title: '复制标签名',
				onClick: async () => { await copyText(tagName); },
			}));
		},
	},
	{
		id: 'deleteTag',
		refTypes: ['tag'],
		commitTarget: 'tag',
		build: (ctx) => {
			const targets = tagTargets(ctx);
			if (targets.length === 0) return null;
			return tagItem(targets, '删除标签', (tagName) => ({
				title: '删除标签…', danger: true,
				onClick: async () => {
					const { remotes } = ctx.deps;
					const ok = await showCheckbox({
						title: '删除标签', message: `确定删除标签 ${tagName}？`,
						checkboxLabel: '同时删除远程标签', danger: true,
					});
					if (ok) void ctx.deps.run('history', async () => { throwIfError(await deleteTag(ctx.repo, tagName, remotes.length > 0 ? remotes[0].name : null)); });
				},
			}));
		},
	},
	{
		id: 'applyStash',
		refTypes: ['stash'],
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '应用贮藏', onClick: () => { void ctx.deps.run('history', async () => { throwIfError(await applyStash(ctx.repo, ctx.ref!.name, false)); }); } }),
	},
	{
		id: 'popStash',
		refTypes: ['stash'],
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '弹出贮藏', onClick: () => { void ctx.deps.run('history', async () => { throwIfError(await popStash(ctx.repo, ctx.ref!.name, false)); }); } }),
	},
	{
		id: 'branchFromStash',
		refTypes: ['stash'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const selector = ctx.ref.name;
			return {
				title: '从贮藏创建分支…',
				onClick: async () => {
					const newName = await showText({ title: '从贮藏创建分支', label: '新分支名', placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void ctx.deps.run('history', async () => { throwIfError(await branchFromStash(ctx.repo, selector, newName)); });
				},
			};
		},
	},
	{
		id: 'dropStash',
		refTypes: ['stash'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const selector = ctx.ref.name;
			return {
				title: '丢弃贮藏…', danger: true,
				onClick: async () => {
					const ok = await showCheckbox({
						title: '丢弃贮藏', message: `确定丢弃贮藏 ${selector}？`,
						checkboxLabel: '我已知晓并继续', danger: true,
					});
					if (ok) void ctx.deps.run('history', async () => { throwIfError(await dropStash(ctx.repo, selector)); });
				},
			};
		},
	},
	{
		id: 'copyStashSelector',
		refTypes: ['stash'],
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '复制选择器', onClick: async () => { await copyText(ctx.ref!.name); } }),
	},
];

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
		? { local: [], remote: [] }
		: await branchesContaining(repo, commit.hash).catch(() => ({ local: [], remote: [] }));
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
	push(items, { title: '在 GitHub 上打开', visible: githubUrl !== null, onClick: () => { openExternal(githubUrl as string); } });
	// 首项隐藏时不留一条悬空的分隔线在菜单顶部。
	items.push({ type: 'divider', visible: githubUrl !== null });
	push(items, byId('checkoutBranch'));
	push(items, { title: '签出（已分离）', disabled: isUncommitted, onClick: () => { void deps.run('history', async () => { throwIfError(await checkoutCommit(ctx.repo, commit.hash), checkoutFailureText); }); } });
	items.push({ type: 'divider' });
	push(items, { title: '创建分支…', disabled: isUncommitted, onClick: async () => {
		const name = await showText({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' });
		if (name !== null && name !== '') void deps.run('history', async () => { throwIfError(await createBranch(ctx.repo, name, commit.hash, true)); });
	} });
	push(items, byId('deleteBranch'));
	// PR 是分支级操作，作用于当前分支而非选中的提交；条件不满足时该项自身返回 null。
	push(items, byId('createPullRequest'));
	// 标签相关操作自成一组：用分割线与上方的分支操作、下方的提交操作隔开。
	// 未提交伪提交上既不能创建标签、也没有标签可操作，整组不显示。
	if (!isUncommitted) {
		items.push({ type: 'divider' });
		push(items, { title: '创建标签…', onClick: async () => {
			const name = await showText({ title: '创建标签', label: '标签名', placeholder: 'v1.0.0' });
			if (name !== null && name !== '') void deps.run('history', async () => { throwIfError(await addTag(ctx.repo, name, commit.hash, 0, '', false, null)); });
		} });
		for (const item of tagItems) items.push(item);
	}
	items.push({ type: 'divider' });
	push(items, { title: '挑拣此提交…', hint: '将此提交挑拣到当前分支', disabled: isUncommitted, onClick: () => { void deps.run('history', async () => { throwIfError(await cherrypickCommit(ctx.repo, commit.hash)); }); } });
	push(items, { title: '重置此提交…', hint: '将此提交效果重置并创建重置提交', disabled: isUncommitted, onClick: () => { void deps.run('history', async () => { throwIfError(await revertCommit(ctx.repo, commit.hash)); }); } });
	items.push({ type: 'divider' });
	// 重置只对当前分支可达的提交有意义：重置到其他分支的提交会改写当前分支。
	push(items, ctx.onCurrentBranch ? { title: '重置当前分支到此处', danger: true, disabled: isUncommitted, children: [
		{ title: '暂存其他改动', hint: '软重置：保留改动并已暂存', onClick: () => { void deps.run('history', async () => { throwIfError(await resetToCommit(ctx.repo, commit.hash, 'soft')); }); } },
		{ title: '不暂存其他改动', hint: '混合重置：保留改动但不暂存', onClick: () => { void deps.run('history', async () => { throwIfError(await resetToCommit(ctx.repo, commit.hash, 'mixed')); }); } },
		{ title: '丢弃其他改动', hint: '硬重置：丢弃工作区与暂存区的改动', danger: true, onClick: async () => {
			const ok = await showCheckbox({
				title: '重置当前分支',
				message: `当前分支将重置到 ${commit.hash.slice(0, 7)}（硬重置）。未提交的改动会丢失。`,
				checkboxLabel: '我已知晓并继续', danger: true,
			});
			if (ok) void deps.run('history', async () => { throwIfError(await resetToCommit(ctx.repo, commit.hash, 'hard')); });
		} },
	] } : null);
	push(items, byId('rebaseOnto'));
	push(items, byId('mergeIntoBranch'));
	items.push({ type: 'divider' });
	push(items, { title: '复制哈希', onClick: async () => { await copyText(commit.hash); } });
	push(items, { title: '复制提交信息', onClick: async () => { await copyText(commit.message ?? ''); } });
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
		onClose: () => target.classList.remove(MENU_TARGET_CLASS),
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
		onClose: () => target.classList.remove(MENU_TARGET_CLASS),
		items,
	});
}
