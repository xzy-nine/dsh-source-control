/**
 * Git Graph 面板主体：持有状态与数据加载，把三个分区组装成侧栏页。
 *
 * 布局对齐 VS Code 的「源代码管理 + 图形」视图，控件使用 DSH 的
 * ui-primitives，因此外观与 Harness 本身一致。分区渲染在 ./panel/ 下，
 * 纯计算与 hooks 同样按职责拆分到该目录。
 */
import React from 'react';
import {
	addRemote, checkoutBranch, commitStaged, createArchive, deleteRemote, deleteUserDetails, discardPaths,
	editRemote, editUserDetails, exportRepoConfig, fetchRepo, generateCommitMessage, loadConfig, loadCommitFiles,
	merge, pushStash, pushUpstream, removeWorktree, stagePaths, tagDetails, unstagePaths,
} from './api.ts';
import { copyText, showContextMenu, type ContextMenuItem } from './context-menu.ts';
import { showCheckbox, showForm, showSelect, showText } from './dialog.ts';
import { RefFilterDialog } from './panel/ref-filter-dialog.ts';
import { ChangesSection, GraphSection, RepoSection } from './panel/sections.ts';
import { changeOf } from './panel/changes.ts';
import { reportError } from './panel/errors.ts';
import { computeAheadBehind, computeAutoRefs, collectRefs, currentBranchHashes, filterCommitsByRefs } from './panel/refs.ts';
import { openCommitMenu, openRefMenu } from './panel/commit-menu.ts';
import { loadSession, saveSession } from './panel/storage.ts';
import { useCommitStats } from './panel/use-commit-stats.ts';
import { useGraphData } from './panel/use-graph-data.ts';
import { useRepos } from './panel/use-repos.ts';
import { formatDate, loadSettings, saveSettings, SettingsPanel } from './settings.ts';
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
 * Git Graph 面板。
 *
 * @param props - 见 {@link GitGraphPanelProps}。
 * @returns 面板元素。
 */
export function GitGraphPanel({ cwd, sessionId, onOpenDiff }: GitGraphPanelProps): React.ReactElement {
	const [message, setMessage] = React.useState('');
	const [aiBusy, setAiBusy] = React.useState(false);
	const [aiWarning, setAiWarning] = React.useState('');
	const [aiStats, setAiStats] = React.useState<AiStats | null>(null);
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
	// 分组各自的「已折叠」文件夹集合（默认空＝全部展开）；会话级、不持久化。
	// detail 是图形区内展开块的文件夹集合。
	const [collapsedByGroup, setCollapsedByGroup] = React.useState<{ staged: Set<string>; unstaged: Set<string>; detail: Set<string> }>(
		() => ({ staged: new Set(), unstaged: new Set(), detail: new Set() }),
	);
	const [groupExpanded, setGroupExpanded] = React.useState<{ staged: boolean; unstaged: boolean }>(() => ({ staged: true, unstaged: true }));
	// 存储库、图形两区可收起（默认展开）；会话级持久化。
	const [repoSecOpen, setRepoSecOpen] = React.useState<boolean>(() => loadSession('dsh-git-graph-repo-open', true));
	const [graphSecOpen, setGraphSecOpen] = React.useState<boolean>(() => loadSession('dsh-git-graph-graph-open', true));
	// 图形区高度（像素）；会话级持久化，默认 320。
	const [graphHeight, setGraphHeight] = React.useState<number>(() => loadSession('dsh-git-graph-graph-height', 320));
	// 存储库区高度（像素）；会话级持久化，默认 200。
	const [repoHeight, setRepoHeight] = React.useState<number>(() => loadSession('dsh-git-graph-repo-height', 200));
	const graphScrollRef = React.useRef<HTMLDivElement | null>(null);

	const toggleRepoSec = React.useCallback(() => {
		setRepoSecOpen((previous) => { const next = !previous; saveSession('dsh-git-graph-repo-open', next); return next; });
	}, []);
	const toggleGraphSec = React.useCallback(() => {
		setGraphSecOpen((previous) => { const next = !previous; saveSession('dsh-git-graph-graph-open', next); return next; });
	}, []);
	const commitGraphHeight = React.useCallback((value: number) => {
		const clamped = Math.max(120, Math.min(value, 720));
		setGraphHeight(clamped);
		saveSession('dsh-git-graph-graph-height', clamped);
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
		saveSession('dsh-git-graph-repo-height', clamped);
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

	// 会话级持久化：按仓库/子模块/工作树路径存 sessionStorage，切换页面或工作区后恢复。
	React.useEffect(() => {
		if (workingTreePath === null) return;
		try {
			const saved = sessionStorage.getItem('ggg-commit-msg:' + workingTreePath);
			if (saved !== null) setMessage(saved);
		} catch { /* sessionStorage 不可用 */ }
	}, [workingTreePath]);
	React.useEffect(() => {
		if (workingTreePath === null || aiBusy) return;
		try { sessionStorage.setItem('ggg-commit-msg:' + workingTreePath, message); } catch { /* 忽略写入失败 */ }
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
	 */
	const openDiff = React.useCallback(async (hash: string, path: string, staged: boolean, isNew = false) => {
		const kind = isNew ? 'file' : (hash === '*' ? 'worktree' : 'commit');
		const diff = kind === 'file'
			? { kind, path, repoRoot: workingTreePath }
			: kind === 'worktree'
				? { kind, path, staged, untracked: false, repoRoot: workingTreePath }
				: { kind, hash: hash.slice(0, 8), hashFull: hash, subject: `${hash.slice(0, 7)} ${path}`, path, repoRoot: workingTreePath };
		if (typeof onOpenDiff === 'function') {
			onOpenDiff({ id: `gg-diff:${hash}:${path}:${staged ? 's' : 'u'}`, type: 'diff', title: path.split('/').pop() ?? 'Diff', diff });
		}
	}, [onOpenDiff, workingTreePath]);

	/** 选中一个提交，并加载其改动文件。 */
	const selectCommit = React.useCallback(async (hash: string) => {
		setState((previous) => ({ ...previous, selectedHash: hash, detail: null }));
		if (workingTreePath === null) return;
		try {
			const commit = state.commits.find((item) => item.hash === hash);
			setState((previous) => ({
				...previous,
				detail: commit === undefined ? null : { commit, files: [] },
			}));
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

	/** 点击提交行：展开改动文件；再次点击同一行收起。 */
	const toggleCommit = React.useCallback((hash: string) => {
		if (state.selectedHash === hash) {
			setState((previous) => ({ ...previous, selectedHash: null, detail: null }));
			return;
		}
		void selectCommit(hash);
	}, [state.selectedHash, selectCommit, setState]);

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

	/** 勾选「修补上一次提交」时自动填入上一提交消息；取消勾选时清空。 */
	const toggleAmend = React.useCallback((checked: boolean) => {
		setAmend(checked);
		if (checked) {
			const lastCommit = state.commits.find((commit) => commit.hash !== '*');
			if (lastCommit !== undefined) setMessage(lastCommit.message ?? '');
		} else {
			setMessage('');
		}
	}, [state.commits]);

	/** 提交暂存区。 */
	const submit = (): void => {
		if (state.busy || message.trim() === '' || stagedPaths.length === 0) return;
		void run(async () => {
			await commitStaged(workingTreePath as string, message, amend);
			setMessage('');
			setAmend(false);
		});
	};

	/** AI 生成提交信息：流式输出，不开启思考。 */
	const handleAiCommit = (): void => {
		if (aiBusy) return;
		if (workingTreePath === null) { setAiWarning('未选中仓库'); return; }
		if (aiAbortRef.current !== null) { aiAbortRef.current.abort(); aiAbortRef.current = null; }
		setAiBusy(true);
		setAiWarning('');
		setAiStats(null);
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
		}, amend).finally(() => { setAiBusy(false); aiAbortRef.current = null; }).catch((err: unknown) => setAiWarning(String((err as Error)?.message ?? err)));
	};

	const currentSync = selectedId === null ? undefined : syncById.get(selectedId);
	const aheadBehind = React.useMemo(
		() => computeAheadBehind(state.commits, state.head, currentSync?.upstream ?? null),
		[state.commits, state.head, currentSync],
	);
	const workAreaEmpty = state.entries.length === 0;
	const hasRemoteDiff = currentSync !== undefined && (currentSync.ahead > 0 || currentSync.behind > 0);
	const showSyncButton = workAreaEmpty && hasRemoteDiff;
	const handleSync = (): void => {
		if (state.busy || workingTreePath === null) return;
		void run(async () => {
			await fetchRepo(workingTreePath, null, settings.fetchAndPrune, settings.fetchAndPruneTags);
			if (currentSync !== undefined && currentSync.behind > 0 && currentSync.upstream !== null) {
				await merge(workingTreePath, currentSync.upstream);
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
		void run(async () => { await deleteRemote(workingTreePath as string, name); });
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
			await editUserDetails(workingTreePath as string, name, email, location, deleteLocalName, deleteLocalEmail);
			await reloadUserDetails();
		});
	}, [workingTreePath, run, state.remotes]);

	const handleDeleteUserDetails = React.useCallback((delName: boolean, delEmail: boolean, location: string) => {
		void run(async () => {
			await deleteUserDetails(workingTreePath as string, delName, delEmail, location);
			await reloadUserDetails();
		});
	}, [workingTreePath, run, state.remotes]);

	/** 一般提示：说明当前条件下操作无法进行的原因。 */
	const notify = React.useCallback(async (message: string) => {
		reportError(setState, message);
		setTimeout(() => reportError(setState, null), 2600);
	}, [setState]);

	/** 添加远程并刷新。 */
	const handleAddRemote = React.useCallback((name: string, url: string, pushUrl: string | null) => {
		void run(async () => { await addRemote(workingTreePath as string, name, url, pushUrl, false); });
	}, [workingTreePath, run]);

	/** 编辑远程并刷新。 */
	const handleEditRemote = React.useCallback((nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) => {
		void run(async () => { await editRemote(workingTreePath as string, nameOld, nameNew, urlOld, urlNew, pushUrlOld, pushUrlNew); });
	}, [workingTreePath, run]);

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
			a.download = 'git-graph-config.json';
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
				reportError(setState, '该标签是轻量标签，无附加信息');
				setTimeout(() => reportError(setState, null), 2600);
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
				onClick: () => { selectNodeAndReset(node); void run(async () => { await checkoutBranch(node.path, name); }); },
			})),
		});
	}, [state.commits, selectNodeAndReset, run]);

	/** 菜单依赖面；提交菜单与引用菜单共用。 */
	const menuDeps = React.useMemo(() => ({
		workingTreePath, run, remotes: state.remotes, handleCreateArchive, head: state.head,
		notify, handleTagDetails, setCommitMessage: setMessage,
	}), [workingTreePath, run, state.remotes, handleCreateArchive, state.head, notify, handleTagDetails]);

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

	return React.createElement(
		'div',
		{ className: 'ggg-root' },
		state.error !== null && React.createElement('div', { className: 'ggg-error' }, state.error),

		React.createElement(SettingsPanel, {
			open: settingsOpen, onClose: () => setSettingsOpen(false),
			settings, onChange: changeSettings, remotes: state.remotes, onDeleteRemote: deleteRemoteByName,
			onAddRemote: handleAddRemote, onEditRemote: handleEditRemote, onExportConfig: handleExportConfig,
			userDetails, onEditUserDetails: handleEditUserDetails, onDeleteUserDetails: handleDeleteUserDetails,
		}),

		filterOpen && React.createElement(RefFilterDialog, {
			refs: collectRefs(state.commits),
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
				if (checked) setFilterSelected(() => computeAutoRefs(state.commits, state.head));
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
			aiBusy, aiWarning, aiStats, onAiCommit: handleAiCommit,
			showSyncButton,
			syncBehind: currentSync?.behind ?? 0,
			syncAhead: currentSync?.ahead ?? 0,
			onSync: handleSync,
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
			aheadHashes: aheadBehind.ahead, behindHashes: aheadBehind.behind,
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
