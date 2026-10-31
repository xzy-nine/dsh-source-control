/**
 * 存储库分区：标题栏 + 仓库树 + 下沿拖拽手柄。
 *
 * 只接收已算好的数据与回调，状态与数据加载由面板主体持有。
 */
import React from 'react';
import {
	IconChevronDownOutlineRegular,
	IconPaperPlaneOutlineRegular, IconPlusOutlineRegular, IconSettingsOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { RepoRow } from '../repo-row.ts';
import type { BusyFlags, RepoNode, RepoSync } from '../../shared/types.ts';
import css from '../../css/sections.module.css';
import shared from '../../css/shared.module.css';
import { cx } from '../../css/cx.ts';

/** 存储库分区。 */
export interface RepoSectionProps {
	readonly open: boolean;
	readonly height: number;
	readonly busy: BusyFlags;
	readonly treeStatus: 'loading' | 'ready' | 'empty' | 'error';
	readonly treeNote: string | null;
	readonly visibleRows: ReadonlyArray<{ node: RepoNode; depth: number }>;
	readonly selectedId: string | null;
	readonly expandedIds: ReadonlySet<string>;
	readonly syncById: ReadonlyMap<string, RepoSync>;
	readonly headHash: string | null;
	readonly onToggleSection: () => void;
	readonly onOpenSettings: () => void;
	/** 打开设置并直接落在反馈页签。 */
	readonly onOpenFeedback: () => void;
	/** 克隆远程仓库：输入地址后选父目录，在其中创建同名子目录。 */
	readonly onClone: () => void;
	/** 克隆进行中：只禁用克隆入口，不影响其它控件。 */
	readonly cloneBusy: boolean;
	readonly onSelect: (node: RepoNode) => void;
	readonly onToggle: (node: RepoNode) => void;
	readonly onMoreActions: (node: RepoNode, event: React.MouseEvent<HTMLElement>) => void;
	readonly onBranchClick: (node: RepoNode, event: React.MouseEvent<HTMLElement>) => void;
	readonly onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * 存储库分区：标题栏 + 仓库树 + 下沿拖拽手柄。
 *
 * @param props - 见 {@link RepoSectionProps}。
 * @returns 分区元素。
 */
function RepoSectionView({
	open, height, busy, treeStatus, treeNote, visibleRows, selectedId, expandedIds, syncById, headHash,
	onToggleSection, onOpenSettings, onOpenFeedback, onClone, cloneBusy, onSelect, onToggle, onMoreActions, onBranchClick, onResizeStart,
}: RepoSectionProps): React.ReactElement {
	return React.createElement(
		'div',
		{ className: css.sec },
		React.createElement('div', {
			className: cx(css.secHead, !open && css.collapsed),
			onClick: onToggleSection,
		},
			React.createElement(IconChevronDownOutlineRegular, { size: 14, className: css.chevron }),
			'存储库',
			treeNote !== null && React.createElement('span', { className: css.secNote, title: treeNote }, '⚠'),
			React.createElement('span', { className: css.headActions },
				// 克隆在设置左侧：两个入口都作用于整个存储库区；克隆期间只禁用克隆自身。
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '克隆远程仓库', disabled: busy.network || cloneBusy,
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onClone(); },
				}, React.createElement(IconPlusOutlineRegular, { size: 14 })),
				// 反馈是本地入口，不随仓库操作禁用。
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '反馈',
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onOpenFeedback(); },
				}, React.createElement(IconPaperPlaneOutlineRegular, { size: 14 })),
				// 设置是本地入口，不随仓库操作禁用。
				React.createElement('button', {
					type: 'button', className: css.iconBtn, title: '设置',
					onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onOpenSettings(); },
				}, React.createElement(IconSettingsOutlineRegular, { size: 14 })),
			),
		),
		open && React.createElement(
			'div',
			{ className: css.repos, style: { maxHeight: height, overflowY: 'auto' } },
			treeStatus === 'loading' && React.createElement('div', { className: shared.hint }, '正在发现仓库…'),
			treeStatus !== 'loading' && visibleRows.length === 0
				&& React.createElement('div', { className: shared.hint }, '没有发现 git 仓库'),
			...visibleRows.map(({ node, depth }) => React.createElement(RepoRow, {
				key: node.id, node, depth,
				active: node.id === selectedId,
				expanded: expandedIds.has(node.id),
				sync: syncById.get(node.id),
				onSelect,
				onToggle,
				onMoreActions,
				onBranchClick,
				headHash,
			})),
		),
		open && React.createElement('div', {
			className: shared.secResize,
			title: '拖动调整存储库区高度',
			onPointerDown: onResizeStart,
		}),
	);
}

export const RepoSection = React.memo(RepoSectionView);