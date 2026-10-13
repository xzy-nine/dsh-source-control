/**
 * 提交行右键菜单：GitHub、签出、分支与标签、拣选/还原/重置/合并/变基、复制与归档。
 */
import {
	addTag, branchesContaining, checkoutBranch, checkoutCommit, cherrypickCommit, createBranch, deleteBranch,
	deleteRemoteBranch, deleteTag, merge, rebase, resetToCommit, revertCommit,
} from '../api.ts';
import { copyText, openExternal, showContextMenu, type ContextMenuItem } from '../context-menu.ts';
import { showCheckbox, showConfirmation, showMessage, showSelect, showText } from '../dialog.ts';
import { githubCommitUrl } from './github.ts';
import type { Commit, Remote } from '../types.ts';

/** 提交菜单的依赖面。 */
export interface CommitMenuDeps {
	/** 当前工作树路径。 */
	readonly workingTreePath: string | null;
	/** 执行一次工作区操作并刷新。 */
	readonly run: (operation: () => Promise<void>) => Promise<void>;
	/** 远端列表。 */
	readonly remotes: readonly Remote[];
	/** 创建归档。 */
	readonly handleCreateArchive: (ref: string, refLabel: string) => Promise<void>;
	/** 当前分支名；用于解释当前分支不可删除。 */
	readonly head: string | null;
}

/**
 * 提交行右键菜单。
 *
 * @param deps - 见 {@link CommitMenuDeps}。
 * @param args - 目标提交与触发事件。
 * @returns 无。
 */
export async function openCommitMenu(
	deps: CommitMenuDeps,
	{ commit, event }: { commit: Commit; event: React.MouseEvent<HTMLElement> },
): Promise<void> {
	const { workingTreePath, run, remotes, handleCreateArchive, head } = deps;
	// React 的 currentTarget 只在事件派发期间有效，本函数会 await，因此先在同步段取出。
	const target = event.currentTarget;
	const { clientX, clientY } = event;
	const tagNames = (commit.tags ?? []).map((tag) => tag.name);
	const isHead = commit.hash === '*';
	const githubUrl = isHead ? null : githubCommitUrl(remotes, commit.hash);
	// 包含该提交的分支（本地 + 远程）与指向该提交的标签：删除动作的二级菜单目标。
	// 分支只由尖端提交标识，中间提交需按「包含」关系查询；查询失败时退回该提交自身的引用。
	const containing = workingTreePath === null || isHead
		? { local: [], remote: [] }
		: await branchesContaining(workingTreePath, commit.hash).catch(() => ({ local: [], remote: [] }));
	const localBranches = containing.local.length > 0 ? containing.local : (commit.heads ?? []);
	const remoteNames = containing.remote.length > 0
		? containing.remote
		: (commit.remotes ?? []).map((remote) => remote.name);
	const branchItems: ContextMenuItem[] = [
		...localBranches.map((name) => ({
			title: name,
			onClick: async () => {
				// 当前分支不可删除：直接说明原因，而不是等 git 报错。
				if (head !== null && name === head) {
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
				if (ok) void run(async () => { await deleteBranch(workingTreePath as string, name, true); });
			},
		})),
		...remoteNames.map((name) => ({
			title: name,
			onClick: async () => {
				const ok = await showCheckbox({
					title: '删除远程分支', message: `确定删除远程分支 ${name}？`,
					checkboxLabel: '我已知晓并继续', danger: true,
				});
				if (ok) void run(async () => {
					await deleteRemoteBranch(workingTreePath as string, name.replace(/^[^/]+\//, ''), name.split('/')[0]);
				});
			},
		})),
	];
	const tagItems: ContextMenuItem[] = tagNames.map((name) => ({
		title: name,
		onClick: async () => {
			const ok = await showCheckbox({
				title: '删除标签', message: `确定删除标签 ${name}？`,
				checkboxLabel: '同时删除远程标签', danger: true,
			});
			if (ok) void run(async () => { await deleteTag(workingTreePath as string, name, remotes.length > 0 ? remotes[0].name : null); });
		},
	}));
	// 该提交是分支头（本地分支正指向它）时，提供签出到这些分支的二级菜单。
	const headBranches = isHead ? [] : (commit.heads ?? []);
	const checkoutItems: ContextMenuItem[] = headBranches.map((name) => ({
		title: name === head ? `${name}（当前）` : name,
		disabled: name === head,
		onClick: () => { void run(async () => { await checkoutBranch(workingTreePath as string, name, null); }); },
	}));
	// target 与坐标已在同步段取出：本函数会 await 查询分支，之后 currentTarget 已失效。
	target.classList.add('ggg-menu-target');
	showContextMenu({
		x: clientX, y: clientY,
		onClose: () => target.classList.remove('ggg-menu-target'),
		items: [
			{ title: '在 GitHub 上打开', visible: githubUrl !== null, onClick: () => { openExternal(githubUrl as string); } },
			// 首项隐藏时不留一条悬空的分隔线在菜单顶部。
			{ type: 'divider', visible: githubUrl !== null },
			// 只有该提交确实是分支头时才出现；非分支头没有可签出的目标。
			{ title: '签出到', visible: checkoutItems.length > 0, children: checkoutItems },
			{ title: '签出（已分离）', disabled: isHead, onClick: () => { void run(async () => { await checkoutCommit(workingTreePath as string, commit.hash); }); } },
			{ type: 'divider' },
			{ title: '创建分支…', disabled: isHead, onClick: async () => {
				const name = await showText({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' });
				if (name !== null && name !== '') void run(async () => { await createBranch(workingTreePath as string, name, commit.hash, true); });
			} },
			{ title: '删除分支', danger: true, disabled: isHead || branchItems.length === 0, children: branchItems },
			{ title: '创建标签…', disabled: isHead, onClick: async () => {
				const name = await showText({ title: '创建标签', label: '标签名', placeholder: 'v1.0.0' });
				if (name !== null && name !== '') void run(async () => { await addTag(workingTreePath as string, name, commit.hash, 0, '', false, null); });
			} },
			// 没有标签时该项没有可展开的目标，直接不显示。
			{ title: '删除标签', danger: true, visible: !isHead && tagItems.length > 0, children: tagItems },
			{ type: 'divider' },
			{ title: '从此提交拣选…', disabled: isHead, onClick: () => { void run(async () => { await cherrypickCommit(workingTreePath as string, commit.hash); }); } },
			{ title: '从此提交还原…', disabled: isHead, onClick: () => { void run(async () => { await revertCommit(workingTreePath as string, commit.hash); }); } },
			{ type: 'divider' },
			{ title: '重置当前分支到此处…', danger: true, disabled: isHead, onClick: async () => {
				const mode = await showSelect({
					title: '重置模式', message: '选择重置到该提交的方式', value: 'mixed',
					options: [{ value: 'soft', label: '软' }, { value: 'mixed', label: '混合' }, { value: 'hard', label: '硬' }],
				});
				if (mode === null) return;
				const ok = await showCheckbox({
					title: '重置当前分支', message: `当前分支将重置到 ${commit.hash.slice(0, 7)}（${mode}）。未提交的改动可能丢失。`,
					checkboxLabel: '我已知晓并继续', danger: true,
				});
				if (ok) void run(async () => { await resetToCommit(workingTreePath as string, commit.hash, mode); });
			} },
			{ title: '合并到当前分支…', disabled: isHead, onClick: async () => {
				const ok = await showConfirmation({ title: '合并提交', message: `把 ${commit.hash.slice(0, 7)} 合并进当前分支？`, confirmLabel: '合并', danger: true });
				if (ok) void run(async () => { await merge(workingTreePath as string, commit.hash); });
			} },
			{ title: '变基当前分支到此处…', disabled: isHead, onClick: async () => {
				const ok = await showConfirmation({ title: '变基', message: `把当前分支变基到 ${commit.hash.slice(0, 7)}？`, confirmLabel: '变基', danger: true });
				if (ok) void run(async () => { await rebase(workingTreePath as string, commit.hash); });
			} },
			{ type: 'divider' },
			{ title: '复制哈希', onClick: async () => { await copyText(commit.hash); } },
			{ title: '复制提交信息', onClick: async () => { await copyText(commit.message ?? ''); } },
			{ title: '创建归档…', disabled: isHead, onClick: () => { void handleCreateArchive(commit.hash, `提交 ${commit.hash.slice(0, 7)}`); } },
		],
	});
}
