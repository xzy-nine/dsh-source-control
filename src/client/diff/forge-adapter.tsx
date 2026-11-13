/**
 * 差异页的 forge 适配层：把本插件的 `FileDiffContent` 映射成 forge 变更视图的
 * `DiffFile` 所需的 props，并把它的行评论接到对话输入框。
 *
 * `DiffFile` 是 forge 变更视图里的“一个文件段”，不是通用差异组件：它同时承担
 * 文件头、hunk 渲染、未变更行折叠与行评论。本适配层负责补齐它要求的入参，并把
 * 评论的终点换成「插进对话输入框的定位引用」，而不是代码托管平台的评审。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DiffFile, type DiffFileHandlers, type DiffFileProps } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/DiffFile.tsx';
import type { ForgeDiffFile } from '@deepseek-ai/dsh-experimental-client-ui-forge/types';
import { ReviewComposer, type ReviewActions } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/ReviewComposer.tsx';
import type { ReviewSelection } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/review.ts';
import { SectionReach } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/section-reach.ts';
import { textLines } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/diff-rows.ts';
import { forgePanelCopy } from './forge-locales.ts';
import { formatCommentQuote } from './comment-reference.ts';
import { markRange, rangeBetween, selectableRows, ROW_SELECTOR } from './line-range.ts';
import type { GitDiffScope } from './resource-path.ts';
import type { FileDiffContent } from '../api/commits.ts';
import css from '../css/forge-adapter.module.css';

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
	/** 当前页的比较作用域，决定评论引用里的定位写法。 */
	readonly scope: GitDiffScope;
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
	/** 把一段引用文本插进当前会话的输入框；成功返回 true。 */
	readonly addToInput: (text: string) => boolean;
}

/**
 * 让整个差异视图可按连续行选区间，并在侧栏页底部给出一条确认栏。
 *
 * forge 自带的选区只认 hunk 内的行，折叠区展开的后未变更行选不中、跨 hunk 的区间
 * 也会被整段拒绝。这里在容器上接管按下与划过：每一行都带行号属性，因此区间可以跨
 * hunk 与展开的未变更行。选择结果不进 forge 的评论框，而是直接由本插件的确认栏
 * 插进对话输入框。
 *
 * @param props - 见 {@link ForgeDiffViewProps}。
 * @returns 视图元素。
 */
export function ForgeDiffView(props: ForgeDiffViewProps): ReactNode {
	const { path, content, scope, split, wrap, state, setState, reach, addToInput } = props;
	const file = toForgeFile(path, content);
	const { handlers } = createDiffFileHandlers(state, setState, reach);
	const t = forgePanelCopy();
	const [range, setRange] = useState<{ readonly low: number; readonly high: number } | null>(null);
	const host = useRef<HTMLDivElement | null>(null);
	// 评论终点是当前会话的输入框：forge 的评论框只给 addToInput，其余（发布、草稿）都不提供。
	const reviewActions = useMemo<ReviewActions>(() => ({
		source: {
			kind: 'local',
			scope: scope.kind,
			base: scope.kind === 'compare' ? scope.baseHash : null,
			baseRef: null,
			commits: null,
		},
		addToInput: (picked: ReviewSelection) => addToInput(formatCommentQuote(
			path,
			scope,
			{ side: picked.comment.side, startLine: picked.comment.startLine, endLine: picked.comment.endLine },
			picked.comment.body,
		)),
	}), [path, scope, addToInput]);
	// 按下时记下起始行下标；拖动过程中更新终点；松开后按这两个下标锁定区间。
	const anchor = useRef<number | null>(null);
	const head = useRef<number | null>(null);
	const rows = useCallback((): Element[] => (host.current === null ? [] : selectableRows(host.current)), []);
	const paint = useCallback((low: number | null, high: number | null) => {
		markRange(rows(), low, high);
	}, [rows]);
	/** 按当前起点与终点落定区间；两者相同即单行。 */
	const settle = useCallback(() => {
		const from = anchor.current;
		anchor.current = null;
		if (from === null) return;
		const to = head.current ?? from;
		head.current = null;
		const low = Math.min(from, to);
		const high = Math.max(from, to);
		paint(low, high);
		setRange({ low, high });
	}, [paint]);
	useEffect(() => {
		const element = host.current;
		if (element === null) return undefined;
		/** 按下哪一行就从哪一行开始选；列号或空白处不算行。 */
		const down = (event: PointerEvent): void => {
			if (event.button !== 0 || !(event.target instanceof Element)) return;
			const row = event.target.closest(ROW_SELECTOR);
			if (row === null || !element.contains(row)) return;
			const list = rows();
			const index = list.indexOf(row);
			if (index < 0) return;
			// 让浏览器不把这次拖动当成文字选区。
			event.preventDefault();
			anchor.current = index;
			head.current = index;
			paint(index, index);
			setRange({ low: index, high: index });
		};
		/** 划过另一行时扩展区间，行号跨 hunk 也能连成一片。 */
		const over = (event: PointerEvent): void => {
			if (anchor.current === null || event.buttons !== 1) return;
			if (!(event.target instanceof Element)) return;
			const row = event.target.closest(ROW_SELECTOR);
			if (row === null || !element.contains(row)) return;
			const index = rows().indexOf(row);
			if (index < 0) return;
			head.current = index;
			const low = Math.min(anchor.current, index);
			const high = Math.max(anchor.current, index);
			paint(low, high);
			setRange({ low, high });
		};
		/** 松开时按最后落到的行锁定区间。 */
		const up = (): void => { settle(); };
		element.addEventListener('pointerdown', down);
		element.addEventListener('pointerover', over);
		window.addEventListener('pointerup', up);
		return () => {
			element.removeEventListener('pointerdown', down);
			element.removeEventListener('pointerover', over);
			window.removeEventListener('pointerup', up);
		};
	}, [settle, paint, rows]);
	const chosen = range === null ? null : rangeBetween(rows(), range.low, range.high);
	/** 取消评论：清掉选区，视图回到未选择状态。 */
	const clear = useCallback((): void => {
		paint(null, null);
		setRange(null);
	}, [paint]);
	const view: DiffFileProps = {
		visible: false,
		file,
		expanded: state.expanded,
		large: false,
		revealed: state.revealed,
		text: content.newText === null ? undefined : textLines(content.newText),
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
	// 评论框用 forge 自己的 ReviewComposer：样式、按钮与文案全部来自库。
	// 它按设计就近显示在所选代码之下，因此紧跟在文件段之后、处于同一文档流里，
	// 而不是作为 flex 子项被挤到视图底部。
	const selection = chosen === null ? null : {
		source: reviewActions.source,
		comment: { path, side: chosen.side, startLine: chosen.startLine, endLine: chosen.endLine, hunk: '', body: '' },
	};
	return createElement(
		'div',
		{ className: css.host, 'data-sc-host': '', ref: host },
		createElement(DiffFile, view),
		selection !== null && createElement(ReviewComposer, {
			selection,
			actions: reviewActions,
			close: clear,
			t,
		}),
	);
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
