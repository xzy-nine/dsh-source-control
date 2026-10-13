/**
 * 提交行与引用标记的右键菜单：单一操作注册表。
 *
 * 每个分支/引用操作声明它适用的引用类型（`refTypes`）。提交行右键把分支操作渲染为以
 * 候选分支为目标的二级菜单，引用标记右键则直接作用于被点击的引用；两处菜单由同一份
 * 定义驱动，不再各自维护一份。
 */
import {
	addTag, applyStash, branchFromStash, branchesContaining, checkoutBranch, checkoutCommit,
	cherrypickCommit, createBranch, deleteBranch, deleteRemoteBranch, deleteTag, dropStash,
	fetchIntoLocalBranch, merge, mergeIntoBranch, popStash, pushTag, rebase, renameBranch,
	resetToCommit, revertCommit,
} from '../api.ts';
import { copyText, openExternal, showContextMenu, type ContextMenuItem } from '../context-menu.ts';
import { showCheckbox, showConfirmation, showMessage, showSelect, showText } from '../dialog.ts';
import { githubCommitUrl } from './github.ts';
import type { Commit, Remote } from '../types.ts';

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
	/** 执行一次工作区操作并刷新。 */
	readonly run: (operation: () => Promise<void>) => Promise<void>;
	/** 远端列表。 */
	readonly remotes: readonly Remote[];
	/** 创建归档。 */
	readonly handleCreateArchive: (ref: string, refLabel: string) => Promise<void>;
	/** 当前分支名。 */
	readonly head: string | null;
	/** 报错提示：依赖 VS Code 的动作在 DSH 中不可用。 */
	readonly unsupported: (label: string) => Promise<void>;
	/** 查看标签详情。 */
	readonly handleTagDetails: (tagName: string, commitHash: string) => Promise<void>;
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
	/** 包含该提交的本地分支。 */
	readonly localBranches: readonly string[];
	/** 以该提交为尖端的本地分支。 */
	readonly tipBranches: readonly string[];
	/** 包含该提交的远程分支。 */
	readonly remoteBranches: readonly string[];
	readonly tagNames: readonly string[];
}

/** 一项引用操作。 */
interface MenuAction {
	/** 稳定标识，供提交菜单按序引用。 */
	readonly id: string;
	/** 适用的引用类型；引用菜单据此过滤。 */
	readonly refTypes: readonly string[];
	/**
	 * 构建菜单项。
	 *
	 * @param ctx - 构建上下文。
	 * @returns 菜单项；该上下文下不适用时为 null。
	 */
	build(ctx: MenuContext): ContextMenuItem | null;
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
					onClick: () => { void deps.run(async () => { await checkoutBranch(ctx.repo, name, null); }); },
				};
			}
			if (ctx.tipBranches.length === 0) return null;
			return {
				title: '签出到',
				children: ctx.tipBranches.map((name) => ({
					title: name === deps.head ? `${name}（当前）` : name,
					disabled: name === deps.head,
					onClick: () => { void deps.run(async () => { await checkoutBranch(ctx.repo, name, null); }); },
				})),
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
					if (newName !== null && newName !== '') void ctx.deps.run(async () => { await createBranch(ctx.repo, newName, `refs/heads/${name}`, true); });
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
					if (newName !== null && newName !== '' && newName !== name) void ctx.deps.run(async () => { await renameBranch(ctx.repo, name, newName); });
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
				await deps.run(async () => {
					const result = await mergeIntoBranch(ctx.repo, name, ctx.commit.hash);
					if (result.error !== null) throw new Error(result.error);
					if (result.mergeMessage !== null) deps.setCommitMessage(result.mergeMessage);
					conflicted = result.conflicted;
				});
				if (conflicted) {
					await showMessage({ title: '合并存在冲突', message: '已检出到该分支并保持待合并状态，请在变更列表中解决冲突后再提交。' });
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
					if (ok) void ctx.deps.run(async () => { await rebase(ctx.repo, obj); });
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
					await showMessage({
						title: '无法删除当前分支',
						message: `分支 ${name} 是当前检出的分支，不能删除。\n请先切换到其他分支再删除。`,
					});
					return;
				}
				const ok = await showCheckbox({
					title: '删除本地分支', message: `确定删除本地分支 ${name}？`,
					checkboxLabel: '同时强制删除未合并分支', danger: true,
				});
				if (ok) void deps.run(async () => { await deleteBranch(ctx.repo, name, true); });
			};
			if (ctx.ref !== null) {
				return { title: '删除分支…', danger: true, onClick: remove(ctx.ref.name) };
			}
			if (ctx.localBranches.length === 0) return null;
			return {
				title: '删除分支', danger: true,
				children: ctx.localBranches.map((name) => ({ title: name, onClick: remove(name) })),
			};
		},
	},
	{
		id: 'checkoutRemoteBranch',
		refTypes: ['remote'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			const short = name.replace(/^[^/]+\//, '');
			return {
				title: '检出远程分支…',
				onClick: async () => {
					const localName = await showText({ title: '检出远程分支', label: '本地分支名', value: short, placeholder: 'feature/xxx' });
					if (localName !== null && localName !== '') void ctx.deps.run(async () => { await checkoutBranch(ctx.repo, localName, name); });
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
			const short = name.replace(/^[^/]+\//, '');
			return {
				title: '从远程分支创建本地分支…',
				onClick: async () => {
					const localName = await showText({ title: '创建本地分支', label: '本地分支名', value: short });
					if (localName !== null && localName !== '') {
						void ctx.deps.run(async () => { await fetchIntoLocalBranch(ctx.repo, ctx.ref!.remote ?? '', short, localName, false); });
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
					if (ok) void ctx.deps.run(async () => { await merge(ctx.repo, name); });
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
					if (ok) void ctx.deps.run(async () => { await deleteRemoteBranch(ctx.repo, short, ctx.ref!.remote ?? ''); });
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
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '检出此标签', onClick: () => { void ctx.deps.run(async () => { await checkoutCommit(ctx.repo, ctx.commit.hash); }); } }),
	},
	{
		id: 'createBranchFromTag',
		refTypes: ['tag'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			return {
				title: '从此标签创建分支…',
				onClick: async () => {
					const newName = await showText({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void ctx.deps.run(async () => { await createBranch(ctx.repo, newName, ctx.commit.hash, true); });
				},
			};
		},
	},
	{
		id: 'pushTag',
		refTypes: ['tag'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			return {
				title: '推送标签到远程…',
				onClick: async () => {
					const { remotes } = ctx.deps;
					if (remotes.length === 0) return ctx.deps.unsupported('推送标签');
					const remote = remotes.length === 1 ? remotes[0].name : await showSelect({
						title: '推送标签到远程', options: remotes.map((item) => ({ value: item.name, label: item.name })),
					});
					if (remote !== null && remote !== '') void ctx.deps.run(async () => { await pushTag(ctx.repo, name, [remote], ctx.commit.hash, false); });
				},
			};
		},
	},
	{
		id: 'viewTagDetails',
		refTypes: ['tag'],
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '查看标签详情…', onClick: () => { void ctx.deps.handleTagDetails(ctx.ref!.name, ctx.commit.hash); } }),
	},
	{
		id: 'copyTagName',
		refTypes: ['tag'],
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '复制标签名', onClick: async () => { await copyText(ctx.ref!.name); } }),
	},
	{
		id: 'deleteTag',
		refTypes: ['tag'],
		build: (ctx) => {
			if (ctx.ref === null) return null;
			const name = ctx.ref.name;
			return {
				title: '删除标签…', danger: true,
				onClick: async () => {
					const { remotes } = ctx.deps;
					const ok = await showCheckbox({
						title: '删除标签', message: `确定删除标签 ${name}？`,
						checkboxLabel: '同时删除远程标签', danger: true,
					});
					if (ok) void ctx.deps.run(async () => { await deleteTag(ctx.repo, name, remotes.length > 0 ? remotes[0].name : null); });
				},
			};
		},
	},
	{
		id: 'applyStash',
		refTypes: ['stash'],
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '应用贮藏', onClick: () => { void ctx.deps.run(async () => { await applyStash(ctx.repo, ctx.ref!.name, false); }); } }),
	},
	{
		id: 'popStash',
		refTypes: ['stash'],
		build: (ctx) => (ctx.ref === null
			? null
			: { title: '弹出贮藏', onClick: () => { void ctx.deps.run(async () => { await popStash(ctx.repo, ctx.ref!.name, false); }); } }),
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
					if (newName !== null && newName !== '') void ctx.deps.run(async () => { await branchFromStash(ctx.repo, selector, newName); });
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
					if (ok) void ctx.deps.run(async () => { await dropStash(ctx.repo, selector); });
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
 * @returns 构建上下文。
 */
async function makeContext(deps: GraphMenuDeps, commit: Commit, ref: RefMenuTarget | null): Promise<MenuContext> {
	const repo = deps.workingTreePath as string;
	const isUncommitted = commit.hash === '*';
	// 分支只由尖端提交标识，中间提交需按「包含」关系查询；查询失败时退回该提交自身的引用。
	const containing = deps.workingTreePath === null || isUncommitted
		? { local: [], remote: [] }
		: await branchesContaining(repo, commit.hash).catch(() => ({ local: [], remote: [] }));
	return {
		deps, commit, ref, repo, isUncommitted,
		localBranches: containing.local.length > 0 ? containing.local : (commit.heads ?? []),
		tipBranches: isUncommitted ? [] : (commit.heads ?? []),
		remoteBranches: containing.remote.length > 0
			? containing.remote
			: (commit.remotes ?? []).map((remote) => remote.name),
		tagNames: (commit.tags ?? []).map((tag) => tag.name),
	};
}

/**
 * 构建提交行右键菜单项。
 *
 * 分支操作按注册表顺序插入；引用专属操作（远程、标签、贮藏）在提交行没有目标，不出现。
 *
 * @param ctx - 构建上下文。
 * @returns 菜单项。
 */
function buildCommitItems(ctx: MenuContext): ContextMenuItem[] {
	const { commit, deps, isUncommitted } = ctx;
	const githubUrl = isUncommitted ? null : githubCommitUrl(deps.remotes, commit.hash);
	const tagItems: ContextMenuItem[] = ctx.tagNames.map((name) => ({
		title: name,
		onClick: async () => {
			const ok = await showCheckbox({
				title: '删除标签', message: `确定删除标签 ${name}？`,
				checkboxLabel: '同时删除远程标签', danger: true,
			});
			if (ok) void deps.run(async () => { await deleteTag(ctx.repo, name, deps.remotes.length > 0 ? deps.remotes[0].name : null); });
		},
	}));
	const byId = (id: string): ContextMenuItem | null => ACTION_BY_ID.get(id)?.build(ctx) ?? null;
	const push = (items: ContextMenuItem[], item: ContextMenuItem | null): void => { if (item !== null) items.push(item); };

	const items: ContextMenuItem[] = [];
	push(items, { title: '在 GitHub 上打开', visible: githubUrl !== null, onClick: () => { openExternal(githubUrl as string); } });
	// 首项隐藏时不留一条悬空的分隔线在菜单顶部。
	items.push({ type: 'divider', visible: githubUrl !== null });
	push(items, byId('checkoutBranch'));
	push(items, { title: '签出（已分离）', disabled: isUncommitted, onClick: () => { void deps.run(async () => { await checkoutCommit(ctx.repo, commit.hash); }); } });
	items.push({ type: 'divider' });
	push(items, { title: '创建分支…', disabled: isUncommitted, onClick: async () => {
		const name = await showText({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' });
		if (name !== null && name !== '') void deps.run(async () => { await createBranch(ctx.repo, name, commit.hash, true); });
	} });
	push(items, byId('deleteBranch'));
	push(items, { title: '创建标签…', disabled: isUncommitted, onClick: async () => {
		const name = await showText({ title: '创建标签', label: '标签名', placeholder: 'v1.0.0' });
		if (name !== null && name !== '') void deps.run(async () => { await addTag(ctx.repo, name, commit.hash, 0, '', false, null); });
	} });
	// 没有标签时该项没有可展开的目标，直接不显示。
	push(items, { title: '删除标签', danger: true, visible: !isUncommitted && tagItems.length > 0, children: tagItems });
	items.push({ type: 'divider' });
	push(items, { title: '从此提交拣选…', disabled: isUncommitted, onClick: () => { void deps.run(async () => { await cherrypickCommit(ctx.repo, commit.hash); }); } });
	push(items, { title: '从此提交还原…', disabled: isUncommitted, onClick: () => { void deps.run(async () => { await revertCommit(ctx.repo, commit.hash); }); } });
	items.push({ type: 'divider' });
	push(items, { title: '重置当前分支到此处…', danger: true, disabled: isUncommitted, onClick: async () => {
		const mode = await showSelect({
			title: '重置模式', message: '选择重置到该提交的方式', value: 'mixed',
			options: [{ value: 'soft', label: '软' }, { value: 'mixed', label: '混合' }, { value: 'hard', label: '硬' }],
		});
		if (mode === null) return;
		const ok = await showCheckbox({
			title: '重置当前分支', message: `当前分支将重置到 ${commit.hash.slice(0, 7)}（${mode}）。未提交的改动可能丢失。`,
			checkboxLabel: '我已知晓并继续', danger: true,
		});
		if (ok) void deps.run(async () => { await resetToCommit(ctx.repo, commit.hash, mode); });
	} });
	push(items, byId('rebaseOnto'));
	push(items, byId('mergeIntoBranch'));
	items.push({ type: 'divider' });
	push(items, { title: '复制哈希', onClick: async () => { await copyText(commit.hash); } });
	push(items, { title: '复制提交信息', onClick: async () => { await copyText(commit.message ?? ''); } });
	push(items, { title: '创建归档…', disabled: isUncommitted, onClick: () => { void deps.handleCreateArchive(commit.hash, `提交 ${commit.hash.slice(0, 7)}`); } });
	return items;
}

/**
 * 提交行右键菜单。
 *
 * @param deps - 见 {@link GraphMenuDeps}。
 * @param args - 目标提交与触发事件。
 * @returns 无。
 */
export async function openCommitMenu(
	deps: GraphMenuDeps,
	{ commit, event }: { commit: Commit; event: React.MouseEvent<HTMLElement> },
): Promise<void> {
	// React 的 currentTarget 只在事件派发期间有效，本函数会 await，因此先在同步段取出。
	const target = event.currentTarget;
	const { clientX, clientY } = event;
	const ctx = await makeContext(deps, commit, null);
	target.classList.add('ggg-menu-target');
	showContextMenu({
		x: clientX, y: clientY,
		onClose: () => target.classList.remove('ggg-menu-target'),
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
 * @param args - 目标提交、引用信息与触发事件。
 * @returns 无。
 */
export async function openRefMenu(
	deps: GraphMenuDeps,
	{ commit, refInfo, event }: { commit: Commit; refInfo: RefMenuTarget; event: React.MouseEvent<HTMLElement> },
): Promise<void> {
	const target = event.currentTarget;
	const { clientX, clientY } = event;
	const ctx = await makeContext(deps, commit, refInfo);
	const items: ContextMenuItem[] = [];
	for (const action of ACTIONS) {
		if (!action.refTypes.includes(refInfo.type)) continue;
		const item = action.build(ctx);
		if (item !== null) items.push(item);
	}
	if (items.length === 0) return;
	target.classList.add('ggg-menu-target');
	showContextMenu({
		x: clientX, y: clientY,
		onClose: () => target.classList.remove('ggg-menu-target'),
		items,
	});
}
