/**
 * 提交详情与选择：打开差异、选中提交、对比两个提交、滚动到 HEAD。
 *
 * 这里只处理「选中哪个提交、它的改动是什么」与打开差异的地址换算；提交图的取数由
 * use-graph-data 负责。
 */
import React from 'react';
import { compareCommits, loadCommitFiles } from '../api/index.ts';
import { ROW_HEIGHT } from '../graph/lanes.ts';
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
	/** 图形区的滚动容器。 */
	readonly graphScrollRef: React.RefObject<HTMLDivElement | null>;
	/** 打开差异页。 */
	readonly onOpenDiff?: ((target: unknown) => void) | undefined;
	/** 是否在加载仓库后自动滚动到 HEAD。 */
	readonly scrollToHeadOnLoad: boolean;
}

/** 提交选择与详情。 */
export interface CommitSelection {
	/** 打开某个提交或工作区文件的差异。 */
	readonly openDiff: (hash: string, path: string, staged: boolean, isNew?: boolean, baseHash?: string) => Promise<void>;
	/** 打开一个日志文件。 */
	readonly openLogFile: (path: string) => void;
	/** 选中一个提交并加载其改动。 */
	readonly selectCommit: (hash: string, baseHash?: string) => Promise<void>;
	/** 点击提交行。 */
	readonly toggleCommit: (hash: string, additive?: boolean) => void;
	/** 转到 HEAD 提交所在行。 */
	readonly goToHead: () => void;
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
	const { workingTreePath, state, setState, graphScrollRef, onOpenDiff, scrollToHeadOnLoad } = deps;

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
	}, [state.commits, state.head, graphScrollRef]);

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

	return { openDiff, openLogFile, selectCommit, toggleCommit, goToHead, headCommitHash };
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
