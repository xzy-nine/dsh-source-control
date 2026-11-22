/**
 * 标签类操作：检出、从标签创建分支、复制标签名、删除。
 */
import { checkoutCommit, createBranch, deleteTag } from '../../api/index.ts';
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { checkoutFailureText } from '../git-messages.ts';
import { dangerConfirmItem, runHistory, tagItem, tagTargets, textThenRun, titledItem, type MenuBuilders } from './shared.ts';

export const BUILDERS: MenuBuilders = {
	checkoutTag: (ctx, meta) => tagItem(tagTargets(ctx), '检出标签', () => ({
		title: meta.title,
		onClick: runHistory(ctx, () => checkoutCommit(ctx.repo, ctx.commit.hash), checkoutFailureText),
	})),
	createBranchFromTag: (ctx, meta) => tagItem(tagTargets(ctx), '从标签创建分支…', () => titledItem(meta.title,
		textThenRun({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' },
			(newName) => { runHistory(ctx, () => createBranch(ctx.repo, newName, ctx.commit.hash, true))(); }))),
	copyTagName: (ctx, meta) => tagItem(tagTargets(ctx), '复制标签名', (tagName) => ({
		title: meta.title,
		onClick: () => { void writeClipboard(tagName); },
	})),
	deleteTag: (ctx, meta) => tagItem(tagTargets(ctx), '删除标签', (tagName) => dangerConfirmItem(
		meta,
		{ title: '删除标签', message: `确定删除标签 ${tagName}？`, checkboxLabel: '同时删除远程标签' },
		runHistory(ctx, () => deleteTag(ctx.repo, tagName, ctx.deps.remotes.length > 0 ? ctx.deps.remotes[0].name : null)),
	)),
};
