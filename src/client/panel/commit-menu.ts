/**
 * 提交行与引用标记的右键菜单：单一操作注册表。
 *
 * 每个分支/引用操作声明它适用的引用类型（`refTypes`）。提交行右键把分支操作渲染为以
 * 候选分支为目标的二级菜单，引用标记右键则直接作用于被点击的引用；两处菜单由同一份
 * 定义驱动，不再各自维护一份。提交菜单的顺序另在 `buildCommitItems` 中给出：新增作用于
 * 提交行的操作时需在那里列出，引用菜单则自动按 `refTypes` 过滤。
 *
 * 操作元数据（id、`refTypes`、`commitTarget`、菜单名称与排列顺序）以 `menu-actions.json` 为唯一
 * 数据源，经 ./menu-actions.ts 补缺省后读入；处理函数在本文件的 `BUILDERS` 里按 id
 * 绑定。新增一项操作 = 在 JSON 里加一条 + 在这里补一个同 id 的处理函数。
 */
import {
	addTag, applyStash, branchFromStash, branchesContaining, checkoutBranch, checkoutCommit,
	cherrypickCommit, createBranch, deleteBranch, deleteRemoteBranch, deleteTag, dropStash,
	fetchIntoLocalBranch, merge, mergeIntoBranch, popStash, rebase, renameBranch,
	resetToCommit, revertCommit, throwIfError,
} from '../api/index.ts';
import { copyText, openExternal, showContextMenu, type ContextMenuItem } from '../ui/context-menu.ts';
import { showCheckbox, showConfirmation, showSelect, showText } from '../ui/dialog.ts';
import type { ConfirmationOptions } from '../ui/dialog.ts';
import { githubCommitUrl, githubRemoteNames, remoteNameOfBranch } from './github.ts';
import { checkoutFailureText } from './git-messages.ts';
import { COMMIT_MENU, fillText, MENU_ACTIONS, type MenuActionMeta } from './menu-actions.ts';
import type { BusyScope, Commit, Remote } from '../shared/types.ts';
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
	/**
	 * 被别的工作树检出的本地分支。
	 *
	 * 这类分支照常作为标签显示，但检出、删除与重命名都会失败或改变别的工作树的检出状态，
	 * 菜单项因此置为不可用并说明原因。
	 */
	readonly foreignBranches: ReadonlySet<string>;
}

/** 一项引用操作：元数据来自 `menu-actions.json`，处理函数在 `BUILDERS` 里按 id 绑定。 */
interface MenuAction extends MenuActionMeta {
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
 * 判定 `git branch -d` 的拒绝原因是否是「分支未合并」。
 *
 * git 的措辞随版本与语言环境不同（英文为 `not fully merged`），执行层已固定英文环境；
 * 其余拒绝原因（被别的工作树检出、分支不存在等）不属于可强制删除的情形，应原样说明。
 *
 * @param message - `git branch -d` 失败时的 stderr 文本。
 * @returns 是未合并导致时为 true。
 */
function isUnmergedRefusal(message: string): boolean {
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
function isForeignBranch(ctx: MenuContext, name: string): boolean {
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
function localBranchItem(ctx: MenuContext, name: string, item: ContextMenuItem): ContextMenuItem {
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
function branchFromRemoteItem(
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
function copyRefNameItem(ctx: MenuContext, meta: MenuActionMeta): ContextMenuItem | null {
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
function confirmThenRun(confirm: ConfirmationOptions, act: () => void): () => void {
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

/** 各操作的处理函数；键为 menu-actions.json 里给出的 id，缺一个会编译报错。 */
const BUILDERS: Readonly<Record<string, (ctx: MenuContext, meta: MenuActionMeta) => ContextMenuItem | null>> = {
	checkoutBranch: (ctx, meta) => {
		const { deps } = ctx;
		if (ctx.ref !== null) {
			const name = ctx.ref.name;
			return localBranchItem(ctx, name, {
				title: meta.title, disabled: name === deps.head,
				onClick: () => { void deps.run('history', async () => { throwIfError(await checkoutBranch(ctx.repo, name, null), checkoutFailureText); }); },
			});
		}
		/*
		 * 提交行右键：本地尖端分支与远程尖端分支都列。远程分支按去掉远程名的短名检出，由 git 决定
		 * 是新建跟踪分支（本地没有同名分支）还是检出已有本地分支；本地已有同名尖端分支时不重复列出。
		 */
		const localNames = new Set(ctx.tipBranches);
		const remoteTips = ctx.tipRemoteBranches.filter((name) => !localNames.has(shortBranchName(name)));
		if (localNames.size === 0 && remoteTips.length === 0) return null;
		return {
			title: meta.commitTitle,
			children: [
				...ctx.tipBranches.map((name) => localBranchItem(ctx, name, {
					title: name === deps.head ? fillText(meta.commitCurrentTitle, { name }) : name,
					disabled: name === deps.head,
					onClick: () => { void deps.run('history', async () => { throwIfError(await checkoutBranch(ctx.repo, name, null), checkoutFailureText); }); },
				})),
				...remoteTips.map((name) => ({
					title: fillText(meta.commitRemoteTitle, { name }),
					onClick: () => { void deps.run('history', async () => { throwIfError(await checkoutBranch(ctx.repo, shortBranchName(name), null), checkoutFailureText); }); },
				})),
			],
		};
	},
	createBranchFromRef: (ctx, meta) => {
		if (ctx.ref === null) return null;
		const name = ctx.ref.name;
		return {
			title: meta.title,
			onClick: () => {
				void (async () => {
					const newName = await showText({ title: '创建分支', label: '新分支名', value: name, placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void ctx.deps.run('history', async () => { throwIfError(await createBranch(ctx.repo, newName, `refs/heads/${name}`, true)); });
				})();
			},
		};
	},
	renameBranch: (ctx, meta) => {
		if (ctx.ref === null) return null;
		const name = ctx.ref.name;
		return localBranchItem(ctx, name, {
			title: meta.title, disabled: name === ctx.deps.head,
			onClick: () => {
				void (async () => {
					const newName = await showText({ title: '重命名分支', label: '新分支名', value: name });
					if (newName !== null && newName !== '' && newName !== name) void ctx.deps.run('history', async () => { throwIfError(await renameBranch(ctx.repo, name, newName)); });
				})();
			},
		});
	},
	mergeIntoBranch: (ctx, meta) => {
		const { deps } = ctx;
		/* 目标必须是该提交所在的分支尖端：非尖端时合并位置无法确定。 */
		const mergeInto = (name: string) => (): void => {
			void (async () => {
				const ok = await showConfirmation({
					title: '合并到选中分支',
					message: `检出 ${name}，并把当前分支合并过去，保持未提交状态？`,
					confirmLabel: '合并', danger: true,
				});
				if (!ok) return;
				// 冲突提示放在刷新之后：run 内部先刷新面板，提示框不应挡住刷新。
				const conflicted = { current: false };
				await deps.run('history', async () => {
					const result = await mergeIntoBranch(ctx.repo, name, ctx.commit.hash);
					if (result.error !== null) throw new Error(result.error);
					if (result.mergeMessage !== null) deps.setCommitMessage(result.mergeMessage);
					conflicted.current = result.conflicted;
				});
				if (conflicted.current) {
					await deps.notify('已检出到该分支并保持待合并状态，请在变更列表中解决冲突后再提交。');
				}
			})();
		};
		if (ctx.ref !== null) {
			const name = ctx.ref.name;
			if (name === deps.head || !ctx.tipBranches.includes(name)) return null;
			return localBranchItem(ctx, name, { title: meta.title, onClick: mergeInto(name) });
		}
		const tips = ctx.tipBranches.filter((name) => name !== deps.head);
		if (tips.length === 0) return null;
		if (tips.length === 1) {
			return localBranchItem(ctx, tips[0], { title: fillText(meta.commitItemTitle, { name: tips[0] }), onClick: mergeInto(tips[0]) });
		}
		return {
			title: meta.commitTitle,
			children: tips.map((name) => localBranchItem(ctx, name, { title: name, onClick: mergeInto(name) })),
		};
	},
	rebaseOnto: (ctx, meta) => {
		const obj = ctx.ref !== null ? ctx.ref.name : ctx.commit.hash;
		const label = ctx.ref !== null ? ctx.ref.name : ctx.commit.hash.slice(0, 7);
		return {
			title: meta.title, disabled: ctx.isUncommitted,
			onClick: () => {
				void (async () => {
					const ok = await showConfirmation({ title: '变基', message: `把当前分支变基到 ${label}？`, confirmLabel: '变基', danger: true });
					if (ok) void ctx.deps.run('history', async () => { throwIfError(await rebase(ctx.repo, obj)); });
				})();
			},
		};
	},
	copyBranchName: (ctx, meta) => copyRefNameItem(ctx, meta),
	createPullRequest: (ctx, meta) => {
		// PR 是分支级操作：提交行右键时只在当前分支上有意义，引用右键时针对该分支。
		const branch = ctx.ref !== null ? ctx.ref.name : ctx.deps.head;
		if (branch === null || branch !== ctx.deps.head) return null;
		if (!ctx.deps.canCreatePullRequest) return null;
		return {
			title: meta.title,
			onClick: () => { void ctx.deps.handleCreatePullRequest(); },
		};
	},
	createArchiveFromRef: (ctx, meta) => {
		if (ctx.ref === null) return null;
		const name = ctx.ref.name;
		const kind = ctx.ref.type === 'tag' ? '标签' : '分支';
		return { title: meta.title, onClick: () => { void ctx.deps.handleCreateArchive(name, `${kind} ${name}`); } };
	},
	deleteBranch: (ctx, meta) => {
		const { deps } = ctx;
		const remove = (name: string) => (): void => {
			void (async () => {
				// 当前分支不可删除：直接说明原因，而不是置灰等 git 报错。
				if (name === deps.head) {
					await deps.notify(`分支 ${name} 是当前检出的分支，不能删除。请先切换到其他分支再删除。`);
					return;
				}
				/*
				 * 两步删除：
				 * 1. 先问一次是否删除，确认后按非强制删除 —— 已合并的分支到此结束；
				 * 2. git 以「未合并」拒绝时，再弹一次说明后果并问是否强制删除；
				 *    其余拒绝原因（被别的工作树检出等）直接给出原因，不提供强删。
				 *
				 * 两次删除都走 `run`：忙碌状态、失败提示与删除后的刷新由它负责。拒绝原因在
				 * 操作体里接收、不抛错，由外层决定下一步。
				 */
				const confirmed = await showConfirmation({
					title: '删除本地分支', message: `确定删除本地分支 ${name}？`,
					confirmLabel: '删除', danger: true,
				});
				if (!confirmed) return;
				const first = { refusal: null as string | null };
				await deps.run('history', async () => {
					first.refusal = await deleteBranch(ctx.repo, name, false);
					// 成功时不抛错，让 run 正常走完刷新。
				});
				if (first.refusal === null) return;
				if (!isUnmergedRefusal(first.refusal)) {
					await deps.notify(`删除分支 ${name} 失败：${first.refusal}`);
					return;
				}
				const force = await showConfirmation({
					title: '分支尚未合并',
					message: `分支 ${name} 还有未合并到其他分支的提交，删除后无法通过该分支找回。\n\n确定要强制删除吗？`,
					confirmLabel: '强制删除', danger: true,
				});
				if (!force) return;
				void deps.run('history', async () => { throwIfError(await deleteBranch(ctx.repo, name, true)); });
			})();
		};
		const removeRemote = (name: string) => (): void => {
			void (async () => {
				const remote = remoteNameOfBranch(name);
				if (remote === '') return;
				const ok = await showCheckbox({
					title: '删除远程分支', message: `确定删除远程分支 ${name}？`,
					checkboxLabel: '我已知晓并继续', danger: true,
				});
				if (ok) void deps.run('history', async () => { throwIfError(await deleteRemoteBranch(ctx.repo, shortBranchName(name), remote)); });
			})();
		};
		if (ctx.ref !== null) {
			const name = ctx.ref.name;
			// 被别的工作树检出的分支同样不可删除：git 会以 `used by worktree` 拒绝。
			return localBranchItem(ctx, name, { title: meta.title, danger: meta.danger, onClick: remove(name) });
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
			title: meta.commitTitle, danger: meta.danger,
			children: [
				...localTips.map((name) => localBranchItem(ctx, name, { title: name, onClick: remove(name) })),
				...remoteTips.map((name) => ({ title: name, onClick: removeRemote(name) })),
			],
		};
	},
	checkoutRemoteBranch: (ctx, meta) => branchFromRemoteItem(ctx, meta, '检出远程分支', (ref, localName) => {
		void ctx.deps.run('history', async () => { throwIfError(await checkoutBranch(ctx.repo, localName, ref.name), checkoutFailureText); });
	}, 'feature/xxx'),
	fetchIntoLocalBranch: (ctx, meta) => branchFromRemoteItem(ctx, meta, '创建本地分支', (ref, localName) => {
		void ctx.deps.run('history', async () => { throwIfError(await fetchIntoLocalBranch(ctx.repo, ref.remote ?? '', shortBranchName(ref.name), localName, false)); });
	}),
	mergeRemoteIntoCurrent: (ctx, meta) => {
		if (ctx.ref === null) return null;
		const name = ctx.ref.name;
		return {
			title: meta.title,
			onClick: confirmThenRun(
				{ title: '合并', message: `把 ${name} 合并进当前分支？`, confirmLabel: '合并', danger: true },
				() => { void ctx.deps.run('history', async () => { throwIfError(await merge(ctx.repo, name), checkoutFailureText); }); },
			),
		};
	},
	deleteRemoteBranch: (ctx, meta) => {
		if (ctx.ref === null) return null;
		const name = ctx.ref.name;
		const remote = ctx.ref.remote ?? '';
		const short = name.replace(/^[^/]+\//, '');
		return {
			title: meta.title, danger: meta.danger,
			onClick: () => {
				void (async () => {
					const ok = await showCheckbox({
						title: '删除远程分支', message: `确定删除远程分支 ${name}？`,
						checkboxLabel: '我已知晓并继续', danger: true,
					});
					if (ok) void ctx.deps.run('history', async () => { throwIfError(await deleteRemoteBranch(ctx.repo, short, remote)); });
				})();
			},
		};
	},
	copyRemoteName: (ctx, meta) => copyRefNameItem(ctx, meta),
	checkoutTag: (ctx, meta) => {
		const targets = tagTargets(ctx);
		if (targets.length === 0) return null;
		return tagItem(targets, '检出标签', () => ({
			title: meta.title,
			onClick: () => { void ctx.deps.run('history', async () => { throwIfError(await checkoutCommit(ctx.repo, ctx.commit.hash), checkoutFailureText); }); },
		}));
	},
	createBranchFromTag: (ctx, meta) => {
		const targets = tagTargets(ctx);
		if (targets.length === 0) return null;
		return tagItem(targets, '从标签创建分支…', () => ({
			title: meta.title,
			onClick: () => {
				void (async () => {
					const newName = await showText({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void ctx.deps.run('history', async () => { throwIfError(await createBranch(ctx.repo, newName, ctx.commit.hash, true)); });
				})();
			},
		}));
	},

	copyTagName: (ctx, meta) => {
		const targets = tagTargets(ctx);
		if (targets.length === 0) return null;
		return tagItem(targets, '复制标签名', (tagName) => ({
			title: meta.title,
			onClick: () => { void copyText(tagName); },
		}));
	},
	deleteTag: (ctx, meta) => {
		const targets = tagTargets(ctx);
		if (targets.length === 0) return null;
		return tagItem(targets, '删除标签', (tagName) => ({
			title: meta.title, danger: meta.danger,
			onClick: () => {
				void (async () => {
					const { remotes } = ctx.deps;
					const ok = await showCheckbox({
						title: '删除标签', message: `确定删除标签 ${tagName}？`,
						checkboxLabel: '同时删除远程标签', danger: true,
					});
					if (ok) void ctx.deps.run('history', async () => { throwIfError(await deleteTag(ctx.repo, tagName, remotes.length > 0 ? remotes[0].name : null)); });
				})();
			},
		}));
	},
	applyStash: (ctx, meta) => {
		const ref = ctx.ref;
		if (ref === null) return null;
		return { title: meta.title, onClick: () => { void ctx.deps.run('history', async () => { throwIfError(await applyStash(ctx.repo, ref.name, false)); }); } };
	},
	popStash: (ctx, meta) => {
		const ref = ctx.ref;
		if (ref === null) return null;
		return { title: meta.title, onClick: () => { void ctx.deps.run('history', async () => { throwIfError(await popStash(ctx.repo, ref.name, false)); }); } };
	},
	branchFromStash: (ctx, meta) => {
		if (ctx.ref === null) return null;
		const selector = ctx.ref.name;
		return {
			title: meta.title,
			onClick: () => {
				void (async () => {
					const newName = await showText({ title: '从贮藏创建分支', label: '新分支名', placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void ctx.deps.run('history', async () => { throwIfError(await branchFromStash(ctx.repo, selector, newName)); });
				})();
			},
		};
	},
	dropStash: (ctx, meta) => {
		if (ctx.ref === null) return null;
		const selector = ctx.ref.name;
		return {
			title: meta.title, danger: meta.danger,
			onClick: () => {
				void (async () => {
					const ok = await showCheckbox({
						title: '丢弃贮藏', message: `确定丢弃贮藏 ${selector}？`,
						checkboxLabel: '我已知晓并继续', danger: true,
					});
					if (ok) void ctx.deps.run('history', async () => { throwIfError(await dropStash(ctx.repo, selector)); });
				})();
			},
		};
	},
	copyStashSelector: (ctx, meta) => copyRefNameItem(ctx, meta),
};

/**
 * 注册表：元数据取自生成的 `MENU_ACTIONS`，处理函数按 id 绑定。
 *
 * 数组顺序即 JSON 里的顺序，提交菜单与引用菜单都按它渲染。
 */
const ACTIONS: readonly MenuAction[] = MENU_ACTIONS.map((meta) => ({ ...meta, build: (ctx: MenuContext) => BUILDERS[meta.id](ctx, meta) }));

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
