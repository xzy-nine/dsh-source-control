/**
 * 贮藏类操作：应用、弹出、从贮藏创建分支、丢弃、复制选择器。
 */
import { applyStash, branchFromStash, dropStash, popStash, throwIfError } from '../../api/index.ts';
import {
	copyRefNameItem, dangerConfirmItem, textThenRun, withRefName, type MenuBuilders,
} from './shared.ts';

export const BUILDERS: MenuBuilders = {
	applyStash: withRefName((ctx, meta, selector) => ({
		title: meta.title, danger: meta.danger,
		onClick: () => { void ctx.deps.run('history', async () => { throwIfError(await applyStash(ctx.repo, selector, false)); }); },
	})),
	popStash: withRefName((ctx, meta, selector) => ({
		title: meta.title, danger: meta.danger,
		onClick: () => { void ctx.deps.run('history', async () => { throwIfError(await popStash(ctx.repo, selector, false)); }); },
	})),
	branchFromStash: withRefName((ctx, meta, selector) => ({
		title: meta.title,
		onClick: textThenRun({ title: '从贮藏创建分支', label: '新分支名', placeholder: 'feature/xxx' }, (newName) => {
			void ctx.deps.run('history', async () => { throwIfError(await branchFromStash(ctx.repo, selector, newName)); });
		}),
	})),
	dropStash: withRefName((ctx, meta, selector) => dangerConfirmItem(
		meta,
		{ title: '丢弃贮藏', message: `确定丢弃贮藏 ${selector}？`, checkboxLabel: '我已知晓并继续' },
		() => { void ctx.deps.run('history', async () => { throwIfError(await dropStash(ctx.repo, selector)); }); },
	)),
	copyStashSelector: copyRefNameItem,
};
