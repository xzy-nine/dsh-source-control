/**
 * 贮藏类操作：应用、弹出、从贮藏创建分支、丢弃、复制选择器。
 */
import { applyStash, branchFromStash, dropStash, popStash, throwIfError } from '../../api/index.ts';
import {
	copyRefNameItem, dangerConfirmItem, runHistory, textThenRun, withRefName, type MenuBuilder, type MenuBuilders, type MenuContext,
} from './shared.ts';

/**
 * 对贮藏执行一次 git 操作。
 *
 * 应用与弹出只差调用的命令，前置的引用名判定与后续的失败提示同构。
 *
 * @param act - 拿到选择器后的执行体。
 * @returns 菜单构建器。
 */
function stashAction(act: (ctx: MenuContext, selector: string) => Promise<string>): MenuBuilder {
	return withRefName((ctx, meta, selector) => ({
		title: meta.title, danger: meta.danger,
		onClick: runHistory(ctx, () => act(ctx, selector)),
	}));
}

export const BUILDERS: MenuBuilders = {
	applyStash: stashAction((ctx, selector) => applyStash(ctx.repo, selector, false)),
	popStash: stashAction((ctx, selector) => popStash(ctx.repo, selector, false)),
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
