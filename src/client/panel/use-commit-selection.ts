/**
 * 提交详情与选择：打开差异、选中提交、对比两个提交、滚动到 HEAD。
 *
 * 这里只处理「选中哪个提交、它的改动是什么」与打开差异的地址换算；提交图的取数由
 * use-graph-data 负责。
 */
import React from 'react';
import { compareCommits, loadCommitFiles } from '../api/index.ts';
import type { ScrollToRowRequest } from '../graph/use-graph-windowing.ts';
import { headTargetOf, jumpStepOf } from './graph-target.ts';
import { changeOf } from './changes.ts';
import { reportError } from './errors.ts';
import type { Commit, CommitFile, PanelState } from '../shared/types.ts';

/** 提交选择与详情的依赖面。 */
export interface CommitSelectionDeps {
	/** 当前选中的工作树路径。 */
	readonly workingTreePath: string | null;
	/** 面板状态：提交列表、选中项与详情。 */
	readonly state: PanelState;
	/** 面板状态写入器。 */
	readonly setState: React.Dispatch<React.SetStateAction<PanelState>>;
	/** 打开差异页。 */
	readonly onOpenDiff?: ((target: unknown) => void) | undefined;
	/** 是否在加载仓库后自动滚动到 HEAD。 */
	readonly scrollToHeadOnLoad: boolean;
	/** 追加下一页提交；定位尚未加载的目标时据它补齐。 */
	readonly loadMore: () => Promise<void>;
}

/** 提交选择与详情。 */
export interface CommitSelection {
	/** 打开某个提交或工作区文件的差异。 */
	readonly openDiff: (hash: string, path: string, staged: boolean, isNew?: boolean, baseHash?: string, files?: readonly string[]) => Promise<void>;
	/** 打开一个日志文件。 */
	readonly openLogFile: (path: string) => void;
	/** 选中一个提交并加载其改动。 */
	readonly selectCommit: (hash: string, baseHash?: string) => Promise<void>;
	/** 点击提交行。 */
	readonly toggleCommit: (hash: string, additive?: boolean) => void;
	/** 转到 HEAD 提交所在行；目标尚未加载时先补齐提交窗口。 */
	readonly goToHead: () => void;
	/** 提交图的定位请求；无待执行请求时为 null。 */
	readonly scrollTo: ScrollToRowRequest | null;
	/** 选中仓库的 HEAD 提交哈希。 */
	readonly headCommitHash: string | null;
}

/**
 * 维护提交选择与详情。
 *
 * @param deps - 见 {@link CommitSelectionDeps}。
 * @returns 提交选择与详情。
 */
export function useCommitSelection(deps: CommitSelectionDeps): CommitSelection {
	const { workingTreePath, state, setState, onOpenDiff, scrollToHeadOnLoad, loadMore } = deps;

	/** 当前状态的引用：定位在回调里读最新值，不必让它随每次渲染重建。 */
	const stateRef = React.useRef(state);
	stateRef.current = state;

	/** 选中仓库的 HEAD 提交哈希；查找是 O(提交数)，随滚动逐帧重渲染时须记忆化。 */
	const headCommitHash = React.useMemo(
		() => state.commits.find((commit) => commit.hash !== '*')?.hash ?? null,
		[state.commits],
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
	 * @returns 无。
	 */
	const openDiff = React.useCallback((hash: string, path: string, staged: boolean, isNew = false, baseHash?: string, files?: readonly string[]): Promise<void> => {
		const kind = isNew ? 'file' : (hash === '*' ? 'worktree' : 'commit');
		// 地址只带作用域：同一作用域下的文件共用一个页，切换文件走导航参数。
		const diff = kind === 'file'
			? { kind, path, repoRoot: workingTreePath }
			: kind === 'worktree'
				? { kind, path, staged, untracked: false, repoRoot: workingTreePath, files: files ?? [] }
				: { kind, hash: hash.slice(0, 8), hashFull: hash, subject: `${hash.slice(0, 7)} ${path}`, path, repoRoot: workingTreePath, baseHash: baseHash ?? null, files: files ?? [] };
		if (typeof onOpenDiff === 'function') {
			// 对比时 id 带上旧侧哈希：同一作用域的不同对比组合各自成页。
			onOpenDiff({ id: `gg-diff:${baseHash ?? ''}:${hash}:${staged ? 's' : 'u'}`, type: 'diff', title: path.split('/').pop() ?? 'Diff', diff });
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
	 * @returns 无。
	 */
	const selectCommit = React.useCallback(async (hash: string, baseHash?: string) => {
		setState((previous) => ({ ...previous, selectedHash: hash, detail: null }));
		if (workingTreePath === null) return;
		try {
			const commit = state.commits.find((item) => item.hash === hash);
			const compareWith = baseHash === undefined ? null : state.commits.find((item) => item.hash === baseHash) ?? null;
			setState((previous) => ({
				...previous,
				detail: commit === undefined ? null : { commit, files: [], compareWith, loading: true, truncated: false },
			}));
			if (baseHash !== undefined) {
				const { files, truncated } = await compareCommits(workingTreePath, baseHash, hash);
				setState((previous) => (previous.selectedHash === hash && previous.detail !== null
					? { ...previous, detail: { ...previous.detail, files, loading: false, truncated } }
					: previous));
				return;
			}
			if (hash === '*') {
				const files: CommitFile[] = state.entries.map((entry) => ({ path: entry.path, type: changeOf(entry).type, additions: null, deletions: null }));
				// 工作区条目已在宿主侧按上限截断：详情列表同样只是前一部分。
				setState((previous) => (previous.selectedHash === hash && previous.detail !== null
					? { ...previous, detail: { ...previous.detail, files, loading: false, truncated: state.entriesTruncated } }
					: previous));
				return;
			}
			const { files, truncated } = await loadCommitFiles(workingTreePath, hash);
			setState((previous) => (previous.selectedHash === hash && previous.detail !== null
				? { ...previous, detail: { ...previous.detail, files, loading: false, truncated } }
				: previous));
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, state.commits, state.entries, state.entriesTruncated, setState]);

	/**
	 * 点击提交行。
	 *
	 * 已有展开项时按住 Ctrl/Cmd 点击其他提交进入对比：方向取列表中靠后的（较旧）为 `from`，
	 * 靠前的（较新）为 `to`，与改动方向一致。再次点击同一对组合取消对比。
	 *
	 * @param hash - 被点击的提交哈希。
	 * @param additive - 是否按住了 Ctrl/Cmd。
	 * @returns 无。
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

	/** 待定位的目标提交哈希；null 表示没有进行中的定位。 */
	const pendingRef = React.useRef<string | null>(null);
	/** 已为其发出翻页请求的提交列表：同一份列表上不重复取同一页。 */
	const pagedForRef = React.useRef<readonly Commit[] | null>(null);
	/** 定位请求；提交图按它滚动到目标行。 */
	const [scrollTo, setScrollTo] = React.useState<ScrollToRowRequest | null>(null);
	/** 请求计数：同一目标重复定位靠它再触发一次。 */
	const [jumpTick, setJumpTick] = React.useState(0);
	const loadMoreRef = React.useRef(loadMore);
	loadMoreRef.current = loadMore;

	/**
	 * 转到当前 HEAD 提交。
	 *
	 * 只定出目标并推动一轮定位：目标可能在已加载窗口之外（当前分支落后于上游时，HEAD 之前排着
	 * 几百条别的分支的提交），那时先补齐提交窗口，加载到之后再交给提交图滚动。
	 */
	const goToHead = React.useCallback(() => {
		pendingRef.current = headTargetOf(stateRef.current.commits, stateRef.current.head, stateRef.current.headHash);
		// 新一轮定位允许再取一页：上一次取数失败或中断时，同一份列表上不该永远停在「等这一页」。
		pagedForRef.current = null;
		setJumpTick((previous) => previous + 1);
	}, []);

	/**
	 * 推进定位。
	 *
	 * 目标已加载就发出滚动请求（行下标由提交图按它自己的行布局算：虚拟指示行与未提交行都插在
	 * 列表里，提交下标不等于行下标）；尚未加载且还有更早的提交可取就先取下一页，一页一回，
	 * 取回后由提交列表变化推进下一页；取完仍没有该提交（当前筛选不含它）则放弃。
	 */
	React.useEffect(() => {
		const target = pendingRef.current;
		if (target === null) return;
		const step = jumpStepOf(target, state.commits, state.more, pagedForRef.current === state.commits);
		if (step === 'scroll') {
			pendingRef.current = null;
			setScrollTo((previous) => ({ hash: target, serial: (previous?.serial ?? 0) + 1 }));
			return;
		}
		if (step === 'page') {
			// 记下「已为这份列表取过」：取回前列表不变，effect 因别的状态重跑时不该再发一次。
			pagedForRef.current = state.commits;
			void loadMoreRef.current();
			return;
		}
		if (step === 'stop') pendingRef.current = null;
	}, [state.commits, state.more, jumpTick]);

	/** 换仓库时丢弃上一次的定位：目标哈希与已取页都只对上一个仓库成立。 */
	React.useEffect(() => {
		pendingRef.current = null;
		pagedForRef.current = null;
	}, [workingTreePath]);

	/** 加载仓库后自动滚动到 HEAD。 */
	const didAutoScrollRef = React.useRef(false);
	React.useEffect(() => {
		if (!scrollToHeadOnLoad) return undefined;
		if (didAutoScrollRef.current) return undefined;
		if (state.phase !== 'ready' || state.commits.length === 0) return undefined;
		didAutoScrollRef.current = true;
		const timer = setTimeout(goToHead, 60);
		return () => { clearTimeout(timer); };
	}, [scrollToHeadOnLoad, state.phase, state.commits, goToHead]);
	React.useEffect(() => { didAutoScrollRef.current = false; }, [workingTreePath]);

	return { openDiff, openLogFile, selectCommit, toggleCommit, goToHead, scrollTo, headCommitHash };
}

/**
 * 当前分支可达的提交哈希集合；重置这类改写当前分支的操作据此显示。
 *
 * @param commits - 提交列表。
 * @param head - 当前分支名。
 * @returns 可达提交哈希集合。
 */
export function useBranchHashes(commits: readonly Commit[], head: string | null): ReadonlySet<string> {
	return React.useMemo(() => currentBranchHashesOf(commits, head), [commits, head]);
}

/** 见 {@link useBranchHashes}；抽成模块级函数便于两处共用。 */
function currentBranchHashesOf(commits: readonly Commit[], head: string | null): ReadonlySet<string> {
	return new Set(commits.filter((commit) => commit.hash !== '*' && (commit.heads ?? []).includes(head ?? '')).map((commit) => commit.hash));
}