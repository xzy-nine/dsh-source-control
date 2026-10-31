/**
 * 本地分支类操作：检出、创建、重命名、合并到、变基、复制引用名、删除。
 */
import {
	checkoutBranch, createBranch, deleteBranch, deleteRemoteBranch, mergeIntoBranch, rebase, renameBranch, throwIfError,
} from '../../api/index.ts';
import { showCheckbox, showConfirmation, showText } from '../../ui/dialog.ts';
import type { ContextMenuItem } from '../../ui/context-menu.ts';
import { checkoutFailureText } from '../git-messages.ts';
import { fillText, type MenuActionMeta } from '../menu-actions.ts';
import { remoteNameOfBranch } from '../github.ts';
import {
	copyRefNameItem, isUnmergedRefusal, localBranchItem, shortBranchName, type MenuContext,
} from './shared.ts';

export const BUILDERS: Readonly<Record<string, (ctx: MenuContext, meta: MenuActionMeta) => ContextMenuItem | null>> = {
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
};
