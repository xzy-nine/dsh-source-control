/**
 * 提交行右键菜单：查看、GitHub、检出、分支与标签、拣选/还原/重置/合并/变基、复制与归档。
 */
import {
	addTag, branchesContaining, checkoutCommit, cherrypickCommit, createBranch, deleteBranch, deleteRemoteBranch, deleteTag,
	merge, rebase, resetToCommit, revertCommit,
} from '../api.ts';
import { copyText, openExternal, showContextMenu, type ContextMenuItem } from '../context-menu.ts';
import { showCheckbox, showConfirmation, showSelect, showText } from '../dialog.ts';
import { githubCommitUrl } from './github.ts';
import type { Commit, Remote } from '../types.ts';

/** 提交菜单的依赖面。 */
export interface CommitMenuDeps {
	/** 当前工作树路径。 */
	readonly workingTreePath: string | null;
	/** 执行一次工作区操作并刷新。 */
	readonly run: (operation: () => Promise<void>) => Promise<void>;
	/** 选中一个提交并加载其改动文件。 */
	readonly selectCommit: (hash: string) => Promise<void>;
	/** 远端列表。 */
	readonly remotes: readonly Remote[];
	/** 创建归档。 */
	readonly handleCreateArchive: (ref: string, refLabel: string) => Promise<void>;
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
	const { workingTreePath, run, selectCommit, remotes, handleCreateArchive } = deps;
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
	// target 与坐标已在同步段取出：本函数会 await 查询分支，之后 currentTarget 已失效。
	target.classList.add('ggg-menu-target');
	showContextMenu({
		x: clientX, y: clientY,
		onClose: () => target.classList.remove('ggg-menu-target'),
		items: [
			{ title: '查看提交', disabled: isHead, onClick: () => { void selectCommit(commit.hash); } },
			{ title: '在 GitHub 上打开', visible: githubUrl !== null, onClick: () => { openExternal(githubUrl as string); } },
			{ type: 'divider' },
			{ title: '检出此提交', disabled: isHead, onClick: () => { void run(async () => { await checkoutCommit(workingTreePath as string, commit.hash); }); } },
			{ type: 'divider' },
			{ title: '从此提交创建分支…', disabled: isHead, onClick: async () => {
				const name = await showText({ title: '从此提交创建分支', label: '新分支名', placeholder: 'feature/xxx' });
				if (name !== null && name !== '') void run(async () => { await createBranch(workingTreePath as string, name, commit.hash, true); });
			} },
			{ title: '删除分支', disabled: isHead || branchItems.length === 0, children: branchItems },
			{ title: '从此提交创建标签…', disabled: isHead, onClick: async () => {
				const name = await showText({ title: '创建标签', label: '标签名', placeholder: 'v1.0.0' });
				if (name !== null && name !== '') void run(async () => { await addTag(workingTreePath as string, name, commit.hash, 0, '', false, null); });
			} },
			{ title: '删除标签', disabled: isHead || tagItems.length === 0, children: tagItems },
			{ type: 'divider' },
			{ title: '从此提交拣选…', disabled: isHead, onClick: () => { void run(async () => { await cherrypickCommit(workingTreePath as string, commit.hash); }); } },
			{ title: '从此提交还原…', disabled: isHead, onClick: () => { void run(async () => { await revertCommit(workingTreePath as string, commit.hash); }); } },
			{ type: 'divider' },
			{ title: '重置当前分支到此处…', disabled: isHead, onClick: async () => {
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
