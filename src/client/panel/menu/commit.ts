/**
 * 提交层面的两项通用操作：创建 Pull Request 与从引用创建归档。
 */
import { withRefName, type MenuBuilders } from './shared.ts';

export const BUILDERS: MenuBuilders = {
	createPullRequest: (ctx, meta) => {
		// PR 是分支级操作：提交行右键时只在当前分支上有意义，引用右键时针对该分支。
		const branch = ctx.ref !== null ? ctx.ref.name : ctx.deps.head;
		if (branch === null || branch !== ctx.deps.head) return null;
		if (!ctx.deps.canCreatePullRequest) return null;
		return {
			title: meta.title,
			onClick: () => { void ctx.deps.handleCreatePullRequest(); },
		};
	},
	createArchiveFromRef: withRefName((ctx, meta, name) => {
		const kind = ctx.ref?.type === 'tag' ? '标签' : '分支';
		return { title: meta.title, onClick: () => { void ctx.deps.handleCreateArchive(name, `${kind} ${name}`); } };
	}),
};
