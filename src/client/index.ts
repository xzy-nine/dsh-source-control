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
import { ForgeDiffView, type DiffFileState } from './diff/forge-adapter.tsx';
import { SectionReach } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/section-reach.ts';
import { diffStats } from './diff/diff-stats.ts';
import { useDiffView } from './diff/use-diff-view.ts';
import {
	diffFileAddress, gitDiffAddress, gitDiffRequest, gitDiffTitle, parseGitDiffAddress, type GitDiffScope,
} from './diff/resource-path.ts';
import { NativeOpenControl } from './ui/native-open.ts';
import { installOverlay } from './ui/overlay-host.ts';
import { useSharedContextMenu } from './ui/context-menu.ts';
import type { ContextMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client';
import {
	API_PATH, applyHunk as applyHunkCommand, applyMergeChoices, fileDiffContent, installClientLog,
	loadFileHunks, loadMergeContents, logClient, resolveConflict,
	type FileDiffContent, type FileHunk, type MergeContentsPayload,
} from './api/index.ts';
import { MergeView } from './diff/merge-view.ts';
import { formatMergeComment } from './diff/comment-reference.ts';
import type { LineRange } from './diff/line-range.ts';
import { HunkBar } from './diff/hunk-bar.ts';
import { analyzeMerge, type MergeChoice } from '../shared/merge-ranges.ts';
import { showMessage } from './ui/dialog.ts';
import { runInTerminal as runInTerminalCommand } from './git/terminal-run.ts';
import { PluginLogoIcon } from './ui/plugin-icon.ts';
import { activeWorkspaceOf, getWorkspaceSnapshot, isSessionDisplayed, preloadWorkspace } from './panel/repo-preload.ts';
import css from './css/index.module.css';
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

/**
 * 把一次失败报成标题为「操作失败」的弹窗。
 *
 * 差异页里多处动作只关心「成功就重取、失败就说清原因」，错误文案的整理因此收在一处。
 *
 * @param error - 捕获到的异常。
 * @returns 无。
 */
async function reportFailure(error: unknown): Promise<void> {
	await showMessage({ title: '操作失败', message: error instanceof Error ? error.message : String(error) });
}

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
	// 返回的 promise 供需要排定顺序的调用方等待（先定位、再开浏览器）；失败一律吞掉。
	const revealPath = React.useCallback((path: string): Promise<void> => {
		if (typeof props.revealPath !== 'function') return Promise.resolve();
		try {
			return Promise.resolve(props.revealPath(path)).then(() => undefined, () => undefined);
		} catch {
			return Promise.resolve();
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
 * 视图用 DSH forge 变更视图的 DiffFile（见 ./forge-adapter.tsx）：它与 DSH 面板
 * 共用同一份实现，因此行号、hunk 头、并排/单栏、代码高亮、未变更行折叠都随 DSH
 * 一起演进，不再由本插件维护副本。
 *
 * @param props.sessionId - 席位给出的会话 id。
 * @param props.useSessions - session 作用域席位的标准快照 hook。
 * @param props.useTabInfo - 席位标准 hook，提供 tab.navigation.address。
 * @returns 差异视图元素。
 */
function GitDiffTab(props) {
	const { sessionId, useSessions, useTabInfo, clientContext, inputActions } = props;
	// 评论的终点是当前会话的输入框：插一条定位引用，用户可先编辑再发送。
	const addToInput = React.useCallback((text: string): boolean => {
		if (inputActions === undefined || typeof inputActions.insertQuote !== 'function') return false;
		return inputActions.insertQuote(text);
	}, [inputActions]);
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
	// forge 的 DiffFile 要展开状态、已展开的未变更行区段与行绘制观察器；单文件页各自持有。
	const [fileState, setFileState] = React.useState<DiffFileState>({ expanded: true, revealed: false, open: new Set() });
	const reach = React.useMemo(() => new SectionReach(), []);
	const scrollRoot = React.useRef<HTMLDivElement | null>(null);
	React.useEffect(() => {
		reach.attach(scrollRoot.current);
		return () => { reach.attach(null); };
	}, [reach]);
	// 换文件时重置该文件的展开状态与已展开区段，避免把上一个文件的下标带过来。
	React.useEffect(() => {
		setFileState({ expanded: true, revealed: false, open: new Set() });
	}, [currentPath, commitHash, staged, baseHash]);
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
	/** 逐段动作进行中：禁用全部段落按钮，避免两次点击撞在一起。 */
	const [resolving, setResolving] = React.useState(false);
	/** 分段暂存进行中。 */
	const [hunkBusy, setHunkBusy] = React.useState(false);
	/**
	 * 执行一次冲突处理并重取本页。
	 *
	 * 逐段与整文件两种粒度共用这条收尾：动作只改工作区文件，重取才能看到剩余段落。
	 *
	 * @param operation - 要执行的处理。
	 * @returns 无。
	 */
	const runResolve = React.useCallback((operation: () => Promise<unknown>): void => {
		setResolving(true);
		operation()
			.then(() => { load(); })
			.catch(reportFailure)
			.finally(() => { setResolving(false); setHunkBusy(false); });
	}, [load]);
	/*
	 * 三方内容与区间取舍：冲突文件不读工作区里的冲突标记，而是把基线 / 当前更改 /
	 * 传入的更改三份文本取来、在页面里算区间，再按选择表把结果写回。这与 VS Code
	 * 合并编辑器一致，也避免标记被人手工改过之后整份视图失真。
	 */
	const [mergePayload, setMergePayload] = React.useState<MergeContentsPayload | null>(null);
	const [choices, setChoices] = React.useState<ReadonlyMap<number, MergeChoice>>(new Map());
	const [mergeBusy, setMergeBusy] = React.useState(false);
	const analysis = React.useMemo(
		() => (mergePayload === null
			? null
			: analyzeMerge(mergePayload.base ?? '', mergePayload.ours ?? '', mergePayload.theirs ?? '')),
		[mergePayload],
	);
	const loadMerge = React.useCallback(() => {
		if (typeof gitCwd !== 'string' || currentPath === '') return;
		loadMergeContents(gitCwd, currentPath)
			.then((payload) => { setMergePayload(payload); })
			.catch(() => { setMergePayload(null); });
	}, [gitCwd, currentPath]);
	React.useEffect(() => {
		if (diffData === null || !diffData.conflict) { setMergePayload(null); setChoices(new Map()); return; }
		setChoices(new Map());
		loadMerge();
	}, [diffData, loadMerge]);
	/**
	 * 选择一处区间的取舍：只更新本地选择表，写回由提交时统一做。
	 *
	 * 与 VS Code 合并编辑器一样，结果文档是选择表的纯映射，因此连续选择不会反复读写文件。
	 *
	 * @param index - 区间序号。
	 * @param choice - 取舍。
	 * @returns 无。
	 */
	const handleChoose = React.useCallback((index: number, choice: MergeChoice): void => {
		setChoices((previous) => {
			const next = new Map(previous);
			next.set(index, choice);
			return next;
		});
	}, []);
	/**
	 * 把合并视图里的一段评论插进对话输入框。
	 *
	 * 评论带着「哪一份内容第几行」的定位：模型据此能自己去读对应版本，不必把代码抄进消息。
	 *
	 * @param range - 选区（当前更改或传入的更改的行号）。
	 * @param body - 评论正文。
	 * @returns 无。
	 */
	const handleMergeComment = React.useCallback((range: LineRange, body: string): void => {
		addToInput(formatMergeComment(currentPath, range.side === 'R' ? 'theirs' : 'ours', range.startLine, range.endLine, body));
	}, [addToInput, currentPath]);
	/**
	 * 把当前选择表写回工作区，并在没有任何冲突残留时标记为已解决。
	 *
	 * @returns 无。
	 */
	const handleApplyMerge = React.useCallback((): void => {
		if (typeof gitCwd !== 'string' || parsed === null) return;
		setMergeBusy(true);
		applyMergeChoices(gitCwd, currentPath, choices)
			.then(async (unresolved) => {
				if (unresolved === 0) {
					// 全部处理完：落索引，冲突条目随之离开「合并冲突」分组。
					const report = await resolveConflict(gitCwd, [currentPath], 'markResolved');
					if (report.errors.length > 0) await showMessage({ title: '标记已解决失败', message: report.errors.join('\n') });
				}
				load();
				loadMerge();
			})
			.catch(reportFailure)
			.finally(() => { setMergeBusy(false); });
	}, [gitCwd, parsed, currentPath, choices, load, loadMerge]);
	/** 文件当前的补丁块；分段暂存条据此列出可处理的块。 */
	const [hunks, setHunks] = React.useState<FileHunk[]>([]);
	React.useEffect(() => {
		// 提交与对比作用域没有「暂存这一块」的语义：只对工作区与暂存区两个作用域取块。
		if (typeof gitCwd !== 'string' || currentPath === '' || commitHash !== '*') { setHunks([]); return undefined; }
		const cancelled = { current: false };
		void (async () => {
			try {
				const list = await loadFileHunks(gitCwd, currentPath, staged);
				if (!cancelled.current) setHunks(list);
			} catch {
				if (!cancelled.current) setHunks([]);
			}
		})();
		return () => { cancelled.current = true; };
	}, [gitCwd, currentPath, staged, commitHash, diffData]);
	/**
	 * 暂存或取消暂存若干补丁块。
	 *
	 * @param indexes - 块下标；空数组表示全部块。
	 * @returns 无。
	 */
	const handleApplyHunk = React.useCallback((indexes: readonly number[]): void => {
		if (typeof gitCwd !== 'string') return;
		setHunkBusy(true);
		// 分段命令把失败原因放在返回值里（逐块处理允许部分成功），因此这里额外判一次。
		runResolve(async () => {
			const error = await applyHunkCommand(gitCwd, currentPath, indexes, staged ? 'unstage' : 'stage');
			if (error !== null) throw new Error(error);
		});
	}, [gitCwd, currentPath, staged, runResolve]);
	if (parsed === null) {
		return React.createElement('div', { className: shared.empty }, '无效的差异地址');
	}
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
	/**
	 * 绘制正文：读取中、读取失败、二进制各给一行说明，文本比较交给 forge 的 DiffFile。
	 *
	 * 这几条状态文案与 DSH 差异视图一致，因此与 forge 面板里同样的失败看起来没有差别。
	 *
	 * @returns 正文元素。
	 */
	const renderDiffBody = () => {
		if (loading) return React.createElement('p', { className: css.status, role: 'status' }, '正在读取改动…');
		if (diffData === null) {
			return React.createElement('div', { className: css.status },
				React.createElement('span', null, '无法读取改动'),
				React.createElement('button', { type: 'button', className: css.tool, onClick: load }, '重试'));
		}
		if (diffData.binary) return React.createElement('p', { className: css.status }, '二进制文件，无法显示改动');
		/*
		 * 冲突走逐段左右对照：处理粒度是「这一段取哪边」，动作在中间一列，而不是在顶栏
		 * 对整个文件取一边。非冲突文件仍交给 forge 的 DiffFile，并在它上方挂分段暂存条。
		 */
		// 分段条对冲突与普通文件都要：冲突改完仍需按块进出索引。
		const hunkBar = hunks.length === 0
			? null
			: React.createElement(HunkBar, { hunks, staged, busy: hunkBusy || resolving, onApply: handleApplyHunk });
		if (diffData.conflict) {
			if (analysis === null) {
				return React.createElement('p', { className: css.status, role: 'status' }, '正在读取三方内容…');
			}
			const conflicting = analysis.ranges.filter((range) => range.conflicting).length;
			const handled = analysis.ranges.filter((range) => range.conflicting && choices.has(range.index)).length;
			return React.createElement(React.Fragment, null,
				hunkBar,
				React.createElement(MergeView, {
					analysis, choices, wrap, busy: mergeBusy, onChoose: handleChoose,
					onComment: handleMergeComment,
				}),
				React.createElement('div', { className: css.mergeFooter },
					React.createElement('span', { className: css.mergeFooterText },
						conflicting === 0
							? '双方改动没有重叠，可直接写回。'
							: `已处理 ${String(handled)} / ${String(conflicting)} 处冲突`),
					React.createElement('button', {
						type: 'button', className: css.primaryButton, disabled: mergeBusy,
						title: '把当前取舍写成结果文件', 'data-sc-apply-merge': '',
						onClick: handleApplyMerge,
					}, '写回结果'),
				));
		}
		return React.createElement(React.Fragment, null,
			hunkBar,
			React.createElement(ForgeDiffView, {
				path: currentPath,
				content: diffData,
				scope: scope ?? { kind: 'worktree', staged: false },
				split,
				wrap,
				state: fileState,
				setState: setFileState,
				reach,
				addToInput,
			}));
	};
	return React.createElement(
		'div',
		{ className: css.diffTab },
		React.createElement('div', { className: css.header },
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
			{ className: css.diffTabBody, ref: scrollRoot },
			renderDiffBody(),
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

	/*
	 * 右键菜单：宿主提供共享菜单时改走它，否则保持本插件的自建浮层。
	 *
	 * 用 ctx.inject 而不是 ctx.get 探测：只有服务就位时这段才启动，服务缺席时不注册、
	 * 也不影响插件其余部分；服务卸载时作用域回到这里清空。
	 */
	if (typeof ctx.inject === 'function') {
		ctx.inject(['contextMenus'], (scope: { contextMenus?: ContextMenus; effect?: (run: () => () => void) => void }) => {
			const menus = scope.contextMenus;
			if (menus === undefined) return;
			useSharedContextMenu(menus);
			// 作用域销毁时清空：服务没了就必须退回自建浮层，不能留着失效引用。
			scope.effect?.(() => () => { useSharedContextMenu(null); });
		});
	}

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
export { __forgeAdapter } from './diff/forge-adapter.tsx';
/**
 * 合并视图与分段条的可测面。
 *
 * 客户端测试跑在 Node 里，而 Node 的类型剥离不处理 TSX/JSX 之外的部分也要走产物，
 * 因此这两份实现从构建产物取，断言的就是页面会跑的那份。
 */
export { MergeView, rowsOfAnalysis } from './diff/merge-view.ts';
export { HunkBar } from './diff/hunk-bar.ts';
