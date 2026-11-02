/**
 * 远程分支类操作：检出为本地分支、抓取到本地分支、合并进当前分支、删除、复制引用名。
 */
import { checkoutBranch, deleteRemoteBranch, fetchIntoLocalBranch, merge, throwIfError } from '../../api/index.ts';
import { showCheckbox } from '../../ui/dialog.ts';
import type { ContextMenuItem } from '../../ui/context-menu.ts';
import { checkoutFailureText } from '../git-messages.ts';
import type { MenuActionMeta } from '../menu-actions.ts';
import { branchFromRemoteItem, confirmThenRun, copyRefNameItem, shortBranchName, type MenuContext } from './shared.ts';

export const BUILDERS: Readonly<Record<string, (ctx: MenuContext, meta: MenuActionMeta) => ContextMenuItem | null>> = {
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
};
