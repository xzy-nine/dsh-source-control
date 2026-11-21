/**
 * 标签类操作：检出、从标签创建分支、复制标签名、删除。
 */
import { checkoutCommit, createBranch, deleteTag, throwIfError } from '../../api/index.ts';
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { checkoutFailureText } from '../git-messages.ts';
import { checkboxThenRun, tagItem, tagTargets, textThenRun, type MenuBuilders } from './shared.ts';

export const BUILDERS: MenuBuilders = {
	checkoutTag: (ctx, meta) => tagItem(tagTargets(ctx), '检出标签', () => ({
		title: meta.title,
		onClick: () => { void ctx.deps.run('history', async () => { throwIfError(await checkoutCommit(ctx.repo, ctx.commit.hash), checkoutFailureText); }); },
	})),
	createBranchFromTag: (ctx, meta) => tagItem(tagTargets(ctx), '从标签创建分支…', () => ({
		title: meta.title,
		onClick: textThenRun({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' }, (newName) => {
			void ctx.deps.run('history', async () => { throwIfError(await createBranch(ctx.repo, newName, ctx.commit.hash, true)); });
		}),
	})),
	copyTagName: (ctx, meta) => tagItem(tagTargets(ctx), '复制标签名', (tagName) => ({
		title: meta.title,
		onClick: () => { void writeClipboard(tagName); },
	})),
	deleteTag: (ctx, meta) => tagItem(tagTargets(ctx), '删除标签', (tagName) => ({
		title: meta.title, danger: meta.danger,
		onClick: checkboxThenRun({
			title: '删除标签', message: `确定删除标签 ${tagName}？`,
			checkboxLabel: '同时删除远程标签', danger: true,
		}, () => {
			const { remotes } = ctx.deps;
			void ctx.deps.run('history', async () => { throwIfError(await deleteTag(ctx.repo, tagName, remotes.length > 0 ? remotes[0].name : null)); });
		}),
	})),
};
