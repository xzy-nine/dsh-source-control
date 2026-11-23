/**
 * 远程分支类操作：检出为本地分支、抓取到本地分支、合并进当前分支、删除、复制引用名。
 */
import { checkoutBranch, fetchIntoLocalBranch, merge } from '../../api/index.ts';
import { checkoutFailureText } from '../git-messages.ts';
import { remoteNameOfBranch } from '../github.ts';
import {
	branchFromRemoteItem, confirmThenRun, copyRefNameItem, dangerConfirmItem, deleteRemoteBranchClick, remoteRefOf, runHistory, shortBranchName, titledItem, withRefName, type MenuBuilders, type RefMenuTarget,
} from './shared.ts';

/**
 * 取远程分支目标所属的远程名。
 *
 * 优先用引用目标自带的远程名；缺失时从 `远程名/分支名` 形态的名字里拆出——删分支与抓取到本地分支
 * 都要按远程名下发给 git，远程名为空会让 git 收到空仓库参数。
 *
 * @param ref - 引用目标。
 * @returns 远程名；拆不出时为空串。
 */
function remoteOfRef(ref: RefMenuTarget): string {
	return ref.remote ?? remoteNameOfBranch(ref.name);
}

export const BUILDERS: MenuBuilders = {
	checkoutRemoteBranch: (ctx, meta) => branchFromRemoteItem(ctx, meta, '检出远程分支', (ref, localName) => {
		runHistory(ctx, () => checkoutBranch(ctx.repo, localName, ref.name), checkoutFailureText)();
	}, 'feature/xxx'),
	fetchIntoLocalBranch: (ctx, meta) => branchFromRemoteItem(ctx, meta, '创建本地分支', (ref, localName) => {
		runHistory(ctx, () => fetchIntoLocalBranch(ctx.repo, remoteOfRef(ref), shortBranchName(ref.name), localName, false))();
	}),
	mergeRemoteIntoCurrent: withRefName((ctx, meta, name) => titledItem(meta.title,
		confirmThenRun(
			{ title: '合并', message: `把 ${name} 合并进当前分支？`, confirmLabel: '合并', danger: true },
			runHistory(ctx, () => merge(ctx.repo, remoteRefOf(name)), checkoutFailureText),
		))),
	deleteRemoteBranch: (ctx, meta) => {
		const ref = ctx.ref;
		if (ref === null) return null;
		const remote = remoteOfRef(ref);
		// 拆不出远程名时不显示该项：没有远程名，git 会把空串当成仓库参数。
		if (remote === '') return null;
		return dangerConfirmItem(
			meta,
			{ title: '删除远程分支', message: `确定删除远程分支 ${ref.name}？`, checkboxLabel: '我已知晓并继续' },
			deleteRemoteBranchClick(ctx, ref.name, remote),
		);
	},
	copyRemoteName: (ctx, meta) => copyRefNameItem(ctx, meta),
};