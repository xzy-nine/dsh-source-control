/**
 * 存储库树的一行：仓库、工作树或子模块。
 */
import React from 'react';
import {
	IconArchiveOutlineRegular, IconChevronDownOutlineRegular,
	IconEllipsisOutlineRegular, IconEnhanceOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { RepoIcon } from '../ui/ref-icons.ts';
import { GitGraphIcon } from '../ui/plugin-icon.ts';
import type { RepoNode, RepoSync } from '../shared/types.ts';
import css from '../css/repo-row.module.css';
import shared from '../css/shared.module.css';
import { cx } from '../css/cx.ts';

/** 存储库树一行的属性。 */
export interface RepoRowProps {
	readonly node: RepoNode;
	readonly depth: number;
	readonly active: boolean;
	readonly expanded: boolean;
	readonly sync?: RepoSync | undefined;
	readonly onSelect: (node: RepoNode) => void;
	readonly onToggle: (node: RepoNode) => void;
	readonly onMoreActions?: ((node: RepoNode, event: React.MouseEvent<HTMLElement>) => void) | undefined;
	readonly onBranchClick?: ((node: RepoNode, event: React.MouseEvent<HTMLElement>) => void) | undefined;
	readonly headHash: string | null;
}

/**
 * 存储库树的一行。
 *
 * @param props - 见 {@link RepoRowProps}。
 * @returns 行元素。
 */
export function RepoRow({ node, depth, active, expanded, sync, onSelect, onToggle, onMoreActions, onBranchClick, headHash }: RepoRowProps): React.ReactElement {
	const hasChildren = node.children.length > 0;
	const isWorktree = node.kind === 'worktree';
	const isSubmodule = node.kind === 'submodule';
	const guides: React.ReactElement[] = [];
	for (let i = 0; i < depth; i++) guides.push(React.createElement('span', { key: i, className: shared.repoGuide }));
	const branchName = (sync?.branch ?? node.branch) ?? '';
	const isDetached = branchName === '' && headHash !== null;
	const refText = isDetached ? headHash.slice(0, 7) : branchName;
	return React.createElement(
		'div',
		{
			className: cx(css.repo, active && css.isActive, !node.available && css.isMissing),
			title: node.path,
			onClick: () => { onSelect(node); },
			onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => { event.preventDefault(); onMoreActions?.(node, event); },
		},
		...guides,
		React.createElement('span', {
			className: cx(shared.repoChevron, !expanded && shared.isCollapsed, !hasChildren && shared.isEmpty),
			onClick: (event: React.MouseEvent<HTMLSpanElement>) => { event.stopPropagation(); if (hasChildren) onToggle(node); },
		}, React.createElement(IconChevronDownOutlineRegular, { size: 12 })),
		isWorktree
			? React.createElement(IconEnhanceOutlineRegular, { size: 14, className: css.repoIcon })
			: isSubmodule
				? React.createElement(IconArchiveOutlineRegular, { size: 14, className: css.repoIcon })
				: React.createElement(RepoIcon),
		React.createElement('span', { className: css.repoName }, node.name),
		refText !== '' && React.createElement(GitGraphIcon, { size: 12, className: css.repoBranchIcon }),
		refText !== '' && React.createElement('span', {
			className: cx(css.repoBranch, onBranchClick !== undefined && !isDetached && css.isClickable),
			onClick: (event: React.MouseEvent<HTMLSpanElement>) => { if (onBranchClick !== undefined && !isDetached) { event.stopPropagation(); onBranchClick(node, event); } },
		}, refText),
		sync !== undefined && (sync.ahead > 0 || sync.behind > 0) && React.createElement(
			'span',
			{ className: css.repoSync, title: `领先 ${sync.ahead}、落后 ${sync.behind}` },
			sync.behind > 0 && React.createElement('span', null, `↓${sync.behind}`),
			sync.ahead > 0 && React.createElement('span', null, `↑${sync.ahead}`),
		),
		React.createElement('button', {
			type: 'button', className: css.repoMore, title: '更多操作',
			onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onMoreActions?.(node, event); },
		}, React.createElement(IconEllipsisOutlineRegular, { size: 14 })),
	);
}
