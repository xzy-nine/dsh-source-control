/**
 * 源代码管理面板主体：持有状态与数据加载，把三个分区组装成侧栏页。
 *
 * 布局为「源代码管理 + 图形」视图，控件使用 DSH 的
 * ui-primitives，因此外观与 Harness 本身一致。分区组件、纯计算与 hooks
 * 同目录按职责拆分。
 */
import React from 'react';
import {
	addRemote, addToGitignore, addToLocalExclude, checkoutBranch, commitStaged, compareCommits, createArchive, deleteRemote, deleteUserDetails, discardPaths,
	editRemote, editUserDetails, exportRepoConfig, fetchRepo, generateCommitMessage, ghAccount, ghCreatePullRequest,
	ghCreateRepo, ghRepoInfo, loadBranchBase, loadConfig, loadCommitFiles, loadRefs,
	abortMerge, localExcludeState, loadCommitMessage,
	merge, pushBranch, pushStash, pushUpstream, initSubmodule, removeWorktree, resetToCommit, sshStatus, stagePaths, throwIfError, translateAvailable,
	translateText, unstagePaths,
} from '../api/index.ts';
import { copyText, showContextMenu, type ContextMenuItem } from '../ui/context-menu.ts';
import { cloneTerminalCommand } from '../git/clone-command.ts';
import { checkoutFailureText } from './git-messages.ts';
import { showCheckbox, showForm, showMessage, showSelect, showTabbedForm, showText, type FormPage } from '../ui/dialog.ts';
import { remoteHostOf, toHttpsRemoteUrl, toSshRemoteUrl } from '../git/remote-url.ts';
import { RefFilterDialog } from './ref-filter-dialog.ts';
import { ChangesSection, GraphSection, RepoSection } from './sections.ts';
import { ROW_HEIGHT } from '../graph/lanes.ts';
import { changeOf } from './changes.ts';
import { hasGitHubRemote } from './github.ts';
import { interfaceLanguage, showTranslateEntry, translateCommitMessage } from './language.ts';
import { reportError } from './errors.ts';
import { showToast } from './toast.ts';
import {
	checkedRefIds, computeSyncMarkers, currentBranchHashes, DEFAULT_REF_FILTER, filterKeyOf, filterSummaryOf,
	legacyFilterOf, readStoredFilter, REF_FILTER_KEY, revalidatedFilter, sortRefs, writeStoredFilter,
} from './refs.ts';
import type { AutoFilterContext, RefFilter } from './refs.ts';
import { openCommitMenu, openRefMenu } from './commit-menu.ts';
import {
	draftKeyOf, loadSessionValue, loadValue, migrateLegacyDrafts, primeStorage, saveSessionValue, saveValue,
	storageReady as storagePrimed,
} from './storage.ts';
import { clearPersistedDraft, logClient, migrateLegacyState, loadHooksState, takePersistedDraft } from '../api/index.ts';
import { useAutoFetch } from './use-auto-fetch.ts';
import { useCommitStats } from './use-commit-stats.ts';
import { useFileChangeRefresh, type SessionsLike } from './use-file-change-refresh.ts';
import { dropGraphWindows, rememberedMaxCommits, useGraphData } from './use-graph-data.ts';
import { discardNoticeOf } from './discard-notice.ts';
import { backgroundFlagsOf, lastRefreshText as relativeRefreshText, refreshNoticeSince } from './refresh-status.ts';
import type { RefreshBaseline } from './refresh-status.ts';
import { useRepositoryWriteEvents } from './use-repository-write-events.ts';
import { useRepos } from './use-repos.ts';
import { addBusy, busyFlagsOf, isRepoBusy, removeBusy } from './busy.ts';
import { commitEntries } from './optimistic.ts';
import { logCommitCountOf } from './commit-diff.ts';
import { canSubmitOf, commitButtonDisabledOf, divergedOf, primaryActionOf } from './submit-state.ts';
import { formatDate, loadSettings, REMOTE_PROTOCOLS, saveSettings, SettingsPanel } from './settings.ts';
import { useResizeHandler } from './use-resize.ts';
import { textOf, trimmedTextOf } from '../shared/text.ts';
import { PLUGIN_VERSION } from '../shared/version.ts';
import type { AiStats, BusyScope, Commit, CommitFile, RefInfo, RefItem, Settings, WorkingTreeEntry } from '../shared/types.ts';
import type { LocalExcludeState, IgnoreWriteResult } from '../api/index.ts';
import type { HooksState } from '../api/index.ts';
import css from '../css/panel.module.css';
import shared from '../css/shared.module.css';
import { MENU_TARGET_CLASS } from '../css/state-classes.ts';

/** 初始加载的提交数；切换仓库时回到该值。 */
const INITIAL_MAX_COMMITS = 200;


/** 面板属性。 */
export interface GitGraphPanelProps {
	/** 会话工作区路径；没有工作区时为 undefined。 */
	readonly cwd?: string | undefined;
	/** 会话 id，用于持久化存储库选中与展开状态。 */
	readonly sessionId: string;
	/** 打开文件差异（打开右侧栏 Diff 页）。 */
	readonly onOpenDiff?: ((target: unknown) => void) | undefined;
	/** 在系统文件管理器中定位一个路径；未装载时为 undefined。 */
	readonly onRevealPath?: ((path: string) => void) | undefined;
	/** 打开宿主目录选择器；未装载时为 undefined。 */
	readonly pickDirectory?: (() => Promise<string | null>) | undefined;
	/** 在侧边栏终端里执行命令；未装载时为 undefined。 */
	readonly runInTerminal?: ((sessionId: string, command: string) => Promise<boolean>) | undefined;
	/** 取会话服务；未装载时为 null。 */
	readonly getSessions?: (() => unknown) | undefined;
}

/** 提交信息中的 Issue 是否开启链接（依赖设置）。 */
function issueLinkingConfigOf(settings: Settings): unknown {
	return settings.issueLinkingConfig ?? null;
}

/**
 * 源代码管理面板。
 *
 * @param props - 见 {@link GitGraphPanelProps}。
 * @returns 面板元素。
 */
export function GitGraphPanel({ cwd, sessionId, onOpenDiff, onRevealPath, pickDirectory, runInTerminal, getSessions }: GitGraphPanelProps): React.ReactElement {
	const [message, setMessage] = React.useState('');
	const [aiBusy, setAiBusy] = React.useState(false);
	const [aiWarning, setAiWarning] = React.useState('');
	const [aiStats, setAiStats] = React.useState<AiStats | null>(null);
	const [translateBusy, setTranslateBusy] = React.useState(false);
	// 翻译服务由 cot-translation bundle 可选装载；不可用时连入口都不显示。
	const [translateReady, setTranslateReady] = React.useState(false);
	// 已翻译过的文本：避免对同一内容重复请求，也用于标记「已翻译」。
	const [translatedFrom, setTranslatedFrom] = React.useState<string | null>(null);
	const aiAbortRef = React.useRef<AbortController | null>(null);
	const [amend, setAmend] = React.useState(false);
	/**
	 * 本次提交与推送是否运行 git 钩子。
	 *
	 * 提交钩子或推送钩子存在时默认勾选，取消勾选即本次用 `--no-verify` 跳过。这是**临时**选择：
	 * 每次切换仓库与每次提交、推送完成后都回到默认勾选，不持久化。
	 */
	const [runHooks, setRunHooks] = React.useState(true);
	/** 当前仓库的钩子状态；未探测到或未激活时两个字段皆为 false。 */
	const [hooksState, setHooksState] = React.useState<HooksState>({ commit: false, push: false, directory: null });
	const [settings, setSettings] = React.useState<Settings>(() => loadSettings());
	const [settingsOpen, setSettingsOpen] = React.useState(false);
	/** 打开设置时直接落位的页签；仓库区标题行与反馈入口各自指定。 */
	const [settingsTab, setSettingsTab] = React.useState<'repo' | 'global' | 'feedback'>('repo');
	const [userDetails, setUserDetails] = React.useState<{ userName?: unknown; userEmail?: unknown } | null>(null);
	// 当前工作树的本地排除条目；有内容时提交框显示查看入口。
	const [localExclude, setLocalExclude] = React.useState<LocalExcludeState | null>(null);
	/** 克隆进行中：只禁用克隆入口，不影响面板其余控件。 */
	const [cloneBusy, setCloneBusy] = React.useState(false);
	/**
	 * 待重扫标志：命令写进终端后置位，窗口重新获得焦点时重扫一次。
	 *
	 * 克隆在终端里何时结束无法观测，因此不在面板里定时重扫——定时重扫会在克隆期间
	 * 反复做整棵仓库树的发现与领先/落后拉取，与服务端争抢资源。
	 */
	const rescanPending = React.useRef(false);
	const [filterOpen, setFilterOpen] = React.useState(false);
	const [filterSearch, setFilterSearch] = React.useState('');
	/*
	 * 引用筛选按仓库持久化，模型与 VS Code 的图形视图一致：状态是「全部」「自动」或一组手选
	 * 引用；自动模式不落盘（持久化形状见 refs.ts）。
	 */
	const [refFilter, setRefFilter] = React.useState<RefFilter>(DEFAULT_REF_FILTER);
	/** 宿主持久化是否已预取完成：筛选在完成之后再读，否则读到的是回退值。 */
	const [storageReady, setStorageReady] = React.useState(() => storagePrimed());
	/** 弹窗与手选校验用的全部引用；按仓库缓存。 */
	const [refItems, setRefItems] = React.useState<{ repo: string; items: RefItem[] } | null>(null);
	/** 引用清单的作废计数：分支/标签/远程变化后递增，手选筛选据此重新校验。 */
	const [refsRevision, setRefsRevision] = React.useState(0);
	/** 自动筛选的分叉来源；记录所属仓库与分支，供取数与弹窗使用。 */
	const [branchBase, setBranchBase] = React.useState<{ repo: string; branch: string; base: string | null } | null>(null);
	// 分组各自的「已折叠」文件夹集合（默认空＝全部展开）；窗口级、不持久化。
	// detail 是图形区内展开块的文件夹集合。
	const [collapsedByGroup, setCollapsedByGroup] = React.useState<{ staged: Set<string>; unstaged: Set<string>; detail: Set<string> }>(
		() => ({ staged: new Set(), unstaged: new Set(), detail: new Set() }),
	);
	const [groupExpanded, setGroupExpanded] = React.useState<{ staged: boolean; unstaged: boolean }>(() => ({ staged: true, unstaged: true }));
	// 存储库、图形两区可收起（默认展开）；跨会话持久化。
	const [repoSecOpen, setRepoSecOpen] = React.useState<boolean>(() => loadValue('dsh-source-control-repo-open', true));
	const [graphSecOpen, setGraphSecOpen] = React.useState<boolean>(() => loadValue('dsh-source-control-graph-open', true));
	// 图形区高度（像素）；跨会话持久化，默认 320。
	const [graphHeight, setGraphHeight] = React.useState<number>(() => loadValue('dsh-source-control-graph-height', 320));
	// 存储库区高度（像素）；跨会话持久化，默认 200。
	const [repoHeight, setRepoHeight] = React.useState<number>(() => loadValue('dsh-source-control-repo-height', 200));
	/*
	 * 「上次刷新」文案的时钟：按固定间隔推进，让相对时间从「刚刚」变成「n 分钟前」。
	 *
	 * 只在面板可见时跑——不可见时无人看，推进只会触发无意义的重渲染。页签重新可见时立即推进
	 * 一次，切回时文案不必等到下一个周期才更新。
	 */
	const [refreshClock, setRefreshClock] = React.useState<number>(() => Date.now());
	React.useEffect(() => {
		let timer: number | undefined;
		/** 开始推进；已在推进时保持原定时器。 */
		const start = (): void => {
			if (timer !== undefined) return;
			timer = window.setInterval(() => { setRefreshClock(Date.now()); }, 30_000);
		};
		/** 停止推进。 */
		const stop = (): void => {
			if (timer === undefined) return;
			window.clearInterval(timer);
			timer = undefined;
		};
		/** 按当前可见性启停。 */
		const sync = (): void => {
			if (document.visibilityState !== 'visible') { stop(); return; }
			setRefreshClock(Date.now());
			start();
		};
		sync();
		document.addEventListener('visibilitychange', sync);
		return () => {
			document.removeEventListener('visibilitychange', sync);
			stop();
		};
	}, []);
	/*
	 * 宿主状态预取。
	 *
	 * 预取是异步的，而上面这些 useState 的初始值在挂载时同步取过；那时缓存还空着，拿到的是回退值，
	 * 且 useState 的初始值不会随预取完成自动重算 —— 不显式回填，每次进入都会显示默认值（表现为
	 * 「设置每次都被重置」）。预取完成后因此把这几项按真实值重新写入。
	 *
	 * 状态迁移与预取串行，且预取完成才回填：设置面板、布局高度都只在用户打开时可见，与首屏三区
	 * 无关，因此不占用首屏关键路径。仓库位置由宿主在发现命令里自行读取，这里不预取。
	 */
	React.useEffect(() => {
		if (cwd === undefined) return undefined;
		const cancelled = { current: false };
		void (async () => {
			// 先迁移浏览器里的旧数据，再预取：顺序反了会把旧值当成已迁移。
			// 草稿是会话级数据，不经过宿主迁移，也不受宿主迁移标记约束。
			migrateLegacyDrafts();
			await migrateLegacyState(cwd);
			await primeStorage(cwd);
			if (cancelled.current) return;
			setSettings(loadSettings());
			setRepoSecOpen(loadValue('dsh-source-control-repo-open', true));
			setGraphSecOpen(loadValue('dsh-source-control-graph-open', true));
			setGraphHeight(loadValue('dsh-source-control-graph-height', 320));
			setRepoHeight(loadValue('dsh-source-control-repo-height', 200));
			// 引用筛选也按仓库回填；标记就绪让载入 effect 重跑一次。
			setStorageReady(true);
		})();
		return () => { cancelled.current = true; };
	}, [cwd]);
	const graphScrollRef = React.useRef<HTMLDivElement | null>(null);

	const toggleRepoSec = React.useCallback(() => {
		setRepoSecOpen((previous) => { const next = !previous; saveValue('dsh-source-control-repo-open', next); return next; });
	}, []);
	const toggleGraphSec = React.useCallback(() => {
		setGraphSecOpen((previous) => { const next = !previous; saveValue('dsh-source-control-graph-open', next); return next; });
	}, []);
	const commitGraphHeight = React.useCallback((value: number) => {
		const clamped = Math.max(120, Math.min(value, 720));
		setGraphHeight(clamped);
		saveValue('dsh-source-control-graph-height', clamped);
	}, []);
	// 拖拽图形区上沿（工作区与图形的分界线）：向上拖＝图形变高。
	const startGraphResize = useResizeHandler(graphHeight, 'up', commitGraphHeight);

	const commitRepoHeight = React.useCallback((value: number) => {
		const clamped = Math.max(80, Math.min(value, 600));
		setRepoHeight(clamped);
		saveValue('dsh-source-control-repo-height', clamped);
	}, []);
	// 拖拽存储库区下沿（存储库与更改的分界线）：向下拖＝存储库变高。
	const startRepoResize = useResizeHandler(repoHeight, 'down', commitRepoHeight);

	const {
		treeStatus, treeNote, selectedId, expandedIds, visibleRows, syncById, selectedNode,
		selectNode, toggleNode, setSyncById, setSelectedId, rescan, refreshTree,
	} = useRepos({ cwd, sessionId });

	// 发现结束前不按工作区根加载，避免先加载一次再被选中结果覆盖。
	// 路径已不存在的节点（刚被移除的工作树或子模块）按未选中处理：否则 git 子进程的工作目录
	// 不存在，命令以 `spawn git ENOENT` 失败，而重取尚未返回时节点仍在树上。
	const workingTreePath = selectedNode !== null && selectedNode.available
		? selectedNode.path
		: (treeStatus === 'loading' ? null : (cwd ?? null));
	const hasWorkspace = cwd !== undefined;

	/**
	 * 已加载的提交数上限。
	 *
	 * 触底自动加载会持续累加，切换仓库时收回到该仓库上次的值（没有记录时用初始值）：避免跨仓库
	 * 累积，同时保证切回同一仓库时提交图窗口缓存的键不变、不必重发 `git log`。初值同样取缓存，
	 * 否则首帧会先按初始值取一次、再按恢复值重取。
	 */
	const [maxCommits, setMaxCommits] = React.useState(
		() => (workingTreePath === null ? INITIAL_MAX_COMMITS : (rememberedMaxCommits(workingTreePath) ?? INITIAL_MAX_COMMITS)),
	);

	/** 当前选中节点的领先/落后与分支信息；随快照刷新写回。 */
	const currentSync = selectedId === null ? undefined : syncById.get(selectedId);
	/**
	 * 把筛选状态写回当前仓库。
	 *
	 * 持久化表按仓库键存：自动模式删掉该仓库的项，「全部」记字面量，手选记引用 id。
	 */
	const patchFilter = React.useCallback((next: RefFilter) => {
		setRefFilter(next);
		if (workingTreePath === null) return;
		saveValue(REF_FILTER_KEY, writeStoredFilter(loadValue(REF_FILTER_KEY, {}), workingTreePath, next));
	}, [workingTreePath]);

	/*
	 * 载入当前仓库的筛选状态。
	 *
	 * 必须等宿主持久化预取完成：预取前读到的只会是回退值，而 useState 的初值不会随预取重算
	 * （此前漏了这一处回填，表现为重启后筛选回到默认自动）。
	 */
	React.useEffect(() => {
		if (!storageReady || workingTreePath === null) return;
		const registry = loadValue<Record<string, unknown>>(REF_FILTER_KEY, {});
		const key = filterKeyOf(workingTreePath);
		if (registry[key] !== undefined) {
			setRefFilter(readStoredFilter(registry, workingTreePath));
			return;
		}
		/*
		 * 旧版本把筛选按仓库存成独立键（`<前缀>:<仓库路径>`）：首次进入时折合到新表并清掉旧键，
		 * 否则升级后各仓库的筛选都会回到默认自动。
		 */
		const legacyKey = `${REF_FILTER_KEY}:${workingTreePath}`;
		const legacyValue = loadValue<unknown>(legacyKey, null);
		const legacy = legacyFilterOf(legacyValue);
		setRefFilter(legacy ?? DEFAULT_REF_FILTER);
		if (legacy === null) return;
		saveValue(REF_FILTER_KEY, writeStoredFilter(registry, workingTreePath, legacy));
		saveValue(legacyKey, null);
	}, [storageReady, workingTreePath]);

	/*
	 * 弹窗与手选校验需要的全部引用。
	 *
	 * 只在打开弹窗或处于手选模式时读：刷新路径不为筛选列表起这次 `for-each-ref`。
	 */
	React.useEffect(() => {
		if (workingTreePath === null) return undefined;
		if (!filterOpen && refFilter.mode !== 'manual') return undefined;
		const cancelled = { current: false };
		const repo = workingTreePath;
		void (async () => {
			try {
				const items = await loadRefs(repo, settings.showRemoteBranches);
				if (!cancelled.current) setRefItems({ repo, items });
			} catch {
				if (!cancelled.current) setRefItems({ repo, items: [] });
			}
		})();
		return () => { cancelled.current = true; };
	}, [workingTreePath, filterOpen, refFilter.mode, settings.showRemoteBranches, refsRevision]);

	/*
	 * 手选引用可能已被删除或改名：按刚读到的引用重新校验，全部失效即回退自动。
	 * 与 VS Code 的手选恢复同一判据。
	 */
	React.useEffect(() => {
		if (refFilter.mode !== 'manual') return;
		if (refItems === null || refItems.repo !== workingTreePath) return;
		const next = revalidatedFilter(refFilter, refItems.items);
		if (next.mode === refFilter.mode && next.ids.length === refFilter.ids.length
			&& next.ids.every((id, index) => id === refFilter.ids[index])) return;
		patchFilter(next);
	}, [refFilter, refItems, workingTreePath, patchFilter]);

	const { state, setState, refresh, refreshEntries, loadMore, busyRef, graphScope } = useGraphData({
		workingTreePath, hasWorkspace, maxCommits, settings, selectedId, setSyncById,
		filter: refFilter, branchBase, headHint: selectedNode?.branch ?? null,
		upstreamHint: currentSync?.upstream ?? null,
	});
	/** 选中仓库的忙碌分级；分区按控件用途取用，慢操作不会禁用无关按钮。 */
	const busyFlags = React.useMemo(() => busyFlagsOf(state.busy, workingTreePath), [state.busy, workingTreePath]);

	const {
		statsByHash, messageByHash, translatedByHash, translatedFromByHash, translatingHash,
		graphTranslated, graphTranslating,
		hoverCommit, translateCommit, cancelTranslateCommit, translateCommits, cancelTranslateCommits,
	} = useCommitStats({ workingTreePath, translateReady, onTranslateError: showToast, cleanupSeconds: settings.cleanupSeconds });

	// 会话服务只在渲染期读取：该插件的客户端半边可能晚于本插件激活。
	const sessions = React.useMemo(() => {
		try {
			return (getSessions?.() ?? null) as SessionsLike | null;
		} catch {
			return null;
		}
	}, [getSessions]);

	/*
	 * 文件改动事件驱动的自动刷新：工具写入/编辑落地、且目标确实在所选仓库内时重载面板。
	 * 事件窗口覆盖当前会话（含 run_code 里的嵌套调用）。
	 */
	useFileChangeRefresh({
		sessions,
		sessionId,
		workingTreePath,
		cwd: cwd ?? null,
		enabled: settings.autoRefresh,
		busyRef,
		refresh,
	});

	/*
	 * 宿主事件流：别的会话、别的工作区或外部进程对当前仓库的写操作不产生本会话事件，
	 * 事件驱动的刷新看不到。订阅宿主推送的仓库写事件补上这条通道，按仓库路径过滤。
	 * 同一通道的结构事件（工作树登记、子模块目录、`.gitmodules`）触发仓库树重取。
	 */
	useRepositoryWriteEvents({
		workingTreePath,
		cwd: cwd ?? null,
		enabled: settings.autoRefresh,
		busyRef,
		refresh,
		refreshTree,
	});

	/*
	 * 定时抓取：唯一的定时网络操作，默认关闭。启用后按周期静默抓取当前仓库的远程引用，
	 * 抓取同样受「聚焦 + 空闲」门控。
	 */
	useAutoFetch({
		workingTreePath,
		enabled: settings.autoFetch,
		periodSeconds: settings.autoFetchPeriod,
		busyRef,
		fetch: async (path) => await fetchRepo(path, null, settings.fetchAndPrune, settings.fetchAndPruneTags),
		/*
		 * 抓取拉回了新引用才重载：面板先用本地引用渲染，抓取完成后并入远程引用与领先/落后。
		 * 远端没有新提交时不作废窗口缓存、不重取 —— 定时抓取每轮都重取一遍是纯浪费。
		 */
		onFetched: (path) => {
			dropGraphWindows(path);
			void refresh('reconcile');
		},
	});

	/*
	 * 克隆命令写入终端后置起重扫标志，窗口重新获得焦点时重扫一次仓库树。
	 *
	 * 克隆在终端里何时结束无法观测，因此不在面板里定时重扫：克隆中途目标目录还不是
	 * 仓库，外层仓库的工作区读取会把这棵正在增长的目录树整体列为未跟踪文件，定时重扫
	 * 会在克隆全程反复拉取整棵仓库树与服务端争抢资源。
	 */
	React.useEffect(() => {
		const onReturn = (): void => {
			if (!rescanPending.current) return;
			rescanPending.current = false;
			rescan();
		};
		window.addEventListener('focus', onReturn);
		document.addEventListener('visibilitychange', onReturn);
		return () => {
			window.removeEventListener('focus', onReturn);
			document.removeEventListener('visibilitychange', onReturn);
		};
	}, [rescan]);

	/* 翻译服务是否可用：换仓库时重查一次（同一进程内结果稳定，不必频繁请求）。 */
	React.useEffect(() => {
		if (workingTreePath === null) { setTranslateReady(false); return undefined; }
		let cancelled = false;
		void translateAvailable(workingTreePath).then((available) => { if (!cancelled) setTranslateReady(available); });
		return () => { cancelled = true; };
	}, [workingTreePath]);

	/* 本地排除条目：换仓库时读一次，写入后再刷新，决定提交框是否显示查看入口。 */
	React.useEffect(() => {
		if (workingTreePath === null) { setLocalExclude(null); return undefined; }
		let cancelled = false;
		localExcludeState(workingTreePath)
			.then((state) => { if (!cancelled) setLocalExclude(state); })
			.catch(() => { if (!cancelled) setLocalExclude(null); });
		return () => { cancelled = true; };
	}, [workingTreePath]);

	/*
	 * git 钩子状态：换仓库时探测一次，决定提交框是否显示 githook 勾选项。
	 *
	 * 换仓库即回到「运行钩子」：勾选是临时选择，不跨仓库、不跨会话保留。
	 */
	React.useEffect(() => {
		setRunHooks(true);
		if (workingTreePath === null) { setHooksState({ commit: false, push: false, directory: null }); return undefined; }
		let cancelled = false;
		loadHooksState(workingTreePath)
			.then((state) => { if (!cancelled) setHooksState(state); })
			.catch(() => { if (!cancelled) setHooksState({ commit: false, push: false, directory: null }); });
		return () => { cancelled = true; };
	}, [workingTreePath]);

  /*
	 * 提交信息草稿：按仓库根存会话级存储（sessionStorage），键为 ggg-commit-msg:<仓库根绝对路径>。
	 *
	 * 草稿只活在本次会话，不落宿主；键取仓库根，因此同一工作区下的不同仓库各存各的。
	 *
	 * 写入必须等草稿读完：message 初始为空串，若在读回之前就写入，会把刚切换过来的仓库的草稿覆盖成空。
	 * readDone 标记读完这一刻，之后才允许写。切换仓库时先把上一个仓库的草稿写回它自己的键，再读新仓库的。
	 */
	const [draftReadDone, setDraftReadDone] = React.useState(false);
	/** 当前 message 所属的仓库；与 workingTreePath 不同时不得写入。 */
	const [draftPath, setDraftPath] = React.useState<string | null>(null);
	/** message 的当前值：切换仓库的收尾里读取它，避免把旧值写进新仓库的键。 */
	const messageRef = React.useRef(message);
	messageRef.current = message;

	React.useEffect(() => {
		const path = workingTreePath;
		if (path === null) { setDraftReadDone(false); setDraftPath(null); return undefined; }
		const cancelled = { current: false };
		// 本轮读取是否完成：cleanup 只在完成后写回，否则会把上一个仓库的 message 写进当前仓库的键。
		let readDone = false;
		setDraftReadDone(false);
		const key = draftKeyOf(path);
		void (async () => {
			// 早期版本把草稿落在宿主：取回一次，转入会话存储后删除宿主旧键。
			const persisted = await takePersistedDraft(path, key);
			if (cancelled.current) return;
			const saved = loadSessionValue<string | null>(key, null);
			if (saved === null && persisted !== null) {
				saveSessionValue(key, persisted);
				// 草稿已落到会话存储，再清宿主旧键；删除失败不影响已取回的草稿。
				void clearPersistedDraft(path, key).catch(() => { /* 删除失败时草稿仍在会话存储 */ });
			}
			setMessage(saved ?? persisted ?? '');
			setDraftPath(path);
			readDone = true;
			setDraftReadDone(true);
		})();
		return () => {
			cancelled.current = true;
			// 离开本仓库：读回完成后 message 才是本仓库的内容，此时才把草稿写回它自己的键。
			if (!readDone) return;
			saveSessionValue(key, messageRef.current);
		};
	}, [workingTreePath]);
	React.useEffect(() => {
		if (workingTreePath === null || !draftReadDone || draftPath !== workingTreePath) return;
		saveSessionValue(draftKeyOf(workingTreePath), message);
	}, [workingTreePath, message, draftReadDone, draftPath]);

	/**
	 * 选中一个仓库节点并重置面板状态。
	 *
	 * 进入新仓库属于「用户主动切换」：清空旧仓库的数据并置加载态，随后的加载走 full 模式。
	 */
	const selectNodeAndReset = React.useCallback((node) => {
		if (node.id === selectedId) return;
		selectNode(node);
		setState((previous) => ({
			...previous, phase: 'loading', commits: [], entries: [],
			detail: null, selectedHash: null, error: null,
		}));
	}, [selectedId, selectNode, setState]);

	const toggleChange = React.useCallback((key: string, path: string) => {
		setCollapsedByGroup((previous) => {
			const current = previous[key as 'staged' | 'unstaged' | 'detail'];
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return { ...previous, [key]: next };
		});
	}, []);

	const toggleGroup = React.useCallback((key: string) => {
		setGroupExpanded((previous) => ({ ...previous, [key]: !previous[key as 'staged' | 'unstaged'] }));
	}, []);

	/**
	 * 执行一次操作并刷新。
	 *
	 * 忙碌按「目标仓库 + 影响面」记录：只禁用该仓库同类用途的控件，其它仓库与其它影响面不受
	 * 影响。`read` 影响面的操作自身已经刷新，不再追加一次；目标是别的仓库时也不刷新当前仓库，
	 * 选中项变化后由提交图数据自行加载。
	 *
	 * 写操作成功后先按 git 语义就地推算新的工作区条目（乐观更新），界面立刻反映结果；随后
	 * 用一次对账刷新纠正推算误差。对账是 reconcile 模式，不会清空现有列表。
	 *
	 * `historyChanged` 决定对账的深度：可能改动引用或提交历史的操作（检出、重置、提交、贮藏、
	 * 抓取等）需作废该仓库的提交图窗口并重取提交图；纯工作区操作（暂存、取消暂存、丢弃、忽略
	 * 规则）只重取工作区快照。缺省为 true，即按可能改动引用与提交历史处理。
	 *
	 * @param scope - 操作的影响面。
	 * @param operation - 操作体。
	 * @param repo - 目标仓库路径；省略时用当前选中的工作树。
	 * @param optimistic - 写操作成功后对条目的推算；省略时不推算，只做对账刷新。
	 * @param options - 见上；省略时按可能改动引用与提交历史处理。
	 */
	const run = React.useCallback(async (
		scope: BusyScope,
		operation: () => Promise<void>,
		repo?: string,
		optimistic?: (entries: readonly WorkingTreeEntry[]) => WorkingTreeEntry[],
		options?: { readonly historyChanged?: boolean; readonly intent?: string },
	) => {
		const target = repo ?? workingTreePath;
		if (target === null) return;
		const historyChanged = options?.historyChanged !== false;
		// 用户意图：日志里只有 git 命令时，无法把「用户点了什么」和命令对上。
		const intent = options?.intent ?? `${scope} 操作`;
		logClient('I', 'action', `用户操作：${intent}（仓库 ${target}）`);
		const startedAt = Date.now();
		setState((previous) => ({ ...previous, busy: addBusy(previous.busy, target, scope), error: null }));
		try {
			await operation();
			logClient('I', 'action', `操作完成：${intent}，耗时 ${String(Date.now() - startedAt)} ms`);
			if (optimistic !== undefined && target === workingTreePath) {
				setState((previous) => ({ ...previous, entries: optimistic(previous.entries) }));
			}
			if (scope === 'read') return;
			// 目标是别的仓库：只作废它的窗口缓存，当前仓库的视图不动。
			if (target !== workingTreePath) {
				if (historyChanged) dropGraphWindows(target);
				return;
			}
			if (!historyChanged) {
				await refreshEntries();
				return;
			}
			// 写操作可能改动引用与提交历史，目标仓库的提交图窗口缓存随之失效。
			dropGraphWindows(target);
			// 引用清单同样可能变化：手选筛选据此重新校验，失效的引用会回退自动。
			setRefsRevision((previous) => previous + 1);
			await refresh('reconcile');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logClient('E', 'action', `操作失败：${intent}：${message}`);
			reportError(setState, message);
		} finally {
			setState((previous) => ({ ...previous, busy: removeBusy(previous.busy, target, scope) }));
		}
	}, [workingTreePath, refresh, refreshEntries, setState]);

	/**
	 * 在进度条下执行一次不刷新的预备调用。
	 *
	 * 用于弹窗打开前的远端查询（如 gh 账号与分支列表）：这类请求耗时可达数秒，
	 * 若不置 busy，顶部不定进度条不会出现，界面看起来像卡住。失败时返回 null 而不抛错，
	 * 由调用方决定降级路径。
	 *
	 * @param scope - 预备调用的影响面。
	 * @param operation - 预备操作。
	 * @returns 操作结果；失败时为 null。
	 */
	const withProgress = React.useCallback(async <T,>(scope: BusyScope, operation: () => Promise<T>): Promise<T | null> => {
		const target = workingTreePath;
		if (target !== null) setState((previous) => ({ ...previous, busy: addBusy(previous.busy, target, scope) }));
		try {
			return await operation();
		} catch {
			return null;
		} finally {
			if (target !== null) setState((previous) => ({ ...previous, busy: removeBusy(previous.busy, target, scope) }));
		}
	}, [workingTreePath, setState]);

	/**
	 * 推送某个仓库的当前分支到其上游，失败时报错。
	 *
	 * `pushUpstream` 把失败放在返回值里而不抛错，因此这里显式检查，避免静默失败。
	 * 未配置远程或当前分支没有上游时，git 给出的是多行长文，这里替换为可读提示；
	 * 这两类提示按 git 的实际措辞匹配，措辞变化时退回原文。
	 *
	 * @param repoPath - 目标仓库路径；省略时用当前选中的工作树。
	 * @param skipHooks - 是否跳过推送钩子（`--no-verify`）。
	 */
	const pushCurrentBranch = React.useCallback(async (repoPath?: string, skipHooks = false) => {
		const error = await pushUpstream(repoPath ?? (workingTreePath as string), skipHooks);
		if (error === null) return;
		if (/no configured push destination|no configured remote/i.test(error)) {
			throw new Error('未配置远程仓库，请先在设置中添加远程。');
		}
		if (/has no upstream branch/i.test(error)) {
			throw new Error('当前分支没有上游分支，请先设置上游后再推送。');
		}
		throw new Error(error);
	}, [workingTreePath]);

	/** 轻量提示：说明当前条件下操作无法进行的原因，或报告一次性结果。 */
	const notify = React.useCallback((message: string): Promise<void> => {
		showToast(message);
		return Promise.resolve();
	}, []);

	/**
	 * 丢弃路径上的改动，并把未能完全丢弃的情形告知用户。
	 *
	 * 子模块条目只移动其指向的提交，不清理子模块内部的未提交改动；这类结局必须提示，
	 * 否则用户会以为改动已被丢弃。返回结局供变更区只移除真正丢弃的条目。
	 *
	 * @param cwd - 目标仓库路径。
	 * @param paths - 要丢弃的路径。
	 * @param untracked - 这些路径是否都是未跟踪文件。
	 * @returns 丢弃结局。
	 */
	const handleDiscardPaths = React.useCallback(async (cwd: string, paths: readonly string[], untracked: boolean) => {
		const report = await discardPaths(cwd, paths, untracked);
		const notice = discardNoticeOf(report);
		if (notice !== '') await notify(notice);
		return report;
	}, [notify]);

	/** 中止进行中的合并，把工作区恢复到合并前。已解决的冲突改动会一并丢弃，因此先确认。 */
	const handleAbortMerge = React.useCallback(() => {
		void (async () => {
			const ok = await showCheckbox({
				title: '取消合并',
				message: '中止当前合并，把工作区恢复到合并前的状态。\n已解决的冲突改动会一并丢弃。',
				checkboxLabel: '确认取消合并', danger: true,
			});
			if (!ok) return;
			await run('history', async () => {
				await abortMerge(workingTreePath as string);
			}, undefined, undefined, { intent: '中止合并' });
		})();
	}, [run, workingTreePath]);

	/** 把当前改动存入贮藏；贮藏信息由用户输入，留空表示不指定。 */
	const handleStash = React.useCallback(() => {
		void (async () => {
			const label = await showText({
				title: '贮藏改动',
				message: '把当前所有改动（含未跟踪文件）存入贮藏。',
				label: '贮藏信息（可选）',
				placeholder: '例如：调试到一半',
			});
			if (label === null) return;
			await run('commit', async () => {
				const error = await pushStash(workingTreePath as string, label, true);
				if (error !== null) throw new Error(error);
			}, undefined, undefined, { intent: '贮藏改动' });
		})();
	}, [run, workingTreePath]);

	/** 选中仓库的 HEAD 提交哈希（用于检出提交状态显示）。 */
	/** 选中仓库的 HEAD 提交哈希（用于检出提交状态显示）；查找是 O(提交数)，随滚动逐帧重渲染时须记忆化。 */
	const headCommitHash = React.useMemo(
		() => state.commits.find((commit) => commit.hash !== '*')?.hash ?? null,
		[state.commits],
	);

	/** 当前分支可达的提交哈希集合；重置这类改写当前分支的操作据此显示。 */
	const branchHashes = React.useMemo(
		() => currentBranchHashes(state.commits, state.head),
		[state.commits, state.head],
	);

	/**
	 * 打开某个提交或工作区文件。
	 *
	 * 新增文件（已暂存的 `A` 与未跟踪的 `?`）没有可比差异，按普通文件打开（kind 为 'file'）。
	 * repoRoot 传所选仓库根：它与会话工作区根未必相同，地址由索引侧换算。
	 *
	 * @param hash - 提交哈希；'*' 表示工作区。
	 * @param path - 文件路径（相对仓库根）。
	 * @param staged - 工作区时是否取暂存区内容。
	 * @param isNew - 是否是新增文件。
	 * @param baseHash - 旧侧提交哈希；非空时按两提交对比打开。
	 */
	const openDiff = React.useCallback((hash: string, path: string, staged: boolean, isNew = false, baseHash?: string): Promise<void> => {
		const kind = isNew ? 'file' : (hash === '*' ? 'worktree' : 'commit');
		const diff = kind === 'file'
			? { kind, path, repoRoot: workingTreePath }
			: kind === 'worktree'
				? { kind, path, staged, untracked: false, repoRoot: workingTreePath }
				: { kind, hash: hash.slice(0, 8), hashFull: hash, subject: `${hash.slice(0, 7)} ${path}`, path, repoRoot: workingTreePath, baseHash: baseHash ?? null };
		if (typeof onOpenDiff === 'function') {
			// 对比时 id 带上旧侧哈希：同一文件的不同对比组合各自成页。
			onOpenDiff({ id: `gg-diff:${baseHash ?? ''}:${hash}:${path}:${staged ? 's' : 'u'}`, type: 'diff', title: path.split('/').pop() ?? 'Diff', diff });
		}
		return Promise.resolve();
	}, [onOpenDiff, workingTreePath]);

	/** 打开一个日志文件：绝对路径按普通文件打开（不比较差异）。 */
	const openLogFile = React.useCallback((path: string): void => { void openDiff('*', path, false, true); }, [openDiff]);

	/**
	 * 选中一个提交，并加载其改动文件。
	 *
	 * @param hash - 目标提交哈希。
	 * @param baseHash - 旧侧提交哈希；非空时加载两个提交之间的改动。
	 */
	const selectCommit = React.useCallback(async (hash: string, baseHash?: string) => {
		setState((previous) => ({ ...previous, selectedHash: hash, detail: null }));
		if (workingTreePath === null) return;
		try {
			const commit = state.commits.find((item) => item.hash === hash);
			const compareWith = baseHash === undefined ? null : state.commits.find((item) => item.hash === baseHash) ?? null;
			setState((previous) => ({
				...previous,
				detail: commit === undefined ? null : { commit, files: [], compareWith, loading: true },
			}));
			if (baseHash !== undefined) {
				const files = await compareCommits(workingTreePath, baseHash, hash);
				setState((previous) => (previous.selectedHash === hash && previous.detail !== null
					? { ...previous, detail: { ...previous.detail, files, loading: false } }
					: previous));
				return;
			}
			if (hash === '*') {
				const files: CommitFile[] = state.entries.map((entry) => ({ path: entry.path, type: changeOf(entry).type, additions: null, deletions: null }));
				setState((previous) => (previous.selectedHash === hash && previous.detail !== null
					? { ...previous, detail: { ...previous.detail, files, loading: false } }
					: previous));
				return;
			}
			const files = await loadCommitFiles(workingTreePath, hash);
			setState((previous) => (previous.selectedHash === hash && previous.detail !== null
				? { ...previous, detail: { ...previous.detail, files, loading: false } }
				: previous));
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, state.commits, state.entries, setState]);

	/**
	 * 点击提交行。
	 *
	 * 已有展开项时按住 Ctrl/Cmd 点击其他提交进入对比：方向取列表中靠后的（较旧）为 `from`，
	 * 靠前的（较新）为 `to`，与改动方向一致。再次点击同一对组合取消对比。
	 *
	 * @param hash - 被点击的提交哈希。
	 * @param additive - 是否按住了 Ctrl/Cmd。
	 */
	const toggleCommit = React.useCallback((hash: string, additive = false) => {
		const current = state.detail;
		if (additive && current !== null && current.commit.hash !== hash) {
			// 已在对比同一组合时取消，回到单个提交详情。
			if (current.compareWith !== null && current.compareWith.hash === hash) {
				void selectCommit(current.commit.hash);
				return;
			}
			const order = new Map(state.commits.map((item, index) => [item.hash, index]));
			const fromFirst = (order.get(current.commit.hash) ?? 0) > (order.get(hash) ?? 0);
			const from = fromFirst ? current.commit.hash : hash;
			const to = fromFirst ? hash : current.commit.hash;
			void selectCommit(to, from);
			return;
		}
		if (state.selectedHash === hash) {
			setState((previous) => ({ ...previous, selectedHash: null, detail: null }));
			return;
		}
		void selectCommit(hash);
	}, [state.selectedHash, state.detail, state.commits, selectCommit, setState]);

	/**
	 * 转到当前 HEAD 提交：把滚动容器定位到该提交所在行。
	 *
	 * 图形区按可视区窗口化渲染，目标行可能尚未挂载，因此不能靠 `querySelector` 找行；
	 * 直接按行号算出偏移并设置滚动位置，窗口随之把该行渲染出来。
	 */
	const goToHead = React.useCallback(() => {
		const headCommit = state.commits.find((commit) => commit.hash !== '*' && (commit.heads ?? []).includes(state.head ?? ''));
		const target = headCommit ?? state.commits.find((commit) => commit.hash !== '*');
		if (target === undefined) return;
		const container = graphScrollRef.current;
		if (container === null) return;
		const index = state.commits.indexOf(target);
		if (index < 0) return;
		// 真正滚动的是图区内部元素（`graphScrollRef` 给的是外层容器）。
		const scroller = container.querySelector('[data-graph-scroll]') ?? container;
		scroller.scrollTo({ top: index * ROW_HEIGHT, behavior: 'smooth' });
	}, [state.commits, state.head]);

	/** 加载仓库后自动滚动到 HEAD。 */
	const didAutoScrollRef = React.useRef(false);
	React.useEffect(() => {
		if (!settings.onRepoLoadScrollToHead) return undefined;
		if (didAutoScrollRef.current) return undefined;
		if (state.phase !== 'ready' || state.commits.length === 0) return undefined;
		didAutoScrollRef.current = true;
		const timer = setTimeout(goToHead, 60);
		return () => { clearTimeout(timer); };
	}, [settings.onRepoLoadScrollToHead, state.phase, state.commits, goToHead]);
	/*
	 * 切换仓库时把已加载提交数收回到该仓库上次的值（没有记录时用初始值）：避免跨仓库累积，
	 * 同时保证切回同一仓库时窗口缓存的键不变、不必重发 `git log`。
	 */
	React.useEffect(() => {
		setMaxCommits(workingTreePath === null
			? INITIAL_MAX_COMMITS
			: (rememberedMaxCommits(workingTreePath) ?? INITIAL_MAX_COMMITS));
	}, [workingTreePath]);
	React.useEffect(() => { didAutoScrollRef.current = false; }, [workingTreePath]);

	const stagedPaths = React.useMemo(
		() => state.entries.filter((entry) => changeOf(entry).staged).map((entry) => entry.path),
		[state.entries],
	);

	/**
	 * 勾选「修补上一次提交」时填入上一提交的完整消息；取消勾选时清空。
	 *
	 * 提交列表里的 message 只含标题（`git log --format=%s`），正文需按需取回。
	 *
	 * @param checked - 是否勾选。
	 */
	const toggleAmend = React.useCallback((checked: boolean) => {
		setAmend(checked);
		if (!checked) {
			setMessage('');
			return;
		}
		const lastCommit = state.commits.find((commit) => commit.hash !== '*');
		if (lastCommit === undefined) return;
		// 先填标题，正文取回后再替换；取不到时保留标题。
		setMessage(lastCommit.message ?? '');
		if (workingTreePath === null) return;
		void loadCommitMessage(workingTreePath, lastCommit.hash)
			.then((full) => { if (full !== null && full !== '') setMessage(full); })
			.catch(() => { /* 取不到正文时保留标题 */ });
	}, [state.commits, workingTreePath]);

	/**
	 * 提交暂存区。
	 *
	 * 勾选修补时允许没有暂存改动，只改提交信息；处于未完成的合并时同样允许，此时提交是结束合并
	 * 的唯一动作，提交信息留空表示沿用 git 生成的合并信息。
	 */
	const submit = (): void => {
		const merging = state.merging;
		if (commitButtonDisabledOf({ busy: busyFlags.commit, canSubmit: canSubmitOf({ stagedCount: stagedPaths.length, amend, merging }), messageEmpty: message.trim() === '', merging })) return;
		// 钩子激活且取消勾选时本次跳过；提交完成后回到默认勾选。
		const skipHooks = hooksState.commit && !runHooks;
		void run('commit', async () => {
			await commitStaged(workingTreePath as string, message, amend, skipHooks);
			setMessage('');
			setAmend(false);
			setRunHooks(true);
		}, undefined, commitEntries, { intent: amend ? '修补上一次提交' : (merging ? '提交并结束合并' : '提交暂存的更改') });
	};

	/**
	 * AI 生成提交信息：流式输出，不开启思考。
	 *
	 * 系统提示词带上当前界面语言，降低生成错语言的概率；生成完成后若内容仍以
	 * 非当前语言为主，界面出现翻译按钮。
	 */
	const handleAiCommit = (): void => {
		if (aiBusy) return;
		if (workingTreePath === null) { setAiWarning('未选中仓库'); return; }
		if (aiAbortRef.current !== null) { aiAbortRef.current.abort(); aiAbortRef.current = null; }
		setAiBusy(true);
		setAiWarning('');
		setAiStats(null);
		setTranslatedFrom(null);
		setMessage('');
		const controller = new AbortController();
		aiAbortRef.current = controller;
		generateCommitMessage(workingTreePath, settings.aiCommitProvider, settings.aiCommitModel, settings.aiCommitRules, {
			signal: controller.signal,
			onChunk: (text) => { setMessage((prev) => prev + text); },
			onWarning: (text) => { setAiWarning(text); },
			onError: (text) => { setAiWarning(text); },
			onStats: (stats) => { setAiStats(stats as AiStats); },
		// 勾选「修补上一次提交」时，让宿主把上一提交的改动一并纳入 diff。
		}, amend, interfaceLanguage()).finally(() => { setAiBusy(false); aiAbortRef.current = null; }).catch((err: unknown) => { setAiWarning(err instanceof Error ? err.message : String(err)); });
	};

	/**
	 * 翻译提交信息：按行请求，保持原有换行结构。
	 *
	 * 逐行而不是整段一次：整段会被翻译服务拼成一行，丢失标题与要点的分行。
	 * 每行的 git 惯例前缀（`feat:`、`fix(api):` 等）原样保留，只翻译其后的正文。
	 */
	const handleTranslate = React.useCallback(() => {
		if (translateBusy || workingTreePath === null || message.trim() === '') return;
		const source = message;
		const locale = interfaceLanguage();
		setTranslateBusy(true);
		void (async () => {
			try {
				// 空行保留为空行，其余每行单独翻译。
				setMessage(await translateCommitMessage(source, (body) => translateText(workingTreePath, body, locale)));
				setTranslatedFrom(source);
			} catch (error) {
				await notify(error instanceof Error ? error.message : String(error));
			} finally {
				setTranslateBusy(false);
			}
		})();
	}, [translateBusy, workingTreePath, message, notify]);

	/*
	 * 后台刷新指示：两个分区各自按作用面取进行中标志，「上次刷新」文案每 30 秒重算一次，
	 * 避免每次渲染都生成新字符串、也让时间不会一直停在「刚刚」。
	 */
	const backgroundFlags = React.useMemo(() => backgroundFlagsOf(state.background), [state.background]);
	const lastRefreshText = React.useMemo(() => {
		if (state.lastRefreshAt <= 0) return '';
		return relativeRefreshText(state.lastRefreshAt, refreshClock);
	}, [state.lastRefreshAt, refreshClock]);
	const syncMarkers = React.useMemo(
		() => computeSyncMarkers(state.commits, state.head, currentSync?.upstream ?? null),
		[state.commits, state.head, currentSync],
	);
	const workAreaEmpty = state.entries.length === 0;
	const hasRemoteDiff = currentSync !== undefined && (currentSync.ahead > 0 || currentSync.behind > 0);
	/**
	 * 当前分支是纯本地分支：有分支、无上游。
	 *
	 * `loadRepoSync` 无上游时 `upstream` 为 null，检出到游离头时 `branch` 为 null。
	 */
	const isUnpublishedBranch = currentSync !== undefined && currentSync.branch !== null && currentSync.upstream === null;
	/*
	 * 主按钮的动作：待合并状态与修补期间固定为提交，其余按有无暂存改动、领先落后与是否已发布决定。
	 */
	const primaryAction = primaryActionOf({ workAreaEmpty, hasRemoteDiff, isUnpublishedBranch, amend, merging: state.merging });
	const showSyncButton = primaryAction === 'sync';
	const showPublishButton = primaryAction === 'publish';
	/*
	 * 双向分叉：本地与上游各有对方没有的提交时，同步按钮的右键给出两种整体覆盖。
	 * 普通同步只会把两侧合并，整体覆盖只能在同步入口上单独给出。
	 */
	const overwriteChoicesAvailable = showSyncButton && divergedOf({
		ahead: currentSync?.ahead ?? 0, behind: currentSync?.behind ?? 0,
	});
	/** 提交按钮可用：有暂存改动、勾选修补，或处于未完成的合并。 */
	const canSubmit = canSubmitOf({ stagedCount: stagedPaths.length, amend, merging: state.merging });

	/*
	 * 后台刷新完成后的轻量告知：只在条目数或已加载提交数变化时给一次，不打断操作。
	 *
	 * 判据是 `lastRefreshAt` 推进——它只由后台刷新写入，用户主动刷新（`full`）不经过
	 * 后台登记，因此不会被告知「结果就在眼前的那一次刷新」。
	 *
	 * 只有取数范围相同且两轮都已就绪时才比较计数：换仓库、换引用起点、加载更多与加载中
	 * 的计数不是同一批数据，差值会被误报成「提交图 ±全部提交数」。
	 */
	const noticeBaselineRef = React.useRef<RefreshBaseline | null>(null);
	React.useEffect(() => {
		if (state.lastRefreshAt <= 0) return;
		if (noticeBaselineRef.current?.at === state.lastRefreshAt) return;
		const current: RefreshBaseline = {
			at: state.lastRefreshAt,
			scope: graphScope,
			ready: state.phase === 'ready',
			entries: state.entries.length,
			commits: logCommitCountOf(state.commits),
		};
		const notice = refreshNoticeSince(noticeBaselineRef.current, current);
		noticeBaselineRef.current = current;
		if (notice !== '') showToast(notice, { tone: 'info' });
	}, [state.lastRefreshAt, state.phase, state.entries, state.commits, graphScope]);

	/**
	 * 是否显示提交信息框的翻译入口。
	 *
	 * 判据与提交浮窗共用 {@link showTranslateEntry}：翻译服务已装载（否则点了也失败）、
	 * 当前无生成或翻译任务、内容非空且以非当前语言为主。已翻译过的内容不再重复提示。
	 */
	const showTranslate = showTranslateEntry({
		ready: translateReady, busy: aiBusy || translateBusy, text: message,
		locale: interfaceLanguage(), translatedFrom,
	});

	/**
	 * 读取本地 SSH 状态；结果由宿主按主机缓存，设置面板与发布流程共用这一入口。
	 *
	 * @param host - 目标主机名。
	 * @param refresh - 为 true 时忽略宿主缓存重新探测。
	 * @returns SSH 状态；没有工作区或请求失败时为 null。
	 */
	const handleCheckSsh = React.useCallback(async (host: string, refresh = false) => (
		workingTreePath === null ? null : withProgress('network', () => sshStatus(workingTreePath, host, refresh))
	), [workingTreePath, withProgress]);

	/**
	 * 校验目标主机的 SSH 可用性：客户端、私钥与认证。
	 *
	 * @param host - 目标主机名。
	 * @returns 就绪时为 true；否则说明原因并返回 false。
	 */
	const ensureSshReady = React.useCallback(async (host: string): Promise<boolean> => {
		const status = await handleCheckSsh(host);
		if (status !== null && status.ready) return true;
		await showMessage({
			title: 'SSH 未就绪',
			message: status === null ? '无法获取本地 SSH 状态，请稍后重试。' : status.message ?? `本地 SSH 无法用于 ${status.host}。`,
		});
		return false;
	}, [handleCheckSsh]);

	/**
	 * 没有远程时：在同一个对话框里用页签选择发布方式。
	 *
	 * GitHub 页签与手工页签一并列出，切换页签不丢失已填内容；未安装 gh / 未登录 / 缺 scope
	 * 时不显示 GitHub 页签，改为在对话框内说明原因，手工页签始终可用。
	 * 两页都可选协议：手工页按所选协议换算地址（HTTPS ⇄ SSH），GitHub 页让 gh 以所选协议建远程；
	 * 换算为 SSH 或建仓前先校验本机 SSH 状态。
	 *
	 * @param branch - 当前分支名。
	 * @returns 选中的方式与参数；取消时返回 null。
	 */
	const askRemoteSource = React.useCallback(async (branch: string): Promise<
		| { kind: 'manual'; name: string; url: string; protocol: 'https' | 'ssh' }
		| { kind: 'github'; owner: string; name: string; private: boolean; description: string; protocol: 'https' | 'ssh' }
		| null
	> => {
		const account = await withProgress('network', () => ghAccount(workingTreePath as string));
		const ghReady = account !== null && account.loggedIn
			&& account.owners.length > 0
			&& !account.unavailable.some((item) => item.feature === 'create-repo');
		// 仓库名预填存储库区域显示的名称，即所选节点的末段目录名。
		const repoName = selectedNode?.name ?? '';
		const user = account?.user ?? '';
		const orgs = (account?.owners ?? []).filter((owner) => owner !== user);
		const protocolField = {
			type: 'select' as const, name: 'protocol', label: '协议', value: 'https', options: REMOTE_PROTOCOLS,
		};

		const manualPage: FormPage = {
			value: 'manual',
			label: '手动输入地址',
			message: '填写已有远程仓库的地址。',
			fields: [
				{ type: 'text', name: 'name', label: '远程名', value: 'origin', placeholder: 'origin' },
				{ type: 'text', name: 'url', label: '远程地址', placeholder: 'https://github.com/owner/repo.git 或 git@github.com:owner/repo.git' },
				protocolField,
			],
		};
		const unavailableNote = account !== null && account.loggedIn
			? account.unavailable.find((item) => item.feature === 'create-repo')?.message ?? ''
			: '未检测到可用的 GitHub 登录，请先运行 gh auth login。';

		const pages: [FormPage, ...FormPage[]] = ghReady
			? [
				{
					value: 'github',
					label: '新建 GitHub 仓库',
					message: `仓库将创建在所选账号下，并把分支 ${branch} 推送上去。`,
					fields: [
						{
							// 账户类型决定下一级：个人账号直接用当前账号，组织再选具体组织。
							// 没有加入任何组织时不显示该字段，避免出现无选项的分支。
							type: 'select', name: 'accountType', label: '账户类型', value: 'user',
							options: [
								{ value: 'user', label: `个人（${user}）` },
								{ value: 'org', label: '组织' },
							],
							visibleWhen: () => orgs.length > 0,
						},
						{
							type: 'dropdown', name: 'owner', label: '组织', value: orgs[0] ?? '',
							options: orgs.map((org) => ({ value: org, label: org })),
							visibleWhen: (values: Record<string, unknown>) => orgs.length > 0 && values.accountType === 'org',
						},
						{ type: 'text', name: 'name', label: '仓库名', value: repoName, placeholder: 'my-repo' },
						{
							type: 'select', name: 'visibility', label: '可见性', value: 'private', options: [
								{ value: 'private', label: '私有' },
								{ value: 'public', label: '公开' },
							],
						},
						protocolField,
						{ type: 'text', name: 'description', label: '简介（可选）', placeholder: '' },
					],
				},
				manualPage,
			]
			: [
				{
					...manualPage,
					message: `当前仓库还没有远程仓库，请输入地址后发布。\n${unavailableNote}`.trim(),
				},
			];

		const form = await showTabbedForm({ title: '发布', pages, confirmLabel: '发布' });
		if (form === null) return null;
		if (form.page === 'github') {
			const name = trimmedTextOf(form.name);
			if (name === '') return null;
			// 个人账号固定为当前登录用户；组织取所选组织。组织为空时退回个人账号。
			const chosenOrg = trimmedTextOf(form.owner);
			const owner = form.accountType === 'org' && chosenOrg !== '' ? chosenOrg : user;
			if (owner === '') return null;
			// 选 SSH 时先确认本机可认证，避免仓库已建好却推送失败。
			if (form.protocol === 'ssh' && !await ensureSshReady('github.com')) return null;
			return {
				kind: 'github',
				owner,
				name,
				private: textOf(form.visibility, 'private') !== 'public',
				description: trimmedTextOf(form.description),
				protocol: form.protocol === 'ssh' ? 'ssh' : 'https',
			};
		}
		const name = trimmedTextOf(form.name) === '' ? 'origin' : trimmedTextOf(form.name);
		let url = trimmedTextOf(form.url);
		if (url === '') return null;
		if (form.protocol === 'ssh') {
			const sshUrl = toSshRemoteUrl(url);
			if (sshUrl === null) {
				await showMessage({ title: '无法转换', message: '该地址不是 HTTP(S) 或 SSH 形态的远程地址，无法按 SSH 发布。' });
				return null;
			}
			const host = remoteHostOf(url);
			if (sshUrl !== url && !await ensureSshReady(host === '' ? 'github.com' : host)) return null;
			url = sshUrl;
		} else {
			// 选择 HTTPS 时把 SSH 形态的地址换算回 HTTPS；不可换算的地址按原样使用。
			url = toHttpsRemoteUrl(url) ?? url;
		}
		return { kind: 'manual', name, url, protocol: form.protocol === 'ssh' ? 'ssh' : 'https' };
	}, [workingTreePath, selectedNode, withProgress, ensureSshReady]);

	/**
	 * 发布当前本地分支：推送到选定远程并建立上游。
	 *
	 * 单一远程直接推送；多个远程弹窗选择；没有远程时可选 GitHub 建仓或手工输入地址。
	 */
	const handlePublish = React.useCallback(() => {
		if (busyFlags.network || workingTreePath === null || currentSync === undefined || currentSync.branch === null) return;
		const branch = currentSync.branch;
		const path = workingTreePath;
		// 推送钩子激活且取消勾选时本次跳过；推送完成后回到默认勾选。
		const skipHooks = hooksState.push && !runHooks;
		const publishDone = (): void => { setRunHooks(true); };
		void (async () => {
			let remote = '';
			if (state.remotes.length === 1) {
				remote = state.remotes[0].name;
			} else if (state.remotes.length > 1) {
				const picked = await showSelect({
					title: '发布到远程仓库',
					message: `把分支 ${branch} 推送到哪个远程仓库？`,
					options: state.remotes.map((item) => ({ value: item.name, label: `${item.name}${item.url !== undefined && item.url !== '' ? `（${item.url}）` : ''}` })),
				});
				if (picked === null || picked === '') return;
				remote = picked;
			} else {
				const source = await askRemoteSource(branch);
				if (source === null) return;
				if (source.kind === 'github') {
					await run('network', async () => {
						const url = await ghCreateRepo(path, {
							name: source.name, owner: source.owner, private: source.private, description: source.description,
							protocol: source.protocol,
						});
						await notify(`已发布到 ${url}`);
					}, undefined, undefined, { intent: '发布到 GitHub 新仓库' });
					return;
				}
				await run('network', async () => {
					const addError = await addRemote(path, source.name, source.url, null, false);
					if (addError !== null) throw new Error(addError);
					const errors = await pushBranch(path, branch, [source.name], skipHooks);
					if (errors.length > 0) throw new Error(errors.join('\n'));
				}, undefined, undefined, { intent: '添加远程并推送（发布）' });
				publishDone();
				return;
			}
			await run('network', async () => {
				const errors = await pushBranch(path, branch, [remote], skipHooks);
				if (errors.length > 0) throw new Error(errors.join('\n'));
			}, undefined, undefined, { intent: `推送分支 ${branch}` });
			publishDone();
		})();
	}, [busyFlags.network, state.remotes, currentSync, workingTreePath, run, askRemoteSource, notify, hooksState.push, runHooks]);

	const handleSync = (): void => {
		if (busyFlags.network || workingTreePath === null) return;
		const skipHooks = hooksState.push && !runHooks;
		void run('network', async () => {
			await fetchRepo(workingTreePath, null, settings.fetchAndPrune, settings.fetchAndPruneTags);
			if (currentSync !== undefined && currentSync.behind > 0 && currentSync.upstream !== null) {
				throwIfError(await merge(workingTreePath, currentSync.upstream), checkoutFailureText);
			}
			if (currentSync !== undefined && currentSync.ahead > 0 && state.head !== null) {
				await pushCurrentBranch(undefined, skipHooks);
			}
		}, undefined, undefined, { intent: '同步（抓取 + 合并或推送）' }).finally(() => { setRunHooks(true); });
	};

	/**
	 * 把上游名拆成远程名与分支名。
	 *
	 * 上游记作 `<远程>/<分支>`（如 `origin/main`），远程名可能含斜杠以外字符；
	 * 没有斜杠时无法判定远程，返回 null。
	 *
	 * @param upstream - 上游引用名。
	 * @returns 远程名与该远程上的分支名。
	 */
	const upstreamPartsOf = (upstream: string | null): { remote: string; branch: string } | null => {
		if (upstream === null) return null;
		const at = upstream.indexOf('/');
		if (at <= 0 || at === upstream.length - 1) return null;
		return { remote: upstream.slice(0, at), branch: upstream.slice(at + 1) };
	};

	/** 用本地分支覆盖远程分支：远程独有的提交会被丢弃。 */
	const overwriteRemoteWithLocal = React.useCallback(() => {
		const sync = currentSync;
		const path = workingTreePath;
		const parts = sync === undefined ? null : upstreamPartsOf(sync.upstream);
		if (sync === undefined || path === null || parts === null || sync.branch === null) return;
		const branch = sync.branch;
		const skipHooks = hooksState.push && !runHooks;
		void (async () => {
			const ok = await showCheckbox({
				title: '用本地覆盖远程',
				message: `把本地 ${branch} 强制推送到 ${parts.remote}/${parts.branch}：远程分支上独有的 ${String(sync.behind)} 个提交会被丢弃，推送后无法恢复。`,
				checkboxLabel: '我确认用本地分支覆盖远程分支',
				confirmLabel: '覆盖远程', danger: true,
			});
			if (!ok) return;
			await run('network', async () => {
				const errors = await pushBranch(path, branch, [parts.remote], skipHooks, 'force');
				if (errors.length > 0) throw new Error(errors.join('\n'));
			}, undefined, undefined, { intent: '用本地覆盖远程（强制推送）' });
		})();
	}, [currentSync, workingTreePath, hooksState.push, runHooks, run]);

	/** 用远程分支覆盖本地分支：本地独有的提交与已跟踪改动会被丢弃。 */
	const overwriteLocalWithRemote = React.useCallback(() => {
		const sync = currentSync;
		const path = workingTreePath;
		const parts = sync === undefined ? null : upstreamPartsOf(sync.upstream);
		if (sync === undefined || path === null || parts === null || sync.branch === null) return;
		const upstream = sync.upstream as string;
		const branch = sync.branch;
		void (async () => {
			const ok = await showCheckbox({
				title: '用远程覆盖本地',
				message: `把本地 ${branch} 重置到 ${upstream}：本地独有的 ${String(sync.ahead)} 个提交与已跟踪文件的未提交改动都会被丢弃（未跟踪文件保留），重置后无法恢复。`,
				checkboxLabel: '我确认用远程分支覆盖本地分支',
				confirmLabel: '覆盖本地', danger: true,
			});
			if (!ok) return;
			await run('history', async () => {
				await fetchRepo(path, parts.remote, settings.fetchAndPrune, settings.fetchAndPruneTags);
				const error = await resetToCommit(path, upstream, 'hard');
				if (error !== null) throw new Error(error);
			}, undefined, undefined, { intent: '用远程覆盖本地（硬重置）' });
		})();
	}, [currentSync, workingTreePath, run, settings.fetchAndPrune, settings.fetchAndPruneTags]);

	/** 同步按钮的右键菜单：双向分叉时给出两种整体覆盖。 */
	const handleSyncContextMenu = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
		const { clientX, clientY } = event;
		const upstream = currentSync?.upstream ?? '';
		showContextMenu({
			x: clientX, y: clientY,
			items: [
				{
					title: '用本地覆盖远程（强制推送）', danger: true,
					hint: upstream === '' ? undefined : `把本地分支强推到 ${upstream}`,
					onClick: () => { overwriteRemoteWithLocal(); },
				},
				{
					title: '用远程覆盖本地（硬重置）', danger: true,
					hint: upstream === '' ? undefined : `把本地分支重置到 ${upstream}`,
					onClick: () => { overwriteLocalWithRemote(); },
				},
			],
		});
	}, [currentSync, overwriteRemoteWithLocal, overwriteLocalWithRemote]);

	/** 写入设置并刷新（排序/显示项变化需要重新拉取提交图）。 */
	const changeSettings = React.useCallback((next: Settings) => {
		setSettings(next);
		saveSettings(next);
	}, []);

	/** 删除远程并刷新。 */
	const deleteRemoteByName = React.useCallback((name: string) => {
		void run('history', async () => { throwIfError(await deleteRemote(workingTreePath as string, name)); }, undefined, undefined, { intent: `删除远程 ${name}` });
	}, [workingTreePath, run]);

	/* 打开设置时加载仓库配置（用户身份等）。 */
	React.useEffect(() => {
		if (!settingsOpen || workingTreePath === null) return;
		void (async () => {
			try {
				const cfg = await loadConfig(workingTreePath, state.remotes.map((remote) => remote.name));
				const user = (cfg.config as { user?: { name?: unknown; email?: unknown } } | undefined)?.user;
				setUserDetails({ userName: user?.name, userEmail: user?.email });
			} catch { /* 加载失败时保留空表单 */ }
		})();
	}, [settingsOpen, workingTreePath, state.remotes]);

	const reloadUserDetails = async (): Promise<void> => {
		const cfg = await loadConfig(workingTreePath as string, state.remotes.map((remote) => remote.name));
		const user = (cfg.config as { user?: { name?: unknown; email?: unknown } } | undefined)?.user;
		setUserDetails({ userName: user?.name, userEmail: user?.email });
	};

	const handleEditUserDetails = React.useCallback((name: string, email: string, location: string, deleteLocalName: boolean, deleteLocalEmail: boolean) => {
		void run('history', async () => {
			const errors = await editUserDetails(workingTreePath as string, name, email, location, deleteLocalName, deleteLocalEmail);
			if (errors.length > 0) throw new Error(errors[0]);
			await reloadUserDetails();
		}, undefined, undefined, { intent: `修改用户身份（${location === 'global' ? '全局' : '当前仓库'}）` });
	}, [workingTreePath, run, state.remotes]);

	const handleDeleteUserDetails = React.useCallback((delName: boolean, delEmail: boolean, location: string) => {
		void run('history', async () => {
			const errors = await deleteUserDetails(workingTreePath as string, delName, delEmail, location);
			if (errors.length > 0) throw new Error(errors[0]);
			await reloadUserDetails();
		}, undefined, undefined, { intent: `删除用户身份（${location === 'global' ? '全局' : '当前仓库'}）` });
	}, [workingTreePath, run, state.remotes]);

	/** 添加远程并刷新。 */
	const handleAddRemote = React.useCallback((name: string, url: string, pushUrl: string | null) => {
		void run('history', async () => { throwIfError(await addRemote(workingTreePath as string, name, url, pushUrl, false)); }, undefined, undefined, { intent: `添加远程 ${name}` });
	}, [workingTreePath, run]);

	/** 编辑远程并刷新。 */
	const handleEditRemote = React.useCallback((nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) => {
		void run('history', async () => { throwIfError(await editRemote(workingTreePath as string, nameOld, nameNew, urlOld, urlNew, pushUrlOld, pushUrlNew)); }, undefined, undefined, { intent: `编辑远程 ${nameOld}` });
	}, [workingTreePath, run]);

	/**
	 * 把未暂存的路径加入 `.gitignore`，随后打开该文件的差异视图。
	 *
	 * 规则写进最近的 `.gitignore`（没有则在仓库根新建）；新建的文件没有旧侧内容，
	 * 因此按普通文件打开而不是差异。
	 */
	const handleAddToGitignore = React.useCallback((path: string) => {
		void (async () => {
			const written: { value: IgnoreWriteResult | null } = { value: null };
			await run('commit', async () => { written.value = await addToGitignore(workingTreePath as string, path); }, undefined, (entries) => entries.filter((entry) => entry.path !== path), { historyChanged: false, intent: `加入 .gitignore：${path}` });
			const result = written.value;
			if (result === null || result.file === '') return;
			await notify(result.rule === null ? `${result.file} 已包含该忽略规则。` : `已写入 ${result.file}：${result.rule}`);
			await openDiff('*', result.file, false, !result.tracked);
		})();
	}, [run, workingTreePath, openDiff, notify]);

	/**
	 * 把未暂存的路径加入本地排除文件 `.git/info/exclude`，随后打开该文件。
	 *
	 * 该文件在 `.git` 目录内，以宿主返回的绝对路径按普通文件打开。
	 */
	const handleAddToLocalExclude = React.useCallback((path: string) => {
		void (async () => {
			const written: { value: LocalExcludeState | null } = { value: null };
			await run('commit', async () => { written.value = await addToLocalExclude(workingTreePath as string, path); }, undefined, (entries) => entries.filter((entry) => entry.path !== path), { historyChanged: false, intent: `加入本地排除：${path}` });
			const state = written.value;
			// 写入失败时 run 已提示错误：保留原有状态，不清掉已有的查看入口。
			if (state === null || state.path === '') return;
			setLocalExclude(state);
			await openDiff('*', state.path, false, true);
		})();
	}, [run, workingTreePath, openDiff]);

	/** 打开本地排除文件；它在 `.git` 目录内，以绝对路径按普通文件打开。 */
	const handleShowLocalExclude = React.useCallback(() => {
		const state = localExclude;
		if (state === null || state.path === '') return;
		void openDiff('*', state.path, false, true);
	}, [localExclude, openDiff]);

	/**
	 * 克隆远程仓库：先填地址，再选父目录，然后在 DSH 终端里执行克隆命令。
	 *
	 * 克隆由终端承担——进度、凭据提示与交互都在那里，插件不自己跑 git；命令只依赖
	 * `git -C <父目录> clone`，不必切换终端目录。命令写入后置起重扫标志，窗口重新获得
	 * 焦点时重扫一次仓库树。
	 */
	const handleClone = React.useCallback(() => {
		void (async () => {
			if (cwd === undefined) {
				await notify('没有可用的会话工作区，无法克隆。');
				return;
			}
			if (cloneBusy) return;
			const form = await showForm({
				title: '克隆远程仓库',
				message: '输入远程仓库地址，下一步选择存放位置；克隆在 DSH 终端里执行。',
				fields: [
					{ type: 'text', name: 'url', label: '仓库地址', placeholder: 'https://github.com/owner/repo.git 或 git@github.com:owner/repo.git' },
					{ type: 'checkbox', name: 'shallow', label: '浅克隆（只取最近的历史）', value: false },
					{
						type: 'text', name: 'depth', label: '浅克隆深度', value: '1', placeholder: '1',
						visibleWhen: (values) => values.shallow === true,
					},
				],
				confirmLabel: '下一步',
			});
			if (form === null) return;
			const url = trimmedTextOf(form.url);
			if (url === '') return;
			const shallow = form.shallow === true;
			// 深度按正整数处理：0 与非数值都表示不做浅克隆，由 shallowCloneArgs 生成参数。
			const parsedDepth = Number.parseInt(textOf(form.depth), 10);
			const depth = shallow && Number.isInteger(parsedDepth) && parsedDepth > 0 ? parsedDepth : 0;
			if (pickDirectory === undefined) {
				await notify('当前界面没有装载目录选择器，无法选择存放位置。');
				return;
			}
			const parent = await pickDirectory();
			if (parent === null) return;
			const command = cloneTerminalCommand(parent, url, { depth });
			if (command === null) {
				await notify('地址或目录含无法自动转义的字符，请在终端里手动克隆。');
				return;
			}
			if (runInTerminal === undefined) {
				await notify('当前界面没有装载终端，无法在其中克隆。');
				return;
			}
			setCloneBusy(true);
			try {
				const started = await runInTerminal(sessionId, command);
				await notify(started
					? `已在终端执行克隆：${command}`
					: '无法在终端里执行克隆命令，请在终端里手动执行。');
				// 回到本窗口时重扫一次：克隆可能已经完成，也可能还在跑。
				if (started) rescanPending.current = true;
			} finally {
				setCloneBusy(false);
			}
		})();
	}, [cwd, notify, pickDirectory, runInTerminal, sessionId, cloneBusy, rescan]);

	/**
	 * 创建 Pull Request：选目标分支、填标题与正文，交给 gh 创建。
	 *
	 * 当前分支没有上游时先说明原因；gh 不可用时给出降级提示而不是静默失败。
	 */
	const handleCreatePullRequest = React.useCallback(async () => {
		if (workingTreePath === null || state.head === null || busyFlags.network) return;
		const path = workingTreePath;
		const head = state.head;

		const account = await withProgress('network', () => ghAccount(path));
		if (account === null || !account.loggedIn) {
			await notify('未检测到可用的 GitHub 登录，请先运行 gh auth login。');
			return;
		}
		const blocked = account.unavailable.find((item) => item.feature === 'create-pr');
		if (blocked !== undefined) {
			await notify(blocked.message);
			return;
		}

		const info = await withProgress('network', () => ghRepoInfo(path));
		const branches = (info?.branches ?? []).filter((name) => name !== head);
		if (branches.length === 0) {
			await notify('没有可作为目标的分支，请先把分支推送到远程。');
			return;
		}
		const base = info?.defaultBranch !== null && info?.defaultBranch !== undefined && branches.includes(info.defaultBranch)
			? info.defaultBranch
			: branches[0];
		const form = await showForm({
			title: '创建 Pull Request',
			message: `把 ${head} 合并到目标分支。`,
			fields: [
				{ type: 'select', name: 'base', label: '目标分支', value: base, options: branches.map((name) => ({ value: name, label: name })) },
				{ type: 'text', name: 'title', label: '标题', value: state.detail !== null && state.detail.commit.hash !== '*' ? (state.detail.commit.message ?? '') : '', placeholder: 'PR 标题' },
				{ type: 'textarea', name: 'body', label: '正文（可选）', placeholder: '' },
				{ type: 'checkbox', name: 'draft', label: '创建为草稿', value: false },
			],
		});
		if (form === null) return;
		const title = trimmedTextOf(form.title);
		if (title === '') return;
		await run('network', async () => {
			const url = await ghCreatePullRequest(path, {
				head,
				base: textOf(form.base, base),
				title,
				body: textOf(form.body),
				draft: form.draft === true,
			});
			await notify(url === '' ? 'Pull Request 已创建。' : `Pull Request 已创建：${url}`);
		}, undefined, undefined, { intent: `创建 Pull Request：${title}` });
	}, [workingTreePath, state.head, busyFlags.network, state.detail, run, notify, withProgress]);

	/** 导出仓库配置为 JSON 文件下载。 */
	const handleExportConfig = React.useCallback(async () => {
		if (workingTreePath === null) return;
		try {
			const config = await exportRepoConfig(workingTreePath);
			if (config === null) return;
			const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'source-control-config.json';
			a.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, setState]);


	/** 创建归档。 */
	const handleCreateArchive = React.useCallback(async (ref: string, refLabel: string) => {
		const format = await showSelect({
			title: '创建归档',
			message: `从 ${refLabel} 创建归档`,
			options: [
				{ value: 'zip', label: 'zip' },
				{ value: 'tar', label: 'tar' },
				{ value: 'tgz', label: 'tar.gz' },
			],
			value: 'zip',
		});
		if (format === null) return;
		const defaultName = `${ref.replace(/[^a-zA-Z0-9._-]/g, '-')}.${format}`;
		const outputPath = await showText({
			title: '归档输出路径',
			label: '文件路径',
			placeholder: defaultName,
			value: defaultName,
		});
		if (outputPath === null || outputPath === '') return;
		void run('read', async () => {
			const err = await createArchive(workingTreePath as string, ref, format, outputPath);
			if (err !== null) reportError(setState, err);
		}, undefined, undefined, { intent: `导出归档 ${ref}` });
	}, [workingTreePath, run, setState]);

	/* ── 右键菜单组装 ─────────────────────────────────────────── */

	/** 仓库行「更多操作」右键菜单。 */
	const handleRepoMoreActions = React.useCallback((node, event) => {
		const target = event.currentTarget;
		target.classList.add(MENU_TARGET_CLASS);
		const branchName = node.branch ?? '';
		// 只有链接工作树能被移除：主工作树会被 git 拒绝（is a main working tree）。
		const isLinkedWorktree = node.kind === 'worktree';
		// 未检出的子模块在磁盘上没有工作区，需要初始化后才能读取。
		const isUninitializedSubmodule = node.kind === 'submodule' && !node.available;
		const items: ContextMenuItem[] = [
			{ title: '刷新', onClick: () => { selectNodeAndReset(node); void run('read', () => refresh('full'), node.path, undefined, { intent: `刷新仓库 ${node.name}` }); } },
			{ title: '抓取', disabled: isRepoBusy(state.busy, node.path, 'network'), onClick: () => { selectNodeAndReset(node); void run('network', async () => { await fetchRepo(node.path, null, settings.fetchAndPrune, settings.fetchAndPruneTags); }, node.path, undefined, { intent: `抓取仓库 ${node.name}` }); } },
			{
				title: '推送', disabled: isRepoBusy(state.busy, node.path, 'network') || branchName === '',
				onClick: () => {
					selectNodeAndReset(node);
					void run('network', async () => {
						await pushCurrentBranch(node.path, hooksState.push && !runHooks);
					}, node.path, undefined, { intent: `推送仓库 ${node.name}` }).finally(() => { setRunHooks(true); });
				},
			},
			{ type: 'divider' },
			{ title: '复制路径', onClick: () => { void copyText(node.path); } },
		];
		if (isUninitializedSubmodule) {
			items.push({ type: 'divider' }, {
				title: '初始化子模块', disabled: isRepoBusy(state.busy, node.path, 'network'),
				onClick: () => {
					void (async () => {
						/*
						 * 以子模块路径为仓库目标：宿主按路径取父仓库并换算相对路径，因此子模块尚未
						 * 检出（目录里没有 `.git`）时也能执行。该命令可能访问远端，按网络影响面记录。
						 */
						selectNodeAndReset(node);
						logClient('I', 'action', `用户操作：初始化子模块 ${node.name}（${node.path}）`);
						setState((previous) => ({ ...previous, busy: addBusy(previous.busy, node.path, 'network'), error: null }));
						try {
							await initSubmodule(node.path, node.path);
						} catch (error) {
							reportError(setState, error instanceof Error ? error.message : String(error));
							return;
						} finally {
							setState((previous) => ({ ...previous, busy: removeBusy(previous.busy, node.path, 'network') }));
						}
						rescan();
					})();
				},
			});
		}
		if (isLinkedWorktree) {
			items.push({ type: 'divider' }, {
				title: '移除工作树…', danger: true, disabled: isRepoBusy(state.busy, workingTreePath, 'history'),
				onClick: () => {
					void (async () => {
						const ok = await showCheckbox({
							title: '移除工作树',
							message: `移除工作树 ${node.path}？\n工作树内有未提交改动时需要强制移除。`,
							checkboxLabel: '强制移除（丢弃工作树内的未提交改动）', danger: true,
						});
						if (!ok) return;
						/*
						 * 直接以该工作树路径为目标执行移除，不经面板的 `run`：被移除的可能正是当前
						 * 选中的工作树，之后对它的 git 调用会因工作目录不存在而 `spawn git ENOENT`。
						 */
						logClient('I', 'action', `用户操作：移除工作树 ${node.name}（${node.path}，强制）`);
						try {
							await removeWorktree(node.path, node.path, true);
						} catch (error) {
							reportError(setState, error instanceof Error ? error.message : String(error));
							return;
						}
						dropGraphWindows(node.path);
						// 该节点已不存在，清掉选中以免刷新后指向失效节点。
						setSelectedId((previous) => (previous === node.id ? null : previous));
						rescan();
					})();
				},
			});
		}
		showContextMenu({
			x: event.clientX, y: event.clientY,
			onClose: () => target.classList.remove(MENU_TARGET_CLASS),
			items,
		});
	}, [selectNodeAndReset, run, refresh, rescan, setState, state.busy, settings, workingTreePath, setSelectedId, hooksState.push, runHooks, pushCurrentBranch]);

	/** 仓库行分支名点击：弹出分支切换菜单。 */
	const handleBranchClick = React.useCallback((node, event) => {
		const branches = new Set<string>();
		for (const commit of state.commits) {
			for (const name of commit.heads ?? []) branches.add(name);
		}
		if (branches.size === 0) return;
		const target = event.currentTarget;
		target.classList.add(MENU_TARGET_CLASS);
		showContextMenu({
			x: event.clientX, y: event.clientY,
			onClose: () => target.classList.remove(MENU_TARGET_CLASS),
			items: [...branches].sort().map((name) => ({
				title: name,
				onClick: () => { selectNodeAndReset(node); void run('history', async () => { throwIfError(await checkoutBranch(node.path, name), checkoutFailureText); }, node.path, undefined, { intent: `检出分支 ${name}` }); },
			})),
		});
	}, [state.commits, selectNodeAndReset, run]);

	/**
	 * 是否可以创建 Pull Request：必须有 GitHub 远程，且当前分支已推送到远程。
	 *
	 * 远程列表只含已配置的远程；分支未推送时 gh 也找不到可比较的 head，因此一并隐藏入口。
	 */
	const canCreatePullRequest = React.useMemo(
		() => hasGitHubRemote(state.remotes) && currentSync !== undefined && currentSync.upstream !== null,
		[state.remotes, currentSync],
	);

	/**
	 * 菜单用的执行入口：把意图转成 `run` 的选项。
	 *
	 * 菜单只关心「影响面 + 操作体 + 意图」，仓库与乐观更新都不由菜单给出。
	 */
	const menuRun = React.useCallback(
		(scope: BusyScope, operation: () => Promise<void>, intent?: string): Promise<void> => run(
			scope, operation, undefined, undefined, intent === undefined ? undefined : { intent },
		),
		[run],
	);

	/** 菜单依赖面；提交菜单与引用菜单共用。 */
	const menuDeps = React.useMemo(() => ({
		workingTreePath, run: menuRun, remotes: state.remotes, handleCreateArchive, head: state.head,
		notify, setCommitMessage: setMessage,
		handleCreatePullRequest, canCreatePullRequest,
		// 被别的工作树检出的分支：照常显示，但检出、删除、重命名与合并目标不可用。
		foreignBranches: state.foreignBranches,
	}), [
		workingTreePath, menuRun, state.remotes, handleCreateArchive, state.head, notify,
		handleCreatePullRequest, canCreatePullRequest, state.foreignBranches,
	]);

	/** 提交行右键菜单。分支候选需向 git 查询，因此异步打开。 */
	const openCommitMenuFor = React.useCallback(({ commit, event }: { commit: Commit; event: React.MouseEvent<HTMLElement> }) => {
		void openCommitMenu(menuDeps, { commit, event, currentHashes: branchHashes });
	}, [menuDeps, branchHashes]);

	/** 引用标记（head / remote / tag / stash）右键菜单；条目按引用类型从同一注册表过滤。 */
	const openRefMenuFor = React.useCallback(({ commit, refInfo, event }: { commit: Commit; refInfo: { type: string; name: string; remote?: string | null }; event: React.MouseEvent<HTMLElement> }) => {
		void openRefMenu(menuDeps, { commit, refInfo, event, currentHashes: branchHashes });
	}, [menuDeps, branchHashes]);

	/** 统一右键入口：有 ref 走 ref 菜单，否则走提交菜单。 */
	const handleContextMenu = React.useCallback(({ commit, refInfo, event }: { commit: Commit; refInfo: RefInfo | null; event: React.MouseEvent<HTMLElement> }) => {
		if (refInfo !== null && refInfo.type !== null && refInfo.name !== null) {
			openRefMenuFor({ commit, refInfo: { type: refInfo.type, name: refInfo.name }, event });
		} else {
			openCommitMenuFor({ commit, event });
		}
	}, [openCommitMenuFor, openRefMenuFor]);

	const dateFmt = React.useCallback((seconds: number) => formatDate(seconds, settings.dateFormat), [settings.dateFormat]);
	// 悬停卡片的括号内始终是详细时间：与主标签同源比较，相同就不重复。
	const dateDetail = React.useCallback(
		(seconds: number) => formatDate(seconds, { type: 0, iso: settings.dateFormat.iso }),
		[settings.dateFormat.iso],
	);
	// Issue 链接配置按设置记忆化：每次渲染新建对象会击穿提交图的属性比较。
	const issueLinking = React.useMemo(() => issueLinkingConfigOf(settings), [settings]);

	/** 刷新选中仓库；更改区与图形区的标题栏共用。 */
	const refreshAll = React.useCallback(() => {
		// 主动刷新同时重读引用清单：外部增删分支或标签后，手选筛选需要重新校验。
		setRefsRevision((previous) => previous + 1);
		void run('read', () => refresh('full'), undefined, undefined, { intent: '主动刷新' });
	}, [run, refresh]);
	/** 追加一个提交窗口。 */
	const loadMoreCommits = React.useCallback(() => {
		void loadMore();
	}, [loadMore]);
	/** 从所有远程抓取。 */
	const fetchAll = React.useCallback(() => {
		void run('network', async () => {
			await fetchRepo(workingTreePath, null, settings.fetchAndPrune, settings.fetchAndPruneTags);
		}, undefined, undefined, { intent: '从所有远程抓取' });
	}, [run, workingTreePath, settings.fetchAndPrune, settings.fetchAndPruneTags]);
	/** 打开设置面板。 */
	const openSettingsPanel = React.useCallback(() => { setSettingsTab('repo'); setSettingsOpen(true); }, []);
	/** 打开设置并直接落在反馈页签。 */
	const openFeedbackPanel = React.useCallback(() => { setSettingsTab('feedback'); setSettingsOpen(true); }, []);
	/** 打开引用筛选弹窗。 */
	const openFilterDialog = React.useCallback(() => { setFilterOpen(true); }, []);

	/** 分叉来源的当前值，供 effect 判断是否已有同名分支的结果。 */
	const branchBaseRef = React.useRef(branchBase);
	branchBaseRef.current = branchBase;
	/*
	 * 自动筛选的分叉来源（VS Code 图形视图的 base 引用）：配置、分支创建来源、默认远程分支。
	 * 只有自动筛选与打开弹窗时需要（弹窗按它排序）；同一仓库同一分支只取一次，分离头指针没有来源。
	 */
	React.useEffect(() => {
		if (workingTreePath === null || state.head === null) { setBranchBase(null); return undefined; }
		if (refFilter.mode !== 'auto' && !filterOpen) return undefined;
		const cached = branchBaseRef.current;
		if (cached !== null && cached.repo === workingTreePath && cached.branch === state.head) return undefined;
		const cancelled = { current: false };
		const repo = workingTreePath;
		const branch = state.head;
		void (async () => {
			try {
				const result = await loadBranchBase(repo);
				if (cancelled.current) return;
				setBranchBase(result.branch === branch ? { repo, branch, base: result.base } : null);
			} catch {
				if (!cancelled.current) setBranchBase(null);
			}
		})();
		return () => { cancelled.current = true; };
	}, [workingTreePath, state.head, refFilter.mode, filterOpen]);

	// 错误以顶部轻量提示呈现，不再占版面：状态变化即弹一条；同时记一条错误日志。
	React.useEffect(() => {
		if (state.error === null) return;
		showToast(state.error);
		logClient('E', 'panel', `面板操作失败${workingTreePath === null ? '' : `，仓库 ${workingTreePath}`}：${state.error}`);
	}, [state.error, workingTreePath]);

	/*
	 * 取数已按筛选在宿主侧完成（引用起点交给 `git log`），这里只整理弹窗要用的引用与勾选态。
	 * 弹窗列出仓库的全部引用，与提交窗口无关。
	 */
	const filterBase = branchBase !== null && branchBase.repo === workingTreePath && branchBase.branch === state.head
		? branchBase.base
		: null;
	const filterContext = React.useMemo<AutoFilterContext>(
		() => ({ head: state.head, headHash: state.headHash, upstream: state.upstream, base: filterBase }),
		[state.head, state.headHash, state.upstream, filterBase],
	);
	const dialogRefs = React.useMemo(() => {
		const items = refItems !== null && refItems.repo === workingTreePath ? refItems.items : [];
		return sortRefs(items, state.head, state.upstream, filterBase);
	}, [refItems, workingTreePath, state.head, state.upstream, filterBase]);
	const checkedIds = React.useMemo(
		() => checkedRefIds(refFilter, dialogRefs, filterContext),
		[refFilter, dialogRefs, filterContext],
	);
	// 标题栏按钮文案即当前模式：模式名，或选中的引用名/数量。只看模式，不按勾选内容反推。
	const filterSummary = React.useMemo(() => filterSummaryOf(refFilter), [refFilter]);

	// 没有工作区：所有 hook 已调用完毕，这里才提前返回，保持 hook 顺序不随加载阶段变化。
	if (state.phase === 'no-workspace') {
		return React.createElement('div', { className: shared.empty }, '该会话没有工作区目录');
	}

	return React.createElement(
		'div',
		{ className: css.root },

		React.createElement(SettingsPanel, {
			open: settingsOpen, onClose: () => { setSettingsOpen(false); }, initialTab: settingsTab,
			cwd: workingTreePath, pluginVersion: PLUGIN_VERSION,
			onOpenFile: openLogFile, onRevealPath,
			settings, onChange: changeSettings, remotes: state.remotes, onDeleteRemote: deleteRemoteByName,
			onAddRemote: handleAddRemote, onEditRemote: handleEditRemote, onExportConfig: handleExportConfig,
			onCheckSsh: handleCheckSsh,
			userDetails, onEditUserDetails: handleEditUserDetails, onDeleteUserDetails: handleDeleteUserDetails,
		}),

		filterOpen && React.createElement(RefFilterDialog, {
			refs: dialogRefs,
			selected: checkedIds, search: filterSearch,
			onSearch: setFilterSearch,
			/*
			 * 勾选一处即转为手选：从当前生效集合出发增删；集合清空时回退自动
			 * （VS Code 的手选没有「空集合」状态）。
			 */
			onToggle: (id: string) => {
				const next = new Set(checkedIds);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				const ids = dialogRefs.filter((ref) => next.has(ref.id)).map((ref) => ref.id);
				patchFilter(ids.length === 0 ? DEFAULT_REF_FILTER : { mode: 'manual', ids });
			},
			onSelectAll: (checked: boolean) => { patchFilter(checked ? { mode: 'all', ids: [] } : DEFAULT_REF_FILTER); },
			// 勾选态一律由模式决定，不看勾选内容反推：模式是唯一事实来源。
			allChecked: refFilter.mode === 'all',
			autoChecked: refFilter.mode === 'auto',
			// 「自动」与「全部」互斥：取消其中一个即落到另一个，不留未选状态。
			onToggleAuto: (checked: boolean) => { patchFilter(checked ? DEFAULT_REF_FILTER : { mode: 'all', ids: [] }); },
			onClose: () => { setFilterOpen(false); },
		}),

		// ── 存储库 ──────────────────────────────────────────────
		React.createElement(RepoSection, {
			open: repoSecOpen, height: repoHeight, busy: busyFlags,
			treeStatus, treeNote, visibleRows, selectedId, expandedIds, syncById, headHash: headCommitHash,
			onToggleSection: toggleRepoSec,
			onOpenSettings: openSettingsPanel,
			onOpenFeedback: openFeedbackPanel,
			onClone: handleClone, cloneBusy,
			onSelect: selectNodeAndReset,
			onToggle: toggleNode,
			onMoreActions: handleRepoMoreActions,
			onBranchClick: handleBranchClick,
			onResizeStart: startRepoResize,
		}),

		// ── 更改 ──────────────────────────────────────────────
		React.createElement(ChangesSection, {
			entries: state.entries, busy: busyFlags, phase: state.phase,
			workingTreePath, head: state.head,
			message, onMessageChange: setMessage, amend, onToggleAmend: toggleAmend, onStash: handleStash,
			// 任一类钩子存在即显示：同一个勾选项同时决定提交与推送是否带 --no-verify。
			hooksActive: hooksState.commit || hooksState.push, runHooks, onToggleRunHooks: setRunHooks,
			showTranslate, translateBusy, onTranslate: handleTranslate,
			aiBusy, aiWarning, aiStats, onAiCommit: handleAiCommit,
			showSyncButton,
			syncBehind: currentSync?.behind ?? 0,
			syncAhead: currentSync?.ahead ?? 0,
			onSync: handleSync,
			showPublishButton, onPublish: handlePublish,
			canSubmit, onSubmit: submit, onRefresh: refreshAll,
			onSyncContextMenu: overwriteChoicesAvailable ? handleSyncContextMenu : undefined,
			collapsedByGroup, groupExpanded, toggleChange, toggleGroup, run,
			stagePaths, unstagePaths, discardPaths: handleDiscardPaths, openDiff,
			onAddToGitignore: handleAddToGitignore, onAddToLocalExclude: handleAddToLocalExclude,
			hasLocalExclude: (localExclude?.entries.length ?? 0) > 0, onShowLocalExclude: handleShowLocalExclude,
			merging: state.merging, onAbortMerge: handleAbortMerge,
			refreshing: backgroundFlags.entries, lastRefresh: lastRefreshText,
		}),

		// ── 图形 ────────────────────────────────────────────────
		React.createElement(GraphSection, {
			open: graphSecOpen, height: graphHeight, busy: busyFlags, phase: state.phase,
			commitCount: state.commits.length, selectedNode, graphScrollRef,
			commits: state.commits,
			head: state.head, selectedHash: state.selectedHash,
			localTip: syncMarkers.localTip, remoteTip: syncMarkers.remoteTip, baseTip: syncMarkers.baseHash,
			upstream: currentSync?.upstream ?? null,
			moreCommitsAvailable: state.more, statsByHash, messageByHash,
			translatedByHash, translatedFromByHash, translatingHash, translateReady, onTranslateCommit: translateCommit,
			onCancelTranslateCommit: cancelTranslateCommit,
			graphTranslated, graphTranslating,
			onTranslateVisible: translateCommits, onCancelTranslate: cancelTranslateCommits,
			detail: state.detail, detailCollapsed: collapsedByGroup.detail, settings,
			onToggleSection: toggleGraphSec,
			onToggleChange: toggleChange,
			onOpenDiff: openDiff,
			onToggleCommit: toggleCommit,
			// 触底追加一个窗口：宿主按 offset 返回下一段，客户端不持有完整历史。
	onLoadMore: loadMoreCommits,
			onContextMenu: handleContextMenu,
			onHoverCommit: hoverCommit,
			onOpenFilter: openFilterDialog,
			filterSummary,
			filterActive: refFilter.mode !== 'all',
			onGoToHead: goToHead,
			onFetch: fetchAll,
			onRefresh: refreshAll,
			onResizeStart: startGraphResize,
			formatDate: dateFmt, formatDetail: dateDetail,
			issueLinking,
			refreshing: backgroundFlags.graph, lastRefresh: lastRefreshText,
		}),
	);
}
