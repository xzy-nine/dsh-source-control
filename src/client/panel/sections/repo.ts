/**
 * 存储库分区：标题栏 + 仓库树 + 下沿拖拽手柄。
 *
 * 只接收已算好的数据与回调，状态与数据加载由面板主体持有。
 */
import React from 'react';
import {
	IconPaperPlaneOutlineRegular, IconPlusOutlineRegular, IconSettingsOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { RepoRow, type RepoRowCallbacks } from '../repo-row.ts';
import type { BusyFlags, RepoNode, RepoSync } from '../../shared/types.ts';
import { SectionHead } from './section-head.ts';
import { iconButton } from './icon-button.ts';
import { refreshIconButton } from './refresh-button.ts';
import css from '../../css/sections.module.css';
import shared from '../../css/shared.module.css';

/** 存储库分区。 */
export interface RepoSectionProps extends RepoRowCallbacks {
	readonly open: boolean;
	readonly height: number;
	readonly busy: BusyFlags;
	readonly treeStatus: 'loading' | 'ready' | 'empty' | 'error';
	readonly treeNote: string | null;
	readonly visibleRows: ReadonlyArray<{ node: RepoNode; depth: number }>;
	readonly selectedId: string | null;
	readonly expandedIds: ReadonlySet<string>;
	readonly syncById: ReadonlyMap<string, RepoSync>;
	/**
	 * 选中仓库的同步状态；取自当前工作区快照。
	 *
	 * 比仓库树的批量取数新（那一份只在预加载与作废后重取），选中行用它才能与图形区一致。
	 */
	readonly selectedSync: RepoSync | null;
	/** 已加载仓库的路径：与选中行一致时该行才用 `headHash`。 */
	readonly loadedPath: string | null;
	readonly headHash: string | null;
	/** 仓库树是否正在后台重取；标题栏据此给出进行中指示。 */
	readonly refreshing: boolean;
	/** 按磁盘现状重扫整棵仓库树。 */
	readonly onRescanTree: () => void;
	readonly onToggleSection: () => void;
	readonly onOpenSettings: () => void;
	/** 打开设置并直接落在反馈页签。 */
	readonly onOpenFeedback: () => void;
	/** 克隆远程仓库：输入地址后选父目录，在其中创建同名子目录。 */
	readonly onClone: () => void;
	/** 克隆进行中：只禁用克隆入口，不影响其它控件。 */
	readonly cloneBusy: boolean;
	readonly onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * 存储库分区：标题栏 + 仓库树 + 下沿拖拽手柄。
 *
 * @param props - 见 {@link RepoSectionProps}。
 * @returns 分区元素。
 */
function RepoSectionView({
	open, height, busy, treeStatus, treeNote, visibleRows, selectedId, expandedIds, syncById, selectedSync, loadedPath, headHash,
	onToggleSection, onOpenSettings, onOpenFeedback, onClone, cloneBusy, refreshing, onRescanTree,
	onSelect, onToggle, onMoreActions, onBranchClick, onResizeStart,
}: RepoSectionProps): React.ReactElement {
	/**
	 * 标题栏动作区。
	 *
	 * 刷新按磁盘现状重扫整棵树：仓库树只在结构事件与面板挂载时重取，事件漏掉或结构变化无法
	 * 只靠事件补齐时（`.gitmodules` 被改、仓库被移动或改过名）需要用户主动要一次。
	 *
	 * 克隆在设置左侧：两个入口都作用于整个存储库区，克隆期间只禁用克隆自身。反馈与设置是
	 * 本地入口，不随仓库操作禁用。
	 */
	const headActions = React.createElement(
		React.Fragment,
		null,
		refreshIconButton('重新扫描仓库树', refreshing, false, onRescanTree),
		iconButton({ title: '克隆远程仓库', disabled: busy.network || cloneBusy, onClick: onClone, children: React.createElement(IconPlusOutlineRegular, { size: 14 }) }),
		iconButton({ title: '反馈', onClick: onOpenFeedback, children: React.createElement(IconPaperPlaneOutlineRegular, { size: 14 }) }),
		iconButton({ title: '设置', onClick: onOpenSettings, children: React.createElement(IconSettingsOutlineRegular, { size: 14 }) }),
	);
	return React.createElement(
		'div',
		{ className: css.sec },
		React.createElement(SectionHead, {
			title: '存储库',
			open,
			onToggle: onToggleSection,
			refreshing,
			before: treeNote !== null && React.createElement('span', { className: css.secNote, title: treeNote }, '⚠'),
			actions: headActions,
		}),
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
				// 选中行用快照值：仓库树的批量取数较旧，两者混用会让同一行在两个数之间跳。
				sync: node.id === selectedId && selectedSync !== null ? selectedSync : syncById.get(node.id),
				onSelect,
				onToggle,
				onMoreActions,
				onBranchClick,
				loadedPath,
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