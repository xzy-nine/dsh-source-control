/**
 * 远程分支类操作：检出为本地分支、抓取到本地分支、合并进当前分支、删除、复制引用名。
 */
import { checkoutBranch, deleteRemoteBranch, fetchIntoLocalBranch, merge, throwIfError } from '../../api/index.ts';
import { checkoutFailureText } from '../git-messages.ts';
import {
	branchFromRemoteItem, confirmThenRun, copyRefNameItem, dangerConfirmItem, remoteRefOf, shortBranchName, type MenuBuilders,
} from './shared.ts';

export const BUILDERS: MenuBuilders = {
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
				() => { void ctx.deps.run('history', async () => { throwIfError(await merge(ctx.repo, remoteRefOf(name)), checkoutFailureText); }); },
			),
		};
	},
	deleteRemoteBranch: (ctx, meta) => {
		const ref = ctx.ref;
		if (ref === null) return null;
		const remote = ref.remote ?? '';
		const short = shortBranchName(ref.name);
		return dangerConfirmItem(
			meta,
			{ title: '删除远程分支', message: `确定删除远程分支 ${ref.name}？`, checkboxLabel: '我已知晓并继续' },
			() => { void ctx.deps.run('history', async () => { throwIfError(await deleteRemoteBranch(ctx.repo, short, remote)); }); },
		);
	},
	copyRemoteName: (ctx, meta) => copyRefNameItem(ctx, meta),
};