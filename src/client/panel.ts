/**
 * 源代码管理面板主体：持有状态与数据加载，把三个分区组装成侧栏页。
 *
 * 布局为「源代码管理 + 图形」视图，控件使用 DSH 的
 * ui-primitives，因此外观与 Harness 本身一致。分区渲染在 ./panel/ 下，
 * 纯计算与 hooks 同样按职责拆分到该目录。
 */
import React from 'react';
import {
	addRemote, checkoutBranch, commitStaged, compareCommits, createArchive, deleteRemote, deleteUserDetails, discardPaths,
	editRemote, editUserDetails, exportRepoConfig, fetchRepo, generateCommitMessage, ghAccount, ghCreatePullRequest,
	ghCreateRepo, ghRepoInfo, loadConfig, loadCommitFiles,
	loadCommitMessage,
	merge, pushBranch, pushStash, pushUpstream, removeWorktree, sshStatus, stagePaths, tagDetails, throwIfError, translateAvailable,
	translateText, unstagePaths,
} from './api.ts';
import { copyText, showContextMenu, type ContextMenuItem } from './context-menu.ts';
import { checkoutFailureText } from './panel/git-messages.ts';
import { showCheckbox, showForm, showMessage, showSelect, showTabbedForm, showText, type FormPage } from './dialog.ts';
import { remoteHostOf, toHttpsRemoteUrl, toSshRemoteUrl } from './remote-url.ts';
import { RefFilterDialog } from './panel/ref-filter-dialog.ts';
import { ChangesSection, GraphSection, RepoSection } from './panel/sections.ts';
import { changeOf } from './panel/changes.ts';
import { hasGitHubRemote } from './panel/github.ts';
import { needsTranslation, splitCommitPrefix } from './language.ts';
import { reportError } from './panel/errors.ts';
import { showToast } from './panel/toast.ts';
import { computeSyncMarkers, computeAutoRefs, collectRefs, currentBranchHashes, filterCommitsByRefs, sortRefs } from './panel/refs.ts';
import { openCommitMenu, openRefMenu } from './panel/commit-menu.ts';
import { loadPersistent, loadSession, savePersistent, saveSession } from './panel/storage.ts';
import { useCommitStats } from './panel/use-commit-stats.ts';
import { useGraphData } from './panel/use-graph-data.ts';
import { useRepos } from './panel/use-repos.ts';
import { formatDate, loadSettings, REMOTE_PROTOCOLS, saveSettings, SettingsPanel } from './settings.ts';
import type { AiStats, Commit, CommitFile, RefInfo, Settings } from './types.ts';

/** 面板属性。 */
export interface GitGraphPanelProps {
	/** 会话工作区路径；没有工作区时为 undefined。 */
	readonly cwd?: string | undefined;
	/** 会话 id，用于持久化存储库选中与展开状态。 */
	readonly sessionId: string;
	/** 打开文件差异（打开右侧栏 Diff 页）。 */
	readonly onOpenDiff?: ((target: unknown) => void) | undefined;
}

/** 提交信息中的 Issue 是否开启链接（依赖设置）。 */
function issueLinkingConfigOf(settings: Settings): unknown {
	return settings.issueLinkingConfig ?? null;
}

/**
 * 当前界面语言。
 *
 * DSH 的语言服务把活动语言同步到 `<html lang>`（`zh` 写成 `zh-CN`），因此直接读它；
 * 读取不到时按英文处理。
 *
 * @returns 语言标签，如 `zh-CN`、`en`。
 */
function interfaceLanguage(): string {
	if (typeof document === 'undefined') return 'en';
	const lang = document.documentElement.lang;
	return lang === '' ? 'en' : lang;
}

/**
 * 源代码管理面板。
 *
 * @param props - 见 {@link GitGraphPanelProps}。
 * @returns 面板元素。
 */
export function GitGraphPanel({ cwd, sessionId, onOpenDiff }: GitGraphPanelProps): React.ReactElement {
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
	const [maxCommits, setMaxCommits] = React.useState(200);
	const [settings, setSettings] = React.useState<Settings>(() => loadSettings());
	const [settingsOpen, setSettingsOpen] = React.useState(false);
	const [userDetails, setUserDetails] = React.useState<{ userName?: unknown; userEmail?: unknown } | null>(null);
	const [filterOpen, setFilterOpen] = React.useState(false);
	const [filterSearch, setFilterSearch] = React.useState('');
	const [filterSelected, setFilterSelected] = React.useState<Set<string>>(() => new Set());
	const [filterAuto, setFilterAuto] = React.useState(false);
	// 分组各自的「已折叠」文件夹集合（默认空＝全部展开）；窗口级、不持久化。
	// detail 是图形区内展开块的文件夹集合。
	const [collapsedByGroup, setCollapsedByGroup] = React.useState<{ staged: Set<string>; unstaged: Set<string>; detail: Set<string> }>(
		() => ({ staged: new Set(), unstaged: new Set(), detail: new Set() }),
	);
	const [groupExpanded, setGroupExpanded] = React.useState<{ staged: boolean; unstaged: boolean }>(() => ({ staged: true, unstaged: true }));
	// 存储库、图形两区可收起（默认展开）；跨会话持久化。
	const [repoSecOpen, setRepoSecOpen] = React.useState<boolean>(() => loadPersistent('dsh-source-control-repo-open', true));
	const [graphSecOpen, setGraphSecOpen] = React.useState<boolean>(() => loadPersistent('dsh-source-control-graph-open', true));
	// 图形区高度（像素）；跨会话持久化，默认 320。
	const [graphHeight, setGraphHeight] = React.useState<number>(() => loadPersistent('dsh-source-control-graph-height', 320));
	// 存储库区高度（像素）；跨会话持久化，默认 200。
	const [repoHeight, setRepoHeight] = React.useState<number>(() => loadPersistent('dsh-source-control-repo-height', 200));
	const graphScrollRef = React.useRef<HTMLDivElement | null>(null);

	const toggleRepoSec = React.useCallback(() => {
		setRepoSecOpen((previous) => { const next = !previous; savePersistent('dsh-source-control-repo-open', next); return next; });
	}, []);
	const toggleGraphSec = React.useCallback(() => {
		setGraphSecOpen((previous) => { const next = !previous; savePersistent('dsh-source-control-graph-open', next); return next; });
	}, []);
	const commitGraphHeight = React.useCallback((value: number) => {
		const clamped = Math.max(120, Math.min(value, 720));
		setGraphHeight(clamped);
		savePersistent('dsh-source-control-graph-height', clamped);
	}, []);
	// 拖拽图形区上沿（工作区与图形的分界线）：向上拖＝图形变高。
	const startGraphResize = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = graphHeight;
		const handle = event.currentTarget;
		handle.classList.add('is-dragging');
		const onMove = (moveEvent: PointerEvent): void => {
			commitGraphHeight(startHeight - (moveEvent.clientY - startY));
		};
		const onUp = (): void => {
			handle.classList.remove('is-dragging');
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}, [graphHeight, commitGraphHeight]);

	const commitRepoHeight = React.useCallback((value: number) => {
		const clamped = Math.max(80, Math.min(value, 600));
		setRepoHeight(clamped);
		savePersistent('dsh-source-control-repo-height', clamped);
	}, []);
	// 拖拽存储库区下沿（存储库与更改的分界线）：向下拖＝存储库变高。
	const startRepoResize = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = repoHeight;
		const handle = event.currentTarget;
		handle.classList.add('is-dragging');
		const onMove = (moveEvent: PointerEvent): void => {
			commitRepoHeight(startHeight + (moveEvent.clientY - startY));
		};
		const onUp = (): void => {
			handle.classList.remove('is-dragging');
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}, [repoHeight, commitRepoHeight]);

	const {
		treeStatus, treeNote, selectedId, expandedIds, visibleRows, syncById, selectedNode,
		selectNode, toggleNode, setSyncById, setSelectedId,
	} = useRepos({ cwd, sessionId });

	// 发现结束前不按工作区根加载，避免先加载一次再被选中结果覆盖。
	const workingTreePath = selectedNode !== null
		? selectedNode.path
		: (treeStatus === 'loading' ? null : (cwd ?? null));
	const hasWorkspace = cwd !== undefined && cwd !== null;

	const { state, setState, refresh } = useGraphData({
		workingTreePath, hasWorkspace, maxCommits, settings, selectedId, setSyncById,
	});
	const { statsByHash, messageByHash, hoverCommit } = useCommitStats({ workingTreePath });

	/* 翻译服务是否可用：换仓库时重查一次（同一进程内结果稳定，不必频繁请求）。 */
	React.useEffect(() => {
		if (workingTreePath === null) { setTranslateReady(false); return undefined; }
		let cancelled = false;
		translateAvailable(workingTreePath).then((available) => { if (!cancelled) setTranslateReady(available); });
		return () => { cancelled = true; };
	}, [workingTreePath]);

	// 会话级：按仓库/子模块/工作树路径存草稿，刷新保留、关闭标签页清除。
	React.useEffect(() => {
		if (workingTreePath === null) return;
		const saved = loadSession<string | null>('ggg-commit-msg:' + workingTreePath, null);
		if (saved !== null) setMessage(saved);
	}, [workingTreePath]);
	React.useEffect(() => {
		if (workingTreePath === null || aiBusy) return;
		saveSession('ggg-commit-msg:' + workingTreePath, message);
	}, [workingTreePath, message, aiBusy]);

	/** 选中一个仓库节点并重置面板状态。 */
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

	/** 执行一次工作区操作并刷新。 */
	const run = React.useCallback(async (operation: () => Promise<void>) => {
		if (workingTreePath === null) return;
		setState((previous) => ({ ...previous, busy: true, error: null }));
		try {
			await operation();
			await refresh();
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
		} finally {
			setState((previous) => ({ ...previous, busy: false }));
		}
	}, [workingTreePath, refresh, setState]);

	/**
	 * 在进度条下执行一次不刷新的预备调用。
	 *
	 * 用于弹窗打开前的远端查询（如 gh 账号与分支列表）：这类请求耗时可达数秒，
	 * 若不置 busy，顶部不定进度条不会出现，界面看起来像卡住。失败时返回 null 而不抛错，
	 * 由调用方决定降级路径。
	 *
	 * @param operation - 预备操作。
	 * @returns 操作结果；失败时为 null。
	 */
	const withProgress = React.useCallback(async <T,>(operation: () => Promise<T>): Promise<T | null> => {
		setState((previous) => ({ ...previous, busy: true }));
		try {
			return await operation();
		} catch {
			return null;
		} finally {
			setState((previous) => ({ ...previous, busy: false }));
		}
	}, [setState]);

	/**
	 * 推送某个仓库的当前分支到其上游，失败时报错。
	 *
	 * `pushUpstream` 把失败放在返回值里而不抛错，因此这里显式检查，避免静默失败。
	 * 未配置远程或当前分支没有上游时，git 给出的是多行长文，这里替换为可读提示；
	 * 这两类提示按 git 的实际措辞匹配，措辞变化时退回原文。
	 *
	 * @param repoPath - 目标仓库路径；省略时用当前选中的工作树。
	 */
	const pushCurrentBranch = React.useCallback(async (repoPath?: string) => {
		const error = await pushUpstream(repoPath ?? (workingTreePath as string));
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
	const notify = React.useCallback(async (message: string) => {
		showToast(message);
	}, []);

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
			await run(async () => {
				const error = await pushStash(workingTreePath as string, label, true);
				if (error !== null) throw new Error(error);
			});
		})();
	}, [run, workingTreePath]);

	/** 选中仓库的 HEAD 提交哈希（用于检出提交状态显示）。 */
	const headCommitHash = state.commits.find((commit) => commit.hash !== '*')?.hash ?? null;

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
	const openDiff = React.useCallback(async (hash: string, path: string, staged: boolean, isNew = false, baseHash?: string) => {
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
	}, [onOpenDiff, workingTreePath]);

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
				detail: commit === undefined ? null : { commit, files: [], compareWith },
			}));
			if (baseHash !== undefined) {
				const files = await compareCommits(workingTreePath, baseHash, hash);
				setState((previous) => (previous.selectedHash === hash && previous.detail !== null
					? { ...previous, detail: { ...previous.detail, files } }
					: previous));
				return;
			}
			if (hash === '*') {
				const files: CommitFile[] = state.entries.map((entry) => ({ path: entry.path, type: changeOf(entry).type, additions: null, deletions: null }));
				setState((previous) => (previous.selectedHash === hash && previous.detail !== null
					? { ...previous, detail: { ...previous.detail, files } }
					: previous));
				return;
			}
			const files = await loadCommitFiles(workingTreePath, hash);
			setState((previous) => (previous.selectedHash === hash && previous.detail !== null
				? { ...previous, detail: { ...previous.detail, files } }
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

	/** 转到当前 HEAD 提交：选中并展开其改动文件。 */
	const goToHead = React.useCallback(() => {
		const headCommit = state.commits.find((commit) => commit.hash !== '*' && (commit.heads ?? []).includes(state.head ?? ''));
		const target = headCommit ?? state.commits.find((commit) => commit.hash !== '*');
		if (target === undefined) return;
		const container = graphScrollRef.current;
		if (container === null) return;
		const row = container.querySelector(`[data-hash="${target.hash}"]`);
		if (row !== null) row.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}, [state.commits, state.head]);

	/** 加载仓库后自动滚动到 HEAD。 */
	const didAutoScrollRef = React.useRef(false);
	React.useEffect(() => {
		if (!settings.onRepoLoadScrollToHead) return undefined;
		if (didAutoScrollRef.current) return undefined;
		if (state.phase !== 'ready' || state.commits.length === 0) return undefined;
		didAutoScrollRef.current = true;
		const timer = setTimeout(goToHead, 60);
		return () => clearTimeout(timer);
	}, [settings.onRepoLoadScrollToHead, state.phase, state.commits, goToHead]);
	React.useEffect(() => { didAutoScrollRef.current = false; }, [workingTreePath]);

	const stagedPaths = state.entries.filter((entry) => changeOf(entry).staged).map((entry) => entry.path);

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

	/** 提交暂存区。 */
	const submit = (): void => {
		if (state.busy || message.trim() === '' || stagedPaths.length === 0) return;
		void run(async () => {
			await commitStaged(workingTreePath as string, message, amend);
			setMessage('');
			setAmend(false);
		});
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
		generateCommitMessage(workingTreePath, settings.aiCommitProvider ?? '', settings.aiCommitModel ?? '', settings.aiCommitRules ?? '', {
			signal: controller.signal,
			onChunk: (text) => setMessage((prev) => prev + text),
			onWarning: (text) => setAiWarning(text),
			onError: (text) => setAiWarning(text),
			onStats: (stats) => setAiStats(stats as AiStats),
		// 勾选「修补上一次提交」时，让宿主把上一提交的改动一并纳入 diff。
		}, amend, interfaceLanguage()).finally(() => { setAiBusy(false); aiAbortRef.current = null; }).catch((err: unknown) => setAiWarning(String((err as Error)?.message ?? err)));
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
				const lines = source.split('\n');
				const parts: string[] = [];
				for (const line of lines) {
					if (line.trim() === '') { parts.push(''); continue; }
					// git 惯例前缀不翻译：翻译会破坏 type/scope 的机器可读语义。
					const { prefix, body } = splitCommitPrefix(line);
					parts.push(body.trim() === '' ? line : prefix + await translateText(workingTreePath, body, locale));
				}
				setMessage(parts.join('\n'));
				setTranslatedFrom(source);
			} catch (error) {
				await notify(error instanceof Error ? error.message : String(error));
			} finally {
				setTranslateBusy(false);
			}
		})();
	}, [translateBusy, workingTreePath, message, notify]);

	const currentSync = selectedId === null ? undefined : syncById.get(selectedId);
	const syncMarkers = React.useMemo(
		() => computeSyncMarkers(state.commits, state.head, currentSync?.upstream ?? null),
		[state.commits, state.head, currentSync],
	);
	const workAreaEmpty = state.entries.length === 0;
	const hasRemoteDiff = currentSync !== undefined && (currentSync.ahead > 0 || currentSync.behind > 0);
	const showSyncButton = workAreaEmpty && hasRemoteDiff;
	/**
	 * 当前分支是纯本地分支：有分支、无上游。
	 *
	 * `loadRepoSync` 无上游时 `upstream` 为 null，检出到游离头时 `branch` 为 null。
	 */
	const isUnpublishedBranch = currentSync !== undefined && currentSync.branch !== null && currentSync.upstream === null;
	// 有暂存改动时优先提示提交，提交后再显示发布；无改动且未发布时显示发布。
	const showPublishButton = isUnpublishedBranch && workAreaEmpty && !showSyncButton;

	/**
	 * 是否显示翻译入口。
	 *
	 * 三个条件同时满足才显示：翻译服务已装载（否则点了也失败）、当前无生成任务、
	 * 且内容以非当前语言为主。已翻译过的内容不再重复提示。
	 */
	const showTranslate = translateReady && !aiBusy && !translateBusy
		&& message.trim() !== '' && message !== translatedFrom
		&& needsTranslation(message, interfaceLanguage());

	/**
	 * 读取本地 SSH 状态；结果由宿主按主机缓存，设置面板与发布流程共用这一入口。
	 *
	 * @param host - 目标主机名。
	 * @param refresh - 为 true 时忽略宿主缓存重新探测。
	 * @returns SSH 状态；没有工作区或请求失败时为 null。
	 */
	const handleCheckSsh = React.useCallback(async (host: string, refresh = false) => (
		workingTreePath === null ? null : withProgress(() => sshStatus(workingTreePath, host, refresh))
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
		const account = await withProgress(() => ghAccount(workingTreePath as string));
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

		const pages: [FormPage, ...FormPage[]] = ghReady && account !== null
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
			const name = String(form.name ?? '').trim();
			if (name === '') return null;
			// 个人账号固定为当前登录用户；组织取所选组织。组织为空时退回个人账号。
			const chosenOrg = String(form.owner ?? '').trim();
			const owner = form.accountType === 'org' && chosenOrg !== '' ? chosenOrg : user;
			if (owner === '') return null;
			// 选 SSH 时先确认本机可认证，避免仓库已建好却推送失败。
			if (form.protocol === 'ssh' && !await ensureSshReady('github.com')) return null;
			return {
				kind: 'github',
				owner,
				name,
				private: String(form.visibility ?? 'private') !== 'public',
				description: String(form.description ?? '').trim(),
				protocol: form.protocol === 'ssh' ? 'ssh' : 'https',
			};
		}
		const name = String(form.name ?? '').trim() === '' ? 'origin' : String(form.name ?? '').trim();
		let url = String(form.url ?? '').trim();
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
		if (state.busy || workingTreePath === null || currentSync === undefined || currentSync.branch === null) return;
		const branch = currentSync.branch;
		const path = workingTreePath;
		void (async () => {
			let remote = '';
			if (state.remotes.length === 1) {
				remote = state.remotes[0].name;
			} else if (state.remotes.length > 1) {
				const picked = await showSelect({
					title: '发布到远程仓库',
					message: `把分支 ${branch} 推送到哪个远程仓库？`,
					options: state.remotes.map((item) => ({ value: item.name, label: `${item.name}${item.url !== undefined && item.url !== null && item.url !== '' ? `（${item.url}）` : ''}` })),
				});
				if (picked === null || picked === '') return;
				remote = picked;
			} else {
				const source = await askRemoteSource(branch);
				if (source === null) return;
				if (source.kind === 'github') {
					await run(async () => {
						const url = await ghCreateRepo(path, {
							name: source.name, owner: source.owner, private: source.private, description: source.description,
							protocol: source.protocol,
						});
						await notify(`已发布到 ${url}`);
					});
					return;
				}
				await run(async () => {
					const addError = await addRemote(path, source.name, source.url, null, false);
					if (addError !== null) throw new Error(addError);
					const errors = await pushBranch(path, branch, [source.name]);
					if (errors.length > 0) throw new Error(errors.join('\n'));
				});
				return;
			}
			await run(async () => {
				const errors = await pushBranch(path, branch, [remote]);
				if (errors.length > 0) throw new Error(errors.join('\n'));
			});
		})();
	}, [state.busy, state.remotes, currentSync, workingTreePath, run, askRemoteSource, notify]);

	const handleSync = (): void => {
		if (state.busy || workingTreePath === null) return;
		void run(async () => {
			await fetchRepo(workingTreePath, null, settings.fetchAndPrune, settings.fetchAndPruneTags);
			if (currentSync !== undefined && currentSync.behind > 0 && currentSync.upstream !== null) {
				throwIfError(await merge(workingTreePath, currentSync.upstream), checkoutFailureText);
			}
			if (currentSync !== undefined && currentSync.ahead > 0 && state.head !== null) {
				await pushCurrentBranch();
			}
		});
	};

	/** 写入设置并刷新（排序/显示项变化需要重新拉取提交图）。 */
	const changeSettings = React.useCallback((next: Settings) => {
		setSettings(next);
		saveSettings(next);
	}, []);

	/** 删除远程并刷新。 */
	const deleteRemoteByName = React.useCallback((name: string) => {
		void run(async () => { throwIfError(await deleteRemote(workingTreePath as string, name)); });
	}, [workingTreePath, run]);

	/* 打开设置时加载仓库配置（用户身份等）。 */
	React.useEffect(() => {
		if (!settingsOpen || workingTreePath === null) return;
		void (async () => {
			try {
				const cfg = await loadConfig(workingTreePath, state.remotes.map((remote) => remote.name));
				const user = (cfg?.config as { user?: { name?: unknown; email?: unknown } } | undefined)?.user;
				setUserDetails({ userName: user?.name, userEmail: user?.email });
			} catch { /* 加载失败时保留空表单 */ }
		})();
	}, [settingsOpen, workingTreePath, state.remotes]);

	const reloadUserDetails = async (): Promise<void> => {
		const cfg = await loadConfig(workingTreePath as string, state.remotes.map((remote) => remote.name));
		const user = (cfg?.config as { user?: { name?: unknown; email?: unknown } } | undefined)?.user;
		setUserDetails({ userName: user?.name, userEmail: user?.email });
	};

	const handleEditUserDetails = React.useCallback((name: string, email: string, location: string, deleteLocalName: boolean, deleteLocalEmail: boolean) => {
		void run(async () => {
			const errors = await editUserDetails(workingTreePath as string, name, email, location, deleteLocalName, deleteLocalEmail);
			if (errors.length > 0) throw new Error(errors[0]);
			await reloadUserDetails();
		});
	}, [workingTreePath, run, state.remotes]);

	const handleDeleteUserDetails = React.useCallback((delName: boolean, delEmail: boolean, location: string) => {
		void run(async () => {
			const errors = await deleteUserDetails(workingTreePath as string, delName, delEmail, location);
			if (errors.length > 0) throw new Error(errors[0]);
			await reloadUserDetails();
		});
	}, [workingTreePath, run, state.remotes]);

	/** 添加远程并刷新。 */
	const handleAddRemote = React.useCallback((name: string, url: string, pushUrl: string | null) => {
		void run(async () => { throwIfError(await addRemote(workingTreePath as string, name, url, pushUrl, false)); });
	}, [workingTreePath, run]);

	/** 编辑远程并刷新。 */
	const handleEditRemote = React.useCallback((nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) => {
		void run(async () => { throwIfError(await editRemote(workingTreePath as string, nameOld, nameNew, urlOld, urlNew, pushUrlOld, pushUrlNew)); });
	}, [workingTreePath, run]);

	/**
	 * 创建 Pull Request：选目标分支、填标题与正文，交给 gh 创建。
	 *
	 * 当前分支没有上游时先说明原因；gh 不可用时给出降级提示而不是静默失败。
	 */
	const handleCreatePullRequest = React.useCallback(async () => {
		if (workingTreePath === null || state.head === null || state.busy) return;
		const path = workingTreePath;
		const head = state.head;

		const account = await withProgress(() => ghAccount(path));
		if (account === null || !account.loggedIn) {
			await notify('未检测到可用的 GitHub 登录，请先运行 gh auth login。');
			return;
		}
		const blocked = account.unavailable.find((item) => item.feature === 'create-pr');
		if (blocked !== undefined) {
			await notify(blocked.message);
			return;
		}

		const info = await withProgress(() => ghRepoInfo(path));
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
				{ type: 'text', name: 'body', label: '正文（可选）', placeholder: '' },
				{ type: 'checkbox', name: 'draft', label: '创建为草稿', value: false },
			],
		});
		if (form === null) return;
		const title = String(form.title ?? '').trim();
		if (title === '') return;
		await run(async () => {
			const url = await ghCreatePullRequest(path, {
				head,
				base: String(form.base ?? base),
				title,
				body: String(form.body ?? ''),
				draft: form.draft === true,
			});
			await notify(url === '' ? 'Pull Request 已创建。' : `Pull Request 已创建：${url}`);
		});
	}, [workingTreePath, state.head, state.busy, state.detail, run, notify, withProgress]);

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

	/** 查看标签详情。 */
	const handleTagDetails = React.useCallback(async (tagName: string, commitHash: string) => {
		if (workingTreePath === null) return;
		try {
			const details = await tagDetails(workingTreePath, tagName, commitHash);
			if (details === null) {
				showToast('该标签是轻量标签，无附加信息');
				return;
			}
			const tagMessage = details.message ?? '';
			const tagger = details.tagger ?? '';
			const date = details.date ?? '';
			const lines = [
				`标签：${tagName}`,
				tagger ? `打标签者：${tagger}` : '',
				date ? `日期：${date}` : '',
				tagMessage ? `\n${tagMessage}` : '',
			].filter(Boolean).join('\n');
			await showForm({ title: '标签详情', message: lines, fields: [], confirmLabel: '关闭' });
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, setState]);

	/** 创建归档。 */
	const handleCreateArchive = React.useCallback(async (ref: string, refLabel: string) => {
		const format = await showSelect({
			title: '创建归档',
			message: `从 ${refLabel ?? ref} 创建归档`,
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
		void run(async () => {
			const err = await createArchive(workingTreePath as string, ref, format, outputPath);
			if (err !== null) reportError(setState, err);
		});
	}, [workingTreePath, run, setState]);

	/* ── 右键菜单组装 ─────────────────────────────────────────── */

	/** 仓库行「更多操作」右键菜单。 */
	const handleRepoMoreActions = React.useCallback((node, event) => {
		const target = event.currentTarget;
		target.classList.add('ggg-menu-target');
		const branchName = node.branch ?? '';
		// 只有链接工作树能被移除：主工作树会被 git 拒绝（is a main working tree）。
		const isLinkedWorktree = node.kind === 'worktree';
		const items: ContextMenuItem[] = [
			{ title: '刷新', onClick: () => { selectNodeAndReset(node); void run(() => refresh()); } },
			{ title: '抓取', disabled: state.busy, onClick: () => { selectNodeAndReset(node); void run(async () => { await fetchRepo(node.path, null, settings.fetchAndPrune, settings.fetchAndPruneTags); }); } },
			{ title: '推送', disabled: state.busy || branchName === '', onClick: () => { selectNodeAndReset(node); void run(() => pushCurrentBranch(node.path)); } },
			{ type: 'divider' },
			{ title: '复制路径', onClick: () => { void copyText(node.path); } },
		];
		if (isLinkedWorktree) {
			items.push({ type: 'divider' }, {
				title: '移除工作树…', danger: true, disabled: state.busy,
				onClick: async () => {
					const ok = await showCheckbox({
						title: '移除工作树',
						message: `移除工作树 ${node.path}？\n工作树内有未提交改动时需要强制移除。`,
						checkboxLabel: '强制移除（丢弃工作树内的未提交改动）', danger: true,
					});
					if (!ok) return;
					void run(async () => {
						await removeWorktree(workingTreePath as string, node.path, true);
						// 该节点已不存在，清掉选中以免刷新后指向失效节点。
						setSelectedId((previous) => (previous === node.id ? null : previous));
					});
				},
			});
		}
		showContextMenu({
			x: event.clientX, y: event.clientY,
			onClose: () => target.classList.remove('ggg-menu-target'),
			items,
		});
	}, [selectNodeAndReset, run, refresh, state.busy, settings, workingTreePath, setSelectedId]);

	/** 仓库行分支名点击：弹出分支切换菜单。 */
	const handleBranchClick = React.useCallback((node, event) => {
		const branches = new Set<string>();
		for (const commit of state.commits) {
			for (const name of commit.heads ?? []) branches.add(name);
		}
		if (branches.size === 0) return;
		const target = event.currentTarget;
		target.classList.add('ggg-menu-target');
		showContextMenu({
			x: event.clientX, y: event.clientY,
			onClose: () => target.classList.remove('ggg-menu-target'),
			items: [...branches].sort().map((name) => ({
				title: name,
				onClick: () => { selectNodeAndReset(node); void run(async () => { throwIfError(await checkoutBranch(node.path, name), checkoutFailureText); }); },
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

	/** 菜单依赖面；提交菜单与引用菜单共用。 */
	const menuDeps = React.useMemo(() => ({
		workingTreePath, run, remotes: state.remotes, handleCreateArchive, head: state.head,
		notify, handleTagDetails, setCommitMessage: setMessage,
		handleCreatePullRequest, canCreatePullRequest,
	}), [workingTreePath, run, state.remotes, handleCreateArchive, state.head, notify, handleTagDetails, handleCreatePullRequest, canCreatePullRequest]);

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
		if (refInfo !== null && refInfo !== undefined && refInfo.type !== null && refInfo.name !== null) {
			openRefMenuFor({ commit, refInfo: { type: refInfo.type, name: refInfo.name }, event });
		} else {
			openCommitMenuFor({ commit, event });
		}
	}, [openCommitMenuFor, openRefMenuFor]);

	const dateFmt = React.useCallback((seconds: number) => formatDate(seconds, settings.dateFormat), [settings.dateFormat]);
	// 悬停卡片的括号内始终是详细时间：与主标签同源比较，相同就不重复。
	const dateDetail = React.useCallback(
		(seconds: number) => formatDate(seconds, { type: 0, iso: settings.dateFormat.iso === true }),
		[settings.dateFormat.iso],
	);
	const issueLinking = React.useCallback(() => issueLinkingConfigOf(settings), [settings]);

	if (state.phase === 'no-workspace') {
		return React.createElement('div', { className: 'ggg-empty' }, '该会话没有工作区目录');
	}

	// 错误以顶部轻量提示呈现，不再占版面：状态变化即弹一条。
	React.useEffect(() => {
		if (state.error !== null) showToast(state.error);
	}, [state.error]);

	return React.createElement(
		'div',
		{ className: 'ggg-root' },

		React.createElement(SettingsPanel, {
			open: settingsOpen, onClose: () => setSettingsOpen(false),
			settings, onChange: changeSettings, remotes: state.remotes, onDeleteRemote: deleteRemoteByName,
			onAddRemote: handleAddRemote, onEditRemote: handleEditRemote, onExportConfig: handleExportConfig,
			onCheckSsh: handleCheckSsh,
			userDetails, onEditUserDetails: handleEditUserDetails, onDeleteUserDetails: handleDeleteUserDetails,
		}),

		filterOpen && React.createElement(RefFilterDialog, {
			refs: sortRefs(collectRefs(state.commits), state.head, currentSync?.upstream ?? null),
			selected: filterSelected, search: filterSearch,
			onSearch: setFilterSearch,
			onToggle: (name: string) => { setFilterAuto(false); setFilterSelected((previous) => {
				const next = new Set(previous);
				if (next.has(name)) next.delete(name);
				else next.add(name);
				return next;
			}); },
			onSelectAll: (checked: boolean) => { setFilterAuto(false); setFilterSelected(() => {
				if (!checked) return new Set();
				return new Set(collectRefs(state.commits).map((ref) => ref.name));
			}); },
			autoChecked: filterAuto,
			onToggleAuto: (checked: boolean) => {
				setFilterAuto(checked);
				if (checked) setFilterSelected(() => computeAutoRefs(state.commits, state.head, currentSync?.upstream ?? null));
				else setFilterSelected(new Set());
			},
			onClose: () => setFilterOpen(false),
		}),

		// ── 存储库 ──────────────────────────────────────────────
		React.createElement(RepoSection, {
			open: repoSecOpen, height: repoHeight, busy: state.busy,
			treeStatus, treeNote, visibleRows, selectedId, expandedIds, syncById, headHash: headCommitHash,
			onToggleSection: toggleRepoSec,
			onOpenSettings: () => setSettingsOpen(true),
			onSelect: selectNodeAndReset,
			onToggle: toggleNode,
			onMoreActions: handleRepoMoreActions,
			onBranchClick: handleBranchClick,
			onResizeStart: startRepoResize,
		}),

		// ── 更改 ──────────────────────────────────────────────
		React.createElement(ChangesSection, {
			entries: state.entries, busy: state.busy, phase: state.phase,
			workingTreePath, head: state.head,
			message, onMessageChange: setMessage, amend, onToggleAmend: toggleAmend, onStash: handleStash,
			showTranslate, translateBusy, onTranslate: handleTranslate,
			aiBusy, aiWarning, aiStats, onAiCommit: handleAiCommit,
			showSyncButton,
			syncBehind: currentSync?.behind ?? 0,
			syncAhead: currentSync?.ahead ?? 0,
			onSync: handleSync,
			showPublishButton, onPublish: handlePublish,
			stagedPaths, onSubmit: submit, onRefresh: () => { void run(() => refresh()); },
			collapsedByGroup, groupExpanded, toggleChange, toggleGroup, run,
			stagePaths, unstagePaths, discardPaths, openDiff,
		}),

		// ── 图形 ────────────────────────────────────────────────
		React.createElement(GraphSection, {
			open: graphSecOpen, height: graphHeight, busy: state.busy, phase: state.phase,
			commitCount: state.commits.length, selectedNode, graphScrollRef,
			commits: filterCommitsByRefs(state.commits, filterSelected),
			head: state.head, selectedHash: state.selectedHash,
			localTip: syncMarkers.localTip, remoteTip: syncMarkers.remoteTip,
			upstream: currentSync?.upstream ?? null,
			moreCommitsAvailable: state.more, statsByHash, messageByHash,
			detail: state.detail, detailCollapsed: collapsedByGroup.detail, settings,
			onToggleSection: toggleGraphSec,
			onToggleChange: toggleChange,
			onOpenDiff: openDiff,
			onToggleCommit: toggleCommit,
			onLoadMore: () => setMaxCommits((previous) => previous + 200),
			onContextMenu: handleContextMenu,
			onHoverCommit: hoverCommit,
			onOpenFilter: () => setFilterOpen(true),
			onGoToHead: goToHead,
			onFetch: () => { void run(async () => { await fetchRepo(workingTreePath, null, settings.fetchAndPrune, settings.fetchAndPruneTags); }); },
			onRefresh: () => { void run(() => refresh()); },
			onResizeStart: startGraphResize,
			formatDate: dateFmt, formatDetail: dateDetail,
			issueLinking: issueLinking(),
		}),
	);
}
