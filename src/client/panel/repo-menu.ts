/**
 * 存储库行的右键菜单：仓库操作与分支切换。
 *
 * 两项都直接组装菜单项与执行体，不持有 React 状态；状态与回调由面板传入。
 */
import { checkoutBranch, fetchRepo, initSubmodule, logClient, removeWorktree, throwIfError } from '../api/index.ts';
import { copyText, showContextMenu, type ContextMenuItem } from '../ui/context-menu.ts';
import { showCheckbox } from '../ui/dialog.ts';
import { addBusy, isRepoBusy, removeBusy } from './busy.ts';
import { checkoutFailureText } from './git-messages.ts';
import { reportError } from './errors.ts';
import { MENU_TARGET_CLASS } from '../css/state-classes.ts';
import { dropGraphWindows } from './graph-window-cache.ts';
import type { Commit, RepoNode, PanelRun, Settings } from '../shared/types.ts';
import type { PanelState } from '../shared/types.ts';

/** 仓库行菜单的依赖面。 */
export interface RepoMenuDeps {
	/** 当前选中的工作树路径。 */
	readonly workingTreePath: string | null;
	/** 面板状态：忙记录与提交列表。 */
	readonly state: PanelState;
	/** 当前设置。 */
	readonly settings: Settings;
	/** 推送钩子是否激活。 */
	readonly pushHookActive: boolean;
	/** 本次是否运行钩子。 */
	readonly runHooks: boolean;
	/** 操作结束复位钩子勾选。 */
	readonly setRunHooks: (next: boolean) => void;
	/** 面板状态写入器。 */
	readonly setState: React.Dispatch<React.SetStateAction<PanelState>>;
	/** 选中一个仓库并重置面板状态。 */
	readonly selectNodeAndReset: (node: RepoNode) => void;
	/** 清掉选中节点。 */
	readonly setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
	/** 执行一次操作并刷新。 */
	readonly run: PanelRun;

	/** 重新加载选中仓库。 */
	readonly refresh: (mode?: 'full' | 'reconcile') => Promise<void>;
	/** 重取仓库树。 */
	readonly rescan: () => void;
	/** 推送某仓库的当前分支到其上游。 */
	readonly pushCurrentBranch: (repoPath?: string, skipHooks?: boolean) => Promise<void>;
}

/**
 * 组装仓库行「更多操作」菜单。
 *
 * 只有链接工作树能被移除：主工作树会被 git 拒绝（`is a main working tree`）。未检出的子模块在
 * 磁盘上没有工作区，需要初始化后才能读取。
 *
 * @param deps - 菜单依赖面。
 * @param node - 目标仓库节点。
 * @param event - 触发事件，取坐标与目标元素。
 * @returns 无。
 */
export function openRepoMenu(deps: RepoMenuDeps, node: RepoNode, event: React.MouseEvent<HTMLElement>): void {
	const { state, settings, run, refresh, rescan, setState, setSelectedId, selectNodeAndReset, pushCurrentBranch } = deps;
	const target = event.currentTarget;
	target.classList.add(MENU_TARGET_CLASS);
	const branchName = node.branch ?? '';
	const isLinkedWorktree = node.kind === 'worktree';
	const isUninitializedSubmodule = node.kind === 'submodule' && !node.available;
	const items: ContextMenuItem[] = [
		{ title: '刷新', onClick: () => { selectNodeAndReset(node); void run('read', () => refresh('full'), node.path, undefined, { intent: `刷新仓库 ${node.name}` }); } },
		{ title: '抓取', disabled: isRepoBusy(state.busy, node.path, 'network'), onClick: () => { selectNodeAndReset(node); void run('network', async () => { await fetchRepo(node.path, null, settings.fetchAndPrune, settings.fetchAndPruneTags); }, node.path, undefined, { intent: `抓取仓库 ${node.name}` }); } },
		{
			title: '推送', disabled: isRepoBusy(state.busy, node.path, 'network') || branchName === '',
			onClick: () => {
				selectNodeAndReset(node);
				void run('network', async () => {
					await pushCurrentBranch(node.path, deps.pushHookActive && !deps.runHooks);
				}, node.path, undefined, { intent: `推送仓库 ${node.name}` }).finally(() => { deps.setRunHooks(true); });
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
			title: '移除工作树…', danger: true, disabled: isRepoBusy(state.busy, deps.workingTreePath, 'history'),
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
		onClose: () => { target.classList.remove(MENU_TARGET_CLASS); },
		items,
	});
}

/**
 * 组装仓库行的分支切换菜单。
 *
 * 分支候选取自已加载的提交列表：仓库行本身不带完整分支列表，只有提交行上的引用标记。
 *
 * @param deps - 菜单依赖面。
 * @param node - 目标仓库节点。
 * @param event - 触发事件，取坐标与目标元素。
 * @returns 无。
 */
export function openRepoBranchMenu(deps: RepoMenuDeps, node: RepoNode, event: React.MouseEvent<HTMLElement>): void {
	const { state, run, selectNodeAndReset } = deps;
	// 分支候选取自当前选中仓库的提交列表，对别的仓库给出的候选是错的。
	if (deps.workingTreePath === null || deps.workingTreePath !== node.path) return;
	const branches = new Set<string>();
	for (const commit of state.commits as readonly Commit[]) {
		for (const name of commit.heads ?? []) branches.add(name);
	}
	if (branches.size === 0) return;
	const target = event.currentTarget;
	target.classList.add(MENU_TARGET_CLASS);
	showContextMenu({
		x: event.clientX, y: event.clientY,
		onClose: () => { target.classList.remove(MENU_TARGET_CLASS); },
		items: [...branches].sort().map((name) => ({
			title: name,
			onClick: () => { selectNodeAndReset(node); void run('history', async () => { throwIfError(await checkoutBranch(node.path, name), checkoutFailureText); }, node.path, undefined, { intent: `检出分支 ${name}` }); },
		})),
	});
}