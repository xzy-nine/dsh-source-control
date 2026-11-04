/**
 * dsh-source-control 客户端入口：把源代码管理面板注册为内置右侧栏的一个页类型。
 *
 * 内容面为 sidebar.right.pane.tab（键为该类型 id），chip 标题注册到
 * sidebar.right.pane.tab.title；会话 header 的图标按钮是第二个打开入口。
 * 面板本身是主文档内的 React 树，控件全部来自 DSH 的 ui-primitives。
 *
 * 另注册 git-diff 页类型：点击提交改动文件的差异按钮时，在侧边栏打开
 * 带行号的差异视图，地址为 dsh-resource://git-diff/session/<id>/<hash>/<path>。
 */
import React from 'react';
import {
	IconChevronDownOutlineRegular, IconCompareSplitOutlineRegular, IconInspectOutlineRegular,
	IconNowrapFillRegular, IconWrapFillRegular, Menu, PathLabel, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { GitGraphPanel } from './panel/index.ts';
import { FileDiff, type ChangesDiffState } from './diff/file-diff.tsx';
import { diffStats } from './diff/diff-stats.ts';
import { useDiffView } from './diff/use-diff-view.ts';
import {
	diffFileAddress, gitDiffAddress, gitDiffRequest, gitDiffTitle, parseGitDiffAddress, type GitDiffScope,
} from './diff/resource-path.ts';
import { NativeOpenControl } from './ui/native-open.ts';
import { installOverlay } from './ui/overlay-host.ts';
import { API_PATH, fileDiffContent, installClientLog, logClient, type FileDiffContent } from './api/index.ts';
import { runInTerminal as runInTerminalCommand } from './git/terminal-run.ts';
import { PluginLogoIcon } from './ui/plugin-icon.ts';
import { activeWorkspaceOf, getWorkspaceSnapshot, isSessionDisplayed, preloadWorkspace } from './panel/repo-preload.ts';
import css from './css/index.module.css';
import diffCss from './css/file-diff.module.css';
import shared from './css/shared.module.css';
/** 页类型身份：正文与标题席位都用它当键。 */
const TAB_ID = 'dsh-source-control/panel';
/** 页类型 kind：`ctx.sidebarRight.openTab` 用它打开。 */
const TAB_KIND = 'devGitGraph';
/** 页与引导条目的显示名。 */
const TAB_TITLE = '源代码管理';
/** 会话 header 入口的席位 id 与位置（-5 位于更多操作菜单左侧）。 */
const HEADER_ACTION_ID = 'source-control';
const HEADER_ACTION_ORDER = -5;

/** git-diff 页类型身份。 */
const DIFF_TAB_ID = 'dsh-source-control/diff';
const DIFF_TAB_KIND = 'devGitGraphDiff';

/** 布局身份在渲染期保持稳定，供 Panel 内部的 memo 复用。 */
const EMPTY_SESSIONS = (selector) => selector({ byId: {} });

/** 席位未提供保留信息 hook 时的回退：任何会话都没有保留信息。 */
const EMPTY_RETAIN_INFO = (sessionIdOrSelector, maybeSelector) => {
	const selector = typeof sessionIdOrSelector === 'function' ? sessionIdOrSelector : maybeSelector;
	return typeof selector === 'function' ? selector(undefined) : undefined;
};

/**
 * 侧栏页正文：从会话快照取工作区，缺失时面板自己显示提示。
 *
 * @param props.sessionId - 席位给出的会话 id。
 * @param props.useSessions - session 作用域席位的标准快照 hook。
 * @param props.useSessionRetainInfo - 席位标准 hook，读一个会话的官方保留信息。
 * @param props.useTabInfo - 席位标准 hook，提供 tab.actions.openResource。
 * @returns 面板元素。
 */
function GitGraphTab(props) {
	const { sessionId, useSessions, useSessionRetainInfo, useTabInfo } = props;
	const hook = typeof useSessions === 'function' ? useSessions : EMPTY_SESSIONS;
	const cwd = hook((sessions) => {
		const entry = sessions?.byId?.[sessionId];
		return entry?.cwd;
	});
	/*
	 * 本面板是否在屏幕上：所在会话是当前会话，且本侧栏页可见。
	 *
	 * 两个条件都要：会话被切走时侧栏可能仍记住这一页，页签被切走时会话仍在。只有同时成立
	 * 才算「用户看得见提交框」，异步结果才写进去。会话判定取官方保留信息，与
	 * `activeWorkspaceOf` 同一判据（`retainedBy.mainView` 是引用计数，不是布尔）；
	 * 侧栏页可见性取宿主算好的 `tab.visible`。
	 */
	const retainInfoHook = typeof useSessionRetainInfo === 'function' ? useSessionRetainInfo : EMPTY_RETAIN_INFO;
	const sessionDisplayed = retainInfoHook(sessionId, (retain) => isSessionDisplayed(retain));
	const tabInfoForVisibility = typeof useTabInfo === 'function' ? useTabInfo() : null;
	const tabVisible = tabInfoForVisibility?.tab?.visible === true;
	const onScreen = sessionDisplayed === true && tabVisible;
	// 上屏条件变化记一条：生成结果不上屏时，日志里要能看出是哪一半不成立。
	React.useEffect(() => {
		logClient('D', 'panel', `上屏条件：会话显示=${String(sessionDisplayed === true)}、侧栏页可见=${String(tabVisible)}、合计=${String(onScreen)}`);
	}, [sessionDisplayed, tabVisible, onScreen]);
	// 目录选择器由 ui-workspace 提供；未装载时克隆的第二步会说明原因。
	const pickDirectory = React.useMemo(() => {
		const service = props.uiWorkspace;
		return service === undefined || typeof service.pickDirectory !== 'function'
			? undefined
			: () => service.pickDirectory() as Promise<string | null>;
	}, [props.uiWorkspace]);
	// 终端由 ui-sidebar-terminal 与 terminal-controller 提供；未装载时提示手动克隆。
	const runInTerminal = React.useMemo(() => {
		if (props.terminals === undefined || props.sidebarRightService === undefined) return undefined;
		return (targetSessionId: string, command: string) => runInTerminalCommand(
			{ sidebarRight: props.sidebarRightService, terminals: props.terminals }, targetSessionId, command,
		);
	}, [props.terminals, props.sidebarRightService]);
	// 在系统文件管理器中定位一个路径：走宿主 Remote 的 openWorkspacePath(reveal)。
	const revealPath = React.useCallback((path: string): void => {
		if (typeof props.revealPath !== 'function') return;
		try {
			void Promise.resolve(props.revealPath(path)).catch(() => { /* 定位失败不影响面板 */ });
		} catch {
			/* 同上报错忽略 */
		}
	}, [props.revealPath]);
	const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
	const tabActions = tabInfo?.tab?.actions;
	const onOpenDiff = React.useCallback((tab) => {
		if (tabActions === undefined) return;
		const diff = tab?.diff ?? {};
		const path = String(diff.path ?? '');
		// 未跟踪的新文件没有可比差异：交给普通文件页打开，地址为 dsh-resource://file/…。
		if (diff.kind === 'file') {
			const address = diffFileAddress(sessionId, String(diff.repoRoot ?? cwd ?? ''), path);
			if (address === null) return;
			try {
				tabActions.openResource(address);
			} catch (error) {
				void error;
			}
			return;
		}
		const hash = diff.kind === 'worktree' ? '*' : (diff.hashFull ?? diff.hash ?? '*');
		const staged = diff.kind === 'worktree' && diff.staged === true;
		const repoRoot = typeof diff.repoRoot === 'string' ? diff.repoRoot : null;
		// 两提交对比：旧侧哈希随参数传递，差异页据此取 `baseHash → hash` 的内容。
		const baseHash = typeof diff.baseHash === 'string' && diff.baseHash !== '' ? diff.baseHash : undefined;
		// 作用域进地址，文件与文件列表进参数：同一作用域共用一个页，下拉框就地切换。
		const scope: GitDiffScope = baseHash !== undefined
			? { kind: 'compare', baseHash, hash }
			: hash === '*'
				? { kind: 'worktree', staged }
				: { kind: 'commit', hash };
		const address = gitDiffAddress(sessionId, scope);
		const files = Array.isArray(diff.files) ? diff.files.filter((item): item is string => typeof item === 'string') : [];
		try {
			tabActions.openResource(address, { params: { path, files, repoRoot } });
		} catch (error) {
			void error;
		}
	}, [tabActions, sessionId, cwd]);
	return React.createElement(GitGraphPanel, {
		sessionId,
		cwd: typeof cwd === 'string' ? cwd : null,
		onOpenDiff,
		onRevealPath: revealPath,
		pickDirectory,
		runInTerminal,
		getSessions: props.getSessions,
		onScreen,
	});
}

/** chip 标题：图标 + 文案。 */
function GitGraphTitle() {
	return React.createElement(
		'span',
		{ className: css.chip },
		// 标签页头上的图标：与宿主标签条里同类图标（16）等大。
		React.createElement(PluginLogoIcon, { size: 18 }),
		React.createElement('span', null, TAB_TITLE),
	);
}

/** 会话 header 图标按钮。 */
function GitGraphHeaderAction(props) {
	return React.createElement(
		'button',
		{
			type: 'button', className: css.open, title: TAB_TITLE, 'aria-label': TAB_TITLE,
			onClick: props.open,
		},
		React.createElement(PluginLogoIcon, { size: 20 }),
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
	const { sessionId, useSessions, useTabInfo, clientContext } = props;
	const hook = typeof useSessions === 'function' ? useSessions : EMPTY_SESSIONS;
	const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
	const tabActions = tabInfo?.tab?.actions;
	const address = tabInfo?.tab?.navigation?.address ?? '';
	const navParams = tabInfo?.tab?.navigation?.params;
	const parsed = React.useMemo(() => parseGitDiffAddress(address), [address]);
	// 作用域来自地址；当前文件与文件列表来自导航参数，下拉框就地切换文件而不换页。
	const scope = parsed?.scope ?? null;
	const request = scope === null ? null : gitDiffRequest(scope);
	// 取数坐标拆成原始值：依赖里出现每次渲染新建的对象会让加载反复重跑。
	const commitHash = request?.commitHash ?? '*';
	const staged = request?.staged === true;
	const baseHash = request?.baseHash ?? '';
	const files = React.useMemo<readonly string[]>(
		() => (Array.isArray(navParams?.files) ? navParams.files.filter((item): item is string => typeof item === 'string') : []),
		[navParams],
	);
	const currentPath = typeof navParams?.path === 'string' && navParams.path !== ''
		? navParams.path
		: (parsed?.legacyPath ?? '');
	const repoRoot = typeof navParams?.repoRoot === 'string' ? navParams.repoRoot : null;
	const cwd = hook((sessions) => {
		if (parsed === null) return null;
		const entry = sessions?.byId?.[parsed.sessionId];
		return entry?.cwd ?? null;
	});
	const gitCwd = repoRoot ?? cwd;
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [diffData, setDiffData] = React.useState<FileDiffContent | null>(null);
	const [loading, setLoading] = React.useState(true);
	// 视图选择是面板设置的一部分：默认自动换行与左右并排，改动写回设置并随宿主持久化。
	const diffView = useDiffView(typeof cwd === 'string' ? cwd : null);
	const wrap = diffView.choice.wrap;
	const split = diffView.choice.split;
	/** 在同一页里切到另一个文件：只改导航参数，页身份不变。 */
	const switchFile = React.useCallback((path: string) => {
		if (tabActions === undefined || path === currentPath) return;
		try {
			tabActions.openResource(address, { params: { path, files, repoRoot } });
		} catch (error) {
			void error;
		}
	}, [tabActions, address, currentPath, files, repoRoot]);
	const load = React.useCallback(() => {
		if (parsed === null || currentPath === '' || typeof gitCwd !== 'string') return;
		setLoading(true);
		setDiffData(null);
		fileDiffContent(gitCwd, commitHash, currentPath, staged, baseHash)
			.then((data) => { setDiffData(data); setLoading(false); })
			.catch((error: unknown) => {
				setDiffData(null);
				setLoading(false);
				logClient('E', 'diff', `打开差异页失败，文件 ${currentPath}（${staged ? '暂存区' : '工作区'}）：${error instanceof Error ? error.message : String(error)}`);
			});
	}, [parsed, commitHash, currentPath, gitCwd, staged, baseHash]);
	React.useEffect(() => {
		load();
	}, [load]);
	if (parsed === null) {
		return React.createElement('div', { className: shared.empty }, '无效的差异地址');
	}
	// 比较状态：加载中、无法读取、二进制，或可绘制的文本比较。
	const state: ChangesDiffState = loading
		? 'loading'
		: diffData === null
			? 'error'
			: diffData.binary
				? { kind: 'binary', path: currentPath }
				: {
					kind: 'text', path: currentPath,
					before: diffData.oldText !== null, after: diffData.newText !== null,
					hunks: diffData.hunks, coarse: false,
				};
	const counts = diffData !== null && !diffData.binary ? diffStats(diffData.hunks) : null;
	/** 原生打开使用的绝对路径：仓库根（或会话工作区根）加仓库相对路径。 */
	const absoluteDiffPath = (() => {
		const root = (repoRoot ?? (typeof cwd === 'string' ? cwd : '')).replace(/\\/g, '/').replace(/\/+$/, '');
		if (root === '') return currentPath;
		return currentPath.startsWith('/') || /^[a-zA-Z]:\//.test(currentPath) ? currentPath : `${root}/${currentPath}`;
	})();
	/** 在侧边栏打开整个文件：地址按仓库根换算，交给宿主右侧栏认领。 */
	const openWholeFile = () => {
		if (tabActions === undefined) return;
		const address = diffFileAddress(sessionId, repoRoot ?? (typeof cwd === 'string' ? cwd : ''), currentPath);
		if (address === null) return;
		try {
			tabActions.openResource(address);
		} catch (error) {
			void error;
		}
	};
	return React.createElement(
		'div',
		{ className: css.diffTab },
		React.createElement('div', { className: diffCss.header },
			// 左侧是文件下拉：列出本次比较涉及的同类文件，选中即在同一页里切换。
			files.length > 1
				? React.createElement(Menu, {
					className: css.fileMenu,
					open: menuOpen, autoFocus: true, portal: true, dense: true, align: 'start',
					onClose: () => { setMenuOpen(false); },
					items: files.map((item) => ({ id: item, label: item })),
					selectedId: currentPath,
					onSelect: (id: string) => { setMenuOpen(false); switchFile(id); },
					anchor: React.createElement('button', {
						type: 'button', className: css.fileButton, 'aria-haspopup': 'menu',
						'aria-expanded': menuOpen, 'aria-label': '选择要查看的文件', title: currentPath,
						'data-diff-file': currentPath,
						onClick: () => { setMenuOpen((value) => !value); },
					},
					React.createElement(PathLabel, { path: currentPath }),
					React.createElement(IconChevronDownOutlineRegular, { size: 12 })),
				})
				: React.createElement('span', { className: css.fileButton, 'data-diff-file': currentPath, title: currentPath },
					React.createElement(PathLabel, { path: currentPath })),
			React.createElement('span', { className: css.diffTabHash }, gitDiffTitle(scope ?? { kind: 'worktree', staged: false })),
			counts !== null && React.createElement('span', { className: css.counts },
				diffData?.binary === true
					? React.createElement('span', { className: css.label }, '二进制')
					: React.createElement(React.Fragment, null,
						React.createElement('span', { className: css.added }, `+${counts.added}`),
						React.createElement('span', { className: css.deleted }, `-${counts.deleted}`))),
			React.createElement('span', { className: css.tools },
				React.createElement(Tooltip, {
					label: split ? '切换为单栏对比' : '切换为左右对比', side: 'bottom', delayMs: 500,
					children: React.createElement('button', {
						type: 'button', className: css.tool, 'aria-pressed': split, 'aria-label': '左右对比',
						'data-review-tool': 'split',
						onClick: () => { diffView.patch({ split: !split }); },
					}, React.createElement(IconCompareSplitOutlineRegular, { className: css.compareIcon })),
				}),
				React.createElement(Tooltip, {
					label: wrap ? '关闭自动换行' : '开启自动换行', side: 'bottom', delayMs: 500,
					children: React.createElement('button', {
						type: 'button', className: css.tool, 'aria-pressed': wrap, 'aria-label': '自动换行',
						'data-review-tool': 'wrap',
						onClick: () => { diffView.patch({ wrap: !wrap }); },
					}, wrap ? React.createElement(IconNowrapFillRegular) : React.createElement(IconWrapFillRegular)),
				}),
				React.createElement(Tooltip, {
					label: '在侧边栏打开整个文件', side: 'bottom', delayMs: 500,
					children: React.createElement('button', {
						type: 'button', className: css.tool, 'aria-label': `在侧边栏打开 ${currentPath}`,
						'data-review-tool': 'open-file',
						onClick: openWholeFile,
					}, React.createElement(IconInspectOutlineRegular)),
				}),
				React.createElement(NativeOpenControl, {
					ctx: clientContext,
					path: absoluteDiffPath,
				}),
			),
		),
		React.createElement(
			'div',
			{ className: css.diffTabBody },
			React.createElement(FileDiff, { state, split, wrap, retry: load }),
		),
	);
}

/** git-diff 页标题：文件名。 */
function GitDiffTitle(props) {
	const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
	const address = tabInfo?.tab?.navigation?.address ?? '';
	const parsed = parseGitDiffAddress(address);
	// 页标题给比较作用域；文件名在正文的下一行单独给出。
	const name = parsed !== null ? gitDiffTitle(parsed.scope) : 'Diff';
	return React.createElement('span', { className: css.chip }, name);
}

/**
 * 按主视图当前会话的工作区后台预加载仓库树。
 *
 * 预加载与面板是否打开无关：面板打开时直接呈现已取回的树。只取当前会话的那一个工作区，
 * 不遍历会话列表里的其它工作区。
 *
 * 会话信息全部来自官方来源：会话列表取 `ctx.sessions.list`，每个会话的保留信息取
 * `ctx.sessions.retainInfo(id)`，两者都是可订阅的快照，因此这条路径不需要 React。
 * 列表与「哪些会话被主视图持有」任一变化时重放，切到别的工作区才取下一份。
 *
 * @param ctx - Cordis 上下文。
 * @returns 取消订阅的函数；服务缺失时为空操作。
 */
function startWorkspacePreload(ctx) {
	const sessions = ctx.get?.('sessions');
	const list = sessions?.list;
	if (list === undefined || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return () => {};
	if (typeof sessions.retainInfo !== 'function') return () => {};
	/** 失败后已重试过的工作区根：同一工作区只重试一次，避免失败状态下反复取数。 */
	const retried = new Set();
	/** 已订阅的会话 id -> 取消订阅；列表变化时增删，只留仍在列表里的会话。 */
	const retainSubscriptions = new Map();
	/** 最近一次重放时被主视图持有的会话 id。 */
	let retainedIds = new Set();
	let disposed = false;

	/** 读一个会话的保留信息快照。 */
	const retainSnapshot = (id) => {
		try {
			return sessions.retainInfo(id).getSnapshot();
		} catch {
			return undefined;
		}
	};
	/** 读会话列表快照；缺失时为 null。 */
	const listSnapshot = () => {
		try {
			const snapshot = list.getSnapshot();
			return snapshot !== null && typeof snapshot === 'object' ? snapshot : null;
		} catch {
			return null;
		}
	};
	/**
	 * 按列表顺序列出会话信息。
	 *
	 * 先列 `ids`，再列 `byId` 里不在 `ids` 的保留会话（子代理回退行等）：后者同样可能被
	 * 主视图持有，排在列表成员之后。
	 */
	const sessionsOf = (snapshot) => {
		const byId = snapshot?.byId ?? {};
		const infos = [];
		const seen = new Set();
		const push = (id) => {
			if (typeof id !== 'string' || seen.has(id)) return;
			const row = byId[id];
			if (row === undefined || row === null) return;
			seen.add(id);
			infos.push({ id, cwd: row.cwd, origin: row.origin, retain: retainSnapshot(id) });
		};
		for (const id of Array.isArray(snapshot?.ids) ? snapshot.ids : []) push(id);
		for (const id of Object.keys(byId)) push(id);
		return infos;
	};
	/** 让保留信息订阅覆盖当前被主视图持有的会话。 */
	const syncRetainSubscriptions = (infos) => {
		const next = new Set();
		for (const info of infos) if (isSessionDisplayed(info.retain)) next.add(info.id);
		if (next.size === retainedIds.size && [...next].every((id) => retainedIds.has(id))) return;
		retainedIds = next;
		for (const [id, unsubscribe] of retainSubscriptions) {
			if (next.has(id)) continue;
			unsubscribe();
			retainSubscriptions.delete(id);
		}
		for (const id of next) {
			if (retainSubscriptions.has(id)) continue;
			try {
				const unsubscribe = sessions.retainInfo(id).subscribe(apply);
				retainSubscriptions.set(id, unsubscribe);
			} catch {
				/* 订阅不上时不影响列表订阅 */
			}
		}
	};

	function apply() {
		if (disposed) return;
		const snapshot = listSnapshot();
		if (snapshot === null) return;
		const infos = sessionsOf(snapshot);
		syncRetainSubscriptions(infos);
		let active = null;
		try {
			active = activeWorkspaceOf(infos);
		} catch {
			return;
		}
		if (active === null) return;
		const existing = getWorkspaceSnapshot(active.cwd);
		if (existing === null) {
			preloadWorkspace(active.cwd);
			return;
		}
		if (existing.status !== 'error' || retried.has(active.cwd)) return;
		retried.add(active.cwd);
		preloadWorkspace(active.cwd);
	}

	apply();
	const unsubscribeList = list.subscribe(apply);
	return () => {
		disposed = true;
		unsubscribeList();
		for (const unsubscribe of retainSubscriptions.values()) unsubscribe();
		retainSubscriptions.clear();
	};
}

/**
 * 注册插件。
 *
 * @param ctx - Cordis 上下文。
 * @returns 无。
 */
export function apply(ctx) {
	// 浏览器半边的日志走宿主：装上失败转报钩子，并把装载记进日志。
	installClientLog();
	logClient('I', 'panel', `源代码管理面板已装载，命令地址 ${API_PATH}`);
	// ── 后台预加载仓库树 ───────────────────────────────────────
	// 与页签是否打开无关：页签打开时直接呈现已取回的树。
	if (typeof ctx.effect === 'function') ctx.effect(() => startWorkspacePreload(ctx));

	const slots = ctx.slots ?? ctx.get?.('slots');
	if (slots === undefined) return;

	// 覆盖层：弹窗与轻量提示渲染进根级席位，不再各自 createRoot 挂 document.body。
	ctx.effect(() => installOverlay(slots));

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
				icon: PluginLogoIcon,
			}],
		}));
		ctx.effect(() => rightTabs.register({
			id: DIFF_TAB_ID,
			kind: DIFF_TAB_KIND,
			patterns: ['dsh-resource://git-diff/**'],
			title: (address) => {
				const parsed = parseGitDiffAddress(address);
				return parsed !== null ? gitDiffTitle(parsed.scope) : 'Diff';
			},
		}));
	}

	// 目录选择器来自 ui-workspace、终端来自 ui-sidebar-terminal；都可能未装载，
	// 因此在渲染期按需读取，缺失时由面板提示。
	/** 在系统文件管理器中定位一个路径；宿主不具备桌面能力时返回 false。 */
	const revealPath = async (path: string): Promise<boolean> => {
		try {
			const remote = ctx.get?.('remote') as { session?: { openWorkspacePath?: (request: { path: string; action?: string }) => Promise<{ ok?: boolean }> } } | undefined;
			const session = remote?.session;
			if (session === undefined || typeof session.openWorkspacePath !== 'function') {
				logClient('W', 'open-in-app', `宿主未提供文件管理器能力，无法定位路径 ${path}`);
				return false;
			}
			const result = await session.openWorkspacePath({ path, action: 'reveal' });
			if (result.ok !== true) logClient('W', 'open-in-app', `宿主拒绝在文件管理器中打开路径 ${path}`);
			return result.ok === true;
		} catch (error) {
			logClient('W', 'open-in-app', `在文件管理器中打开路径失败 ${path}：${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	};
	const gitGraphTab = (props) => React.createElement(GitGraphTab, {
		...props,
		getSessions: () => ctx.get?.('sessions'),
		revealPath,
		uiWorkspace: ctx.get?.('uiWorkspace'),
		terminals: ctx.get?.('webTerminals'),
		sidebarRightService: ctx.get?.('sidebarRight'),
	});
	ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
		{ name: 'sidebar.right.pane.tab', key: TAB_ID },
		gitGraphTab,
	)));
	ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register(
		{ name: 'sidebar.right.pane.tab.title', key: TAB_ID },
		GitGraphTitle,
	)));
	ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
		{ name: 'sidebar.right.pane.tab', key: DIFF_TAB_ID },
		(props) => React.createElement(GitDiffTab, { ...props, clientContext: ctx }),
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

/*
 * `remote` 与 `remote.session` 是宿主 Remote 命名空间，"在文件管理器中打开"走它。
 * 两项都要：Cordis 会按 inject 列表校验嵌套属性访问（`ctx.get('remote').session`），
 * 缺一项会抛 `cannot get property "remote.session" without inject`。
 */
export const inject = ['sessions', 'slots', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.session'];