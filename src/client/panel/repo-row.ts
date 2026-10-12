/**
 * 存储库树的一行：仓库、工作树或子模块。
 */
import React from 'react';
import {
	IconArchiveOutlineRegular, IconBranchOutlineRegular, IconChevronDownOutlineRegular,
	IconEllipsisOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { RepoIcon } from '../ref-icons.ts';
import type { RepoNode, RepoSync } from '../types.ts';

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
	const hasChildren = (node.children ?? []).length > 0;
	const isWorktree = node.kind === 'worktree';
	const isSubmodule = node.kind === 'submodule';
	const guides: React.ReactElement[] = [];
	for (let i = 0; i < depth; i++) guides.push(React.createElement('span', { key: i, className: 'ggg-repo-guide' }));
	const branchName = (sync?.branch ?? node.branch) ?? '';
	const isDetached = branchName === '' && headHash !== null && headHash !== undefined;
	const refText = isDetached ? headHash.slice(0, 7) : branchName;
	return React.createElement(
		'div',
		{
			className: `ggg-repo${active ? ' is-active' : ''}${node.available === false ? ' is-missing' : ''}`,
			title: node.path,
			onClick: () => onSelect(node),
			onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => { event.preventDefault(); onMoreActions?.(node, event); },
		},
		...guides,
		React.createElement('span', {
			className: `ggg-repo-chevron${expanded ? '' : ' is-collapsed'}${hasChildren ? '' : ' is-empty'}`,
			onClick: (event: React.MouseEvent<HTMLSpanElement>) => { event.stopPropagation(); if (hasChildren) onToggle(node); },
		}, React.createElement(IconChevronDownOutlineRegular, { size: 12 })),
		isWorktree
			? React.createElement(IconBranchOutlineRegular, { size: 14, className: 'ggg-repo-icon' })
			: isSubmodule
				? React.createElement(IconArchiveOutlineRegular, { size: 14, className: 'ggg-repo-icon' })
				: React.createElement(RepoIcon),
		React.createElement('span', { className: 'ggg-repo-name' }, node.name),
		refText !== '' && React.createElement(IconBranchOutlineRegular, { size: 12, className: 'ggg-repo-branch-icon' }),
		refText !== '' && React.createElement('span', {
			className: 'ggg-repo-branch' + (onBranchClick !== undefined && !isDetached ? ' is-clickable' : ''),
			onClick: (event: React.MouseEvent<HTMLSpanElement>) => { if (onBranchClick !== undefined && !isDetached) { event.stopPropagation(); onBranchClick(node, event); } },
		}, refText),
		sync !== undefined && (sync.ahead > 0 || sync.behind > 0) && React.createElement(
			'span',
			{ className: 'ggg-repo-sync', title: `领先 ${sync.ahead}、落后 ${sync.behind}` },
			sync.behind > 0 && React.createElement('span', null, `↓${sync.behind}`),
			sync.ahead > 0 && React.createElement('span', null, `↑${sync.ahead}`),
		),
		React.createElement('button', {
			type: 'button', className: 'ggg-repo-more', title: '更多操作',
			onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onMoreActions?.(node, event); },
		}, React.createElement(IconEllipsisOutlineRegular, { size: 14 })),
	);
}
