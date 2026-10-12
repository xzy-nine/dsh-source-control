/**
 * dsh-dev-git-graph 客户端入口：把 Git Graph 面板注册为内置右侧栏的一个页类型。
 *
 * 内容面为 sidebar.right.pane.tab（键为该类型 id），chip 标题注册到
 * sidebar.right.pane.tab.title；会话 header 的图标按钮是第二个打开入口。
 * 面板本身是主文档内的 React 树，控件全部来自 DSH 的 ui-primitives。
 */
import React from 'react';
import { GitGraphPanel } from './panel.js';
import { diffFileAddress } from './resource-path.js';
import { STYLES } from './styles.js';

/** 页类型身份：正文与标题席位都用它当键。 */
const TAB_ID = 'dsh-dev-git-graph/git-graph';
/** 页类型 kind：`ctx.sidebarRight.openTab` 用它打开。 */
const TAB_KIND = 'devGitGraph';
/** 页与引导条目的显示名。 */
const TAB_TITLE = 'Git Graph';
/** 会话 header 入口的席位 id 与位置（-5 位于更多操作菜单左侧）。 */
const HEADER_ACTION_ID = 'dev-git-graph';
const HEADER_ACTION_ORDER = -5;

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
		// git 给的是仓库相对路径，地址按会话工作区根解析；仓库与工作区不是同一个时
		// 必须用 diff 里的 repoRoot 拼出绝对路径，再落到工作区相对路径。
		const address = diffFileAddress(
			sessionId,
			typeof cwd === 'string' ? cwd : null,
			tab?.diff?.repoRoot,
			String(tab?.diff?.path ?? ''),
		);
		if (address === null) return;
		try {
			tabActions.openResource(address);
		} catch (error) {
			// 无人认领该地址时（预览插件未挂载）无处可开，静默忽略。
			void error;
		}
	}, [tabActions, cwd, sessionId]);
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
			title: () => TAB_TITLE,
			guide: [{
				id: TAB_ID,
				order: 30,
				title: () => TAB_TITLE,
				description: () => '当前会话工作区的提交图',
				icon: GitGraphIcon,
			}],
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
						// 没有屏幕上的会话时右侧栏命令会抛错，按钮本身只在会话页渲染。
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
