/**
 * 贮藏类操作：应用、弹出、从贮藏创建分支、丢弃、复制选择器。
 */
import { applyStash, branchFromStash, dropStash, popStash, throwIfError } from '../../api/index.ts';
import { showCheckbox, showText } from '../../ui/dialog.ts';
import type { ContextMenuItem } from '../../ui/context-menu.ts';
import type { MenuActionMeta } from '../menu-actions.ts';
import { copyRefNameItem, type MenuContext } from './shared.ts';

export const BUILDERS: Readonly<Record<string, (ctx: MenuContext, meta: MenuActionMeta) => ContextMenuItem | null>> = {
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
