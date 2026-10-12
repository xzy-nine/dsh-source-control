/**
 * dsh-dev-git-graph 客户端入口：把 Git Graph 面板注册为内置右侧栏的一个页类型。
 *
 * 内容面为 sidebar.right.pane.tab（键为该类型 id），chip 标题注册到
 * sidebar.right.pane.tab.title；会话 header 的图标按钮是第二个打开入口。
 * 面板本身是主文档内的 React 树，控件全部来自 DSH 的 ui-primitives。
 *
 * 另注册 git-diff 页类型：点击提交改动文件的差异按钮时，在侧边栏打开
 * 带行号的差异视图，地址为 dsh-resource://git-diff/session/<id>/<hash>/<path>。
 */
import React from 'react';
import { GitGraphPanel } from './panel.ts';
import { FileDiff, type ChangesDiffState } from './file-diff.tsx';
import { diffFileAddress, gitDiffAddress, parseGitDiffAddress } from './resource-path.ts';
import { fileDiffContent } from './api.ts';
import { STYLES } from './styles.ts';

/** 页类型身份：正文与标题席位都用它当键。 */
const TAB_ID = 'dsh-dev-git-graph/git-graph';
/** 页类型 kind：`ctx.sidebarRight.openTab` 用它打开。 */
const TAB_KIND = 'devGitGraph';
/** 页与引导条目的显示名。 */
const TAB_TITLE = 'Git Graph';
/** 会话 header 入口的席位 id 与位置（-5 位于更多操作菜单左侧）。 */
const HEADER_ACTION_ID = 'dev-git-graph';
const HEADER_ACTION_ORDER = -5;

/** git-diff 页类型身份。 */
const DIFF_TAB_ID = 'dsh-dev-git-graph/diff';
const DIFF_TAB_KIND = 'devGitGraphDiff';

/** 样式只注入一次。 */
function ensureStyle() {
	if (typeof document === 'undefined') return;
	if (document.getElementById('dsh-dev-git-graph-style') !== null) return;
	const element = document.createElement('style');
	element.id = 'dsh-dev-git-graph-style';
	element.textContent = STYLES;
	document.head.appendChild(element);
}

/** 侧栏页图标：分支走向。 */
function GitGraphIcon(props) {
	const size = props?.size ?? 16;
	return React.createElement(
		'svg',
		{
			width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor',
			className: props?.className, 'aria-hidden': 'true', focusable: 'false',
		},
		React.createElement('path', {
			d: 'M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6A1 1 0 005 9.5v1.878a2.251 2.251 0 11-1.5 0V4.622a2.251 2.251 0 111.5 0v1.58A2.49 2.49 0 006 7h4a1 1 0 001-1v-.578A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z',
		}),
	);
}

/** 布局身份在渲染期保持稳定，供 Panel 内部的 memo 复用。 */
const EMPTY_SESSIONS = (selector) => selector({ byId: {} });

/**
 * 侧栏页正文：从会话快照取工作区，缺失时面板自己显示提示。
 *
 * @param props.sessionId - 席位给出的会话 id。
 * @param props.useSessions - session 作用域席位的标准快照 hook。
 * @param props.useTabInfo - 席位标准 hook，提供 tab.actions.openResource。
 * @returns 面板元素。
 */
function GitGraphTab(props) {
	const { sessionId, useSessions, useTabInfo } = props;
	const hook = typeof useSessions === 'function' ? useSessions : EMPTY_SESSIONS;
	const cwd = hook((sessions) => {
		const entry = sessions?.byId?.[sessionId];
		return entry?.cwd;
	});
	const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
	const tabActions = tabInfo?.tab?.actions;
	const onOpenDiff = React.useCallback((tab) => {
		if (tabActions === undefined) return;
		const diff = tab?.diff ?? {};
		const path = String(diff.path ?? '');
		// 未跟踪的新文件没有可比差异：交给普通文件页打开，地址为 dsh-resource://file/…。
		if (diff.kind === 'file') {
			const address = diffFileAddress(sessionId, cwd, String(diff.repoRoot ?? cwd ?? ''), path);
			if (address === null) return;
			try {
				tabActions.openResource(address);
			} catch (error) {
				void error;
			}
			return;
		}
		const hash = diff.kind === 'worktree' ? '*' : (diff.hashFull ?? diff.hash ?? '*');
		const address = gitDiffAddress(sessionId, hash, path);
		const staged = diff.kind === 'worktree' && diff.staged === true;
		const repoRoot = typeof diff.repoRoot === 'string' ? diff.repoRoot : null;
		try {
			tabActions.openResource(address, { params: { staged, repoRoot } });
		} catch (error) {
			void error;
		}
	}, [tabActions, sessionId, cwd]);
	return React.createElement(GitGraphPanel, { sessionId, cwd: typeof cwd === 'string' ? cwd : null, onOpenDiff });
}

/** chip 标题：图标 + 文案。 */
function GitGraphTitle() {
	return React.createElement(
		'span',
		{ className: 'ggg-chip' },
		React.createElement(GitGraphIcon, { size: 16 }),
		React.createElement('span', null, TAB_TITLE),
	);
}

/** 会话 header 图标按钮。 */
function GitGraphHeaderAction(props) {
	return React.createElement(
		'button',
		{
			type: 'button', className: 'ggg-open', title: TAB_TITLE, 'aria-label': TAB_TITLE,
			onClick: props.open,
		},
		React.createElement(GitGraphIcon, { size: 16 }),
	);
}

/**
 * git-diff 侧栏页正文：解析地址，取差异内容，渲染文件差异视图。
 *
 * 视图是复制自 DSH ui-deliverables 的 FileDiff（见 ./file-diff.tsx）。
 *
 * @param props.sessionId - 席位给出的会话 id。
 * @param props.useSessions - session 作用域席位的标准快照 hook。
 * @param props.useTabInfo - 席位标准 hook，提供 tab.navigation.address。
 * @returns 差异视图元素。
 */
function GitDiffTab(props) {
	const { useSessions, useTabInfo } = props;
	const hook = typeof useSessions === 'function' ? useSessions : EMPTY_SESSIONS;
	const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
	const address = tabInfo?.tab?.navigation?.address ?? '';
	const navParams = tabInfo?.tab?.navigation?.params;
	const parsed = React.useMemo(() => parseGitDiffAddress(address), [address]);
	const staged = navParams?.staged === true;
	const repoRoot = typeof navParams?.repoRoot === 'string' ? navParams.repoRoot : null;
	const cwd = hook((sessions) => {
		if (parsed === null) return null;
		const entry = sessions?.byId?.[parsed.sessionId];
		return entry?.cwd ?? null;
	});
	const gitCwd = repoRoot ?? cwd;
	const [diffData, setDiffData] = React.useState(null);
	const [loading, setLoading] = React.useState(true);
	// 默认自动换行：长行不换行会被横向裁掉，需要横向滚动才能看全。
	const [wrap, setWrap] = React.useState(true);
	// 默认左右并排：FileDiff 的 split 模式（单侧改动时它会自动退回单列）。
	const [split, setSplit] = React.useState(true);
	const load = React.useCallback(() => {
		if (parsed === null || typeof gitCwd !== 'string') return;
		setLoading(true);
		setDiffData(null);
		fileDiffContent(gitCwd, parsed.hash, parsed.path, staged)
			.then((data) => { setDiffData(data); setLoading(false); })
			.catch(() => { setDiffData(null); setLoading(false); });
	}, [parsed, gitCwd, staged]);
	React.useEffect(() => {
		load();
	}, [load]);
	if (parsed === null) {
		return React.createElement('div', { className: 'ggg-empty' }, '无效的差异地址');
	}
	// 比较状态：加载中、无法读取，或可绘制的文本比较。
	const state: ChangesDiffState = loading
		? 'loading'
		: diffData === null
			? 'error'
			: {
				kind: 'text', path: parsed.path,
				before: diffData.oldText !== null, after: diffData.newText !== null,
				hunks: diffData.hunks, coarse: false,
			};
	return React.createElement(
		'div',
		{ className: 'ggg-diff-tab' },
		React.createElement('div', { className: 'ggg-diff-tab-head' },
			React.createElement('span', { className: 'ggg-diff-tab-path' }, parsed.path),
			React.createElement('span', { className: 'ggg-diff-tab-hash' }, parsed.hash === '*' ? (staged ? '暂存区' : '工作区') : parsed.hash.slice(0, 7)),
			React.createElement('button', {
				type: 'button', className: 'ggg-diff-tab-toggle', 'aria-pressed': split,
				title: split ? '切换为统一视图' : '切换为左右并排',
				onClick: () => setSplit((value) => !value),
			}, split ? '并排' : '统一'),
			React.createElement('button', {
				type: 'button', className: 'ggg-diff-tab-toggle', 'aria-pressed': wrap,
				title: wrap ? '不换行' : '换行',
				onClick: () => setWrap((value) => !value),
			}, wrap ? '不换行' : '换行'),
		),
		React.createElement(
			'div',
			{ className: 'ggg-diff-tab-body' },
			React.createElement(FileDiff, { state, split, wrap, retry: load }),
		),
	);
}

/** git-diff 页标题：文件名。 */
function GitDiffTitle(props) {
	const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
	const address = tabInfo?.tab?.navigation?.address ?? '';
	const parsed = parseGitDiffAddress(address);
	const name = parsed !== null ? (parsed.path.split('/').pop() ?? 'Diff') : 'Diff';
	return React.createElement('span', { className: 'ggg-chip' }, name);
}

/**
 * 注册插件。
 *
 * @param ctx - Cordis 上下文。
 * @returns 无。
 */
export function apply(ctx) {
	ensureStyle();
	const slots = ctx.slots ?? ctx.get?.('slots');
	if (slots === undefined) return;

	// ── 右侧栏页类型：定义与正文两阶段注册 ──────────────────────
	const rightTabs = ctx.sidebarRightTabs;
	if (rightTabs !== undefined && typeof rightTabs.register === 'function') {
		ctx.effect(() => rightTabs.register({
			id: TAB_ID,
			kind: TAB_KIND,
			// 切到别的侧栏页或工作区再回来时保留挂载：否则面板会重新挂载，
			// 存储库、更改、图形三区都要从空白重新加载，展开状态也随之丢失。
			keepMounted: true,
			title: () => TAB_TITLE,
			guide: [{
				id: TAB_ID,
				order: 30,
				title: () => TAB_TITLE,
				description: () => '当前会话工作区的提交图',
				icon: GitGraphIcon,
			}],
		}));
		ctx.effect(() => rightTabs.register({
			id: DIFF_TAB_ID,
			kind: DIFF_TAB_KIND,
			patterns: ['dsh-resource://git-diff/**'],
			title: (address) => {
				const parsed = parseGitDiffAddress(address);
				return parsed !== null ? (parsed.path.split('/').pop() ?? 'Diff') : 'Diff';
			},
		}));
	}

	ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
		{ name: 'sidebar.right.pane.tab', key: TAB_ID },
		GitGraphTab,
	)));
	ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register(
		{ name: 'sidebar.right.pane.tab.title', key: TAB_ID },
		GitGraphTitle,
	)));
	ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
		{ name: 'sidebar.right.pane.tab', key: DIFF_TAB_ID },
		GitDiffTab,
	)));
	ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register(
		{ name: 'sidebar.right.pane.tab.title', key: DIFF_TAB_ID },
		GitDiffTitle,
	)));

	// ── 会话 header 打开入口 ───────────────────────────────────
	const sidebarRight = ctx.sidebarRight;
	if (sidebarRight !== undefined && typeof sidebarRight.openTab === 'function') {
		ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register(
			{
				name: 'conversation.session.header.utilities',
				id: HEADER_ACTION_ID,
				order: HEADER_ACTION_ORDER,
				label: () => TAB_TITLE,
				inject: () => ({
					open: () => {
						try {
							sidebarRight.openTab(TAB_KIND);
						} catch (error) {
							void error;
						}
					},
				}),
			},
			GitGraphHeaderAction,
		)));
	}
}

export const inject = ['sessions', 'slots', 'sidebarRight', 'sidebarRightTabs'];
