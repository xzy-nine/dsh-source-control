/**
 * 标签类操作：检出、从标签创建分支、复制标签名、删除。
 */
import { checkoutCommit, createBranch, deleteTag, throwIfError } from '../../api/index.ts';
import { copyText } from '../../ui/context-menu.ts';
import { showCheckbox, showText } from '../../ui/dialog.ts';
import type { ContextMenuItem } from '../../ui/context-menu.ts';
import { checkoutFailureText } from '../git-messages.ts';
import type { MenuActionMeta } from '../menu-actions.ts';
import { tagItem, tagTargets, type MenuContext } from './shared.ts';

export const BUILDERS: Readonly<Record<string, (ctx: MenuContext, meta: MenuActionMeta) => ContextMenuItem | null>> = {
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
};
