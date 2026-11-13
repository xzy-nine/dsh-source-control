/**
 * 差异页的 forge 适配层：把本插件的 `FileDiffContent` 映射成 forge 变更视图的
 * `DiffFile` 所需的 props，并在其上保留本插件的视图选择。
 *
 * `DiffFile` 是 forge 变更视图里的“一个文件段”，不是通用差异组件：它同时承担
 * 文件头（路径、标记、行数、已审阅、文件菜单）、hunk 渲染、未变更行折叠与评审
 * 评论挂载。本适配层负责补齐它要求、而本插件没有数据来源的那几项（评审讨论、
 * 已审阅、文件菜单），同时把 fork 点之外的部分留成空值。
 */

import { createElement, type ReactNode } from 'react';
import { DiffFile, type DiffFileHandlers, type DiffFileProps } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/DiffFile.tsx';
import type { ForgeDiffFile } from '@deepseek-ai/dsh-experimental-client-ui-forge/types';
import { SectionReach } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/section-reach.ts';
import { forgePanelCopy } from './forge-locales.ts';
import type { FileDiffContent } from '../api/commits.ts';

export { SectionReach };

/**
 * 本插件的一个 hunk 能否直接喂给 forge 的 `ForgeDiffHunk`。
 *
 * 两边形状逐字段一致（`oldStart`/`oldLines`/`newStart`/`newLines`/`lines`），
 * 唯一差别是只读标记，因此这里是结构映射而非转换。
 *
 * @param content - 宿主算出的差异内容。
 * @returns forge 形状的逐块差异。
 */
export function toForgeHunks(content: FileDiffContent): ForgeDiffFile['hunks'] {
	return content.hunks.map((hunk) => ({
		oldStart: hunk.oldStart,
		oldLines: hunk.oldLines,
		newStart: hunk.newStart,
		newLines: hunk.newLines,
		lines: hunk.lines,
	}));
}

/**
 * 从 hunk 行前缀数出新增与删除的行数。
 *
 * @param content - 宿主算出的差异内容。
 * @returns 新增与删除的行数。
 */
export function countLines(content: FileDiffContent): { readonly additions: number; readonly deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const hunk of content.hunks) {
		for (const line of hunk.lines) {
			if (line.startsWith('+')) additions += 1;
			else if (line.startsWith('-')) deletions += 1;
		}
	}
	return { additions, deletions };
}

/**
 * 判定文件状态：新建、删除或修改。
 *
 * @param content - 宿主算出的差异内容。
 * @returns forge 的文件状态。
 */
export function statusOf(content: FileDiffContent): ForgeDiffFile['status'] {
	if (content.oldText === null) return 'added';
	if (content.newText === null) return 'deleted';
	return 'modified';
}

/**
 * 组装 `DiffFile` 要求的文件记录。
 *
 * `layer` 与 `digest` 是 forge 用来做分层透镜与已审阅标记的身份字段；本插件没有
 * 这两套机制，因此给固定值。`DiffFile` 只在画分层与已审阅状态时读它们，本适配层
 * 不注册分层透镜、也不提供评审数据，故不影响绘制。
 *
 * @param path - 文件路径。
 * @param content - 宿主算出的差异内容。
 * @returns forge 形状的文件记录。
 */
export function toForgeFile(path: string, content: FileDiffContent): ForgeDiffFile {
	const counts = countLines(content);
	return {
		path,
		previousPath: null,
		status: statusOf(content),
		binary: content.binary,
		oversized: false,
		untracked: false,
		additions: counts.additions,
		deletions: counts.deletions,
		hunks: toForgeHunks(content),
		layer: 'implementation',
		digest: '',
	};
}

/** 一个已加载的差异文件的可变视图状态。 */
export interface DiffFileState {
	/** 是否展开文件（`DiffFile` 用它在标题下方画正文）。 */
	expanded: boolean;
	/** 是否已点击展开超大文件。 */
	revealed: boolean;
	/** 已展开的未变更行区段下标。 */
	open: ReadonlySet<number>;
}

/** `DiffFile` 需要的共享 handler 集合；本插件的单文件页把它们全部接到本地状态上。 */
export interface DiffFileStateHandlers {
	readonly handlers: DiffFileHandlers;
	readonly state: DiffFileState;
}

/**
 * 为单个文件构造 `DiffFile` 需要的 handler 与状态。
 *
 * 本插件的差异页一次只显示一个文件，因此没有文件列表级的跳转、没有“下一条评审
 * 讨论”，也没有跨文件动作。这些能力留成空实现；文件菜单只在 `visible` 为真时才
 * 渲染，而适配层传 false，所以用户不会看到点了没反应的控件。
 *
 * @param state - 当前状态。
 * @param setState - 状态更新函数。
 * @param reach - 行绘制时机观察器。
 * @returns handler 集合与当前状态。
 */
export function createDiffFileHandlers(
	state: DiffFileState,
	setState: (next: DiffFileState) => void,
	reach: SectionReach,
): DiffFileStateHandlers {
	const handlers: DiffFileHandlers = {
		toggle: () => { setState({ ...state, expanded: !state.expanded }); },
		reveal: () => { setState({ ...state, revealed: true }); },
		expand: (_file, index) => { setState({ ...state, open: new Set([...state.open, index]) }); },
		view: () => { /* 本插件不持久化已审阅标记 */ },
		actions: () => [],
		section: () => { /* 单文件页不需要定位文件段 */ },
		nextThread: () => { /* 本插件没有评审讨论 */ },
		reach,
	};
	return { handlers, state };
}

/** `DiffFile` 的渲染入参，供差异页直接交给组件。 */
export interface ForgeDiffViewProps {
	/** 文件路径，用作文件段标题。 */
	readonly path: string;
	/** 宿主算出的差异内容。 */
	readonly content: FileDiffContent;
	/** 是否左右并排。 */
	readonly split: boolean;
	/** 是否自动换行。 */
	readonly wrap: boolean;
	/** 展开/折叠、未变更行展开的本地状态。 */
	readonly state: DiffFileState;
	/** 状态更新函数。 */
	readonly setState: (next: DiffFileState) => void;
	/** 行绘制时机观察器。 */
	readonly reach: SectionReach;
}

/**
 * 把本插件的差异内容渲染成 forge 的 `DiffFile`。
 *
 * `review`、`threads` 与已审阅相关入参全部留空：本插件的差异页不接评审体系。
 * `visible` 传 false，使文件菜单（跨文件动作）不渲染——单文件页没有这些动作。
 *
 * @param props - 见 {@link ForgeDiffViewProps}。
 * @returns 文件段元素。
 */
export function ForgeDiffView(props: ForgeDiffViewProps): ReactNode {
	const { path, content, split, wrap, state, setState, reach } = props;
	const file = toForgeFile(path, content);
	const { handlers } = createDiffFileHandlers(state, setState, reach);
	const t = forgePanelCopy();
	const view: DiffFileProps = {
		visible: false,
		file,
		expanded: state.expanded,
		large: false,
		revealed: state.revealed,
		text: content.newText === null ? undefined : content.newText.split('\n'),
		open: state.open,
		split,
		wrap,
		badge: '',
		tooltip: path,
		viewed: 'unviewed',
		viewedNote: '',
		viewedDisabled: true,
		handlers,
		t,
	};
	return createElement(DiffFile, view);
}

/**
 * 适配层的可测面：把纯映射与渲染入口收在一处导出。
 *
 * 客户端测试跑在 Node 里，而 Node 的类型剥离不处理 JSX，因此测试从构建产物取这份
 * 对象来断言，断言的就是实际会跑的那份实现。
 */
export const __forgeAdapter = {
	toForgeHunks,
	toForgeFile,
	countLines,
	statusOf,
	createDiffFileHandlers,
	ForgeDiffView,
	createSectionReach: () => new SectionReach(),
	forgePanelCopy,
};
