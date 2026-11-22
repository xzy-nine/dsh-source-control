/**
 * 仓库结构监视：观察 git 目录里的工作树登记、子模块目录、工作区的子模块声明，以及工作区里
 * 仓库目录的出现与消失。
 */
import { basename, dirname, join, resolve } from 'node:path';
import { errorText } from '../shared/error-text.js';
import { nodeId, shouldPruneDirectory } from './repo-node.js';
import { listDirAt, probePathAt, readTextAt, watchDirAt, type DirChangeListener } from './host-runtime.js';
import { parseSubmodulePaths, submodulePathsWithin } from './submodule-parse.js';
import { gitDirAt, resolveGitCommonDir } from './worktree-branches.js';
import { logDebug, logInfo, logWarn } from './logger.js';
import { createListenerSet, subscribeIn } from '../shared/listener-set.js';

/** 一次结构变化的合并窗口（毫秒）：创建工作树会连续产生多次目录事件。 */
const COALESCE_MS = 250;

/** 工作区级监视的事件合并窗口（毫秒）：目录树的一次改动会连续产生多次事件。 */
const WORKSPACE_COALESCE_MS = 400;

/** 监视句柄出错后重新同步的延迟（毫秒）。 */
const REARM_MS = 1000;

/** 同时监视的仓库数上限；超出按登记顺序淘汰最早的。 */
const MAX_WATCHED_REPOS = 32;

/** 同时监视的工作区数上限；超出按登记顺序淘汰最早的。 */
const MAX_WATCHED_WORKSPACES = 8;

/** 工作区级事件下探的层数：新建目录后在其内部初始化的仓库要能被发现。 */
const PROBE_DEPTH = 2;

/** 一个监视目标：目录与触发结构变化的名字。 */
export interface WatchTarget {
	/** 被监视的目录。 */
	readonly directory: string;
	/** 触发结构变化的名字；空数组表示该目录下任意变化都触发。 */
	readonly names: readonly string[];
}

/** 结构变化订阅者。 */
const listeners = createListenerSet<(repo: string) => void>();

/** 一个已挂的目录监视：关闭函数。 */
type WatchCloser = () => Promise<void>;

/** git 公共目录（规范化） -> 目录 -> 监视句柄。 */
const handles = new Map<string, Map<string, WatchCloser>>();

/** git 公共目录（规范化） -> 该套句柄对应的仓库路径。 */
const repoOfCommon = new Map<string, string>();

/** git 公共目录（规范化） -> 该公共目录的真实路径。 */
const commonDirOf = new Map<string, string>();

/** git 公共目录（规范化） -> 合并定时器。 */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** 正在同步监视的公共目录。 */
const syncing = new Set<string>();

/** 正在核对结构状态的公共目录。 */
const confirming = new Set<string>();

/** git 公共目录（规范化） -> 上次核对到的结构状态。 */
const lastState = new Map<string, string>();

/** 工作区根（规范化） -> 监视状态。 */
const workspaces = new Map<string, WorkspaceWatch>();

/** 已知仓库路径标识；用于判定一次消失是否是仓库目录被整体删除。 */
const knownRepos = new Set<string>();

/** 工作区根（规范化） -> 上次核对到的仓库集合快照。 */
const lastWorkspaceRepos = new Map<string, string>();

/** 工作区根（规范化） -> 子目录句柄的补挂定时器。 */
const childSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 一个工作区的级监视状态。 */
interface WorkspaceWatch {
	/** 工作区根路径，保持登记时的写法。 */
	root: string;
	/** 根目录的句柄；挂载完成前为 null。 */
	handle: WatchCloser | null;
	children: Map<string, WatchCloser>;
	/** 合并定时器。 */
	timer: ReturnType<typeof setTimeout> | null;
}

/** 工作区根（规范化） -> 挂载取消信号。 */
const workspaceSignals = new Map<string, AbortController>();

/**
 * 订阅仓库结构变化。
 *
 * @param listener - 结构变化时调用，参数为仓库路径。
 * @returns 取消订阅。
 */
export function onRepositoryTreeChange(listener: (repo: string) => void): () => void {
	return subscribeIn(listeners, listener);
}

/**
 * 读取一个仓库在 `.gitmodules` 里声明的子模块目录。
 *
 * @param repo - 仓库根。
 * @returns 子模块目录的绝对路径；没有 `.gitmodules` 时为 null。
 */
async function declaredSubmodules(repo: string): Promise<string[] | null> {
	try {
		return submodulePathsWithin(repo, parseSubmodulePaths(await readTextAt(join(repo, '.gitmodules'))))
			.map((relative) => resolve(repo, relative));
	} catch {
		return null;
	}
}

/**
 * 取一个仓库需要监视的目标。
 *
 * @param repo - 仓库根或工作树根路径。
 * @param commonDir - 该仓库的 git 公共目录。
 * @param submodules - 子模块目录的绝对路径；null 表示没有 `.gitmodules`。
 * @returns 监视目标列表。
 */
export function structureWatchTargets(repo: string, commonDir: string, submodules: readonly string[] | null = null): WatchTarget[] {
	const targets: WatchTarget[] = [
		{ directory: commonDir, names: ['worktrees', 'modules'] },
		{ directory: repo, names: ['.gitmodules'] },
	];
	for (const submodule of submodules ?? []) {
		targets.push({ directory: dirname(submodule), names: [basename(submodule)] });
	}
	return targets;
}

/**
 * 判定一次目录事件是否属于结构变化。
 *
 * 名字缺失时返回 true 表示「无法据此判断」，由调用方核对结构状态后决定：Windows 上普通
 * `git status` 也会在公共目录产生一条不带名字的 `change`，直接当作结构变化会让面板反复重扫。
 *
 * @param target - 监视目标。
 * @param filename - 事件给出的名字；无法给出时为 null。
 * @returns 该事件可能属于结构变化时为 true。
 */
export function isStructureChange(target: WatchTarget, filename: string | null): boolean {
	if (target.names.length === 0) return true;
	if (filename === null) return true;
	return target.names.includes(filename);
}

/**
 * 取一次结构状态的快照，用于判定「结构是否真的变了」。
 *
 * 只读文件系统，不起 git。名字缺失的事件据此核对：状态未变即为普通 git 操作产生的噪声事件，
 * 不通知。
 *
 * @param targets - 监视目标。
 * @returns 可比较的文本快照。
 */
async function structureState(targets: readonly WatchTarget[]): Promise<string> {
	const parts = await Promise.all(targets.map(async (target) => {
		const names: string[] = target.names.length === 0
			? [await childNames(target.directory)]
			: await Promise.all(target.names.map(async (name) => `${name}:${await childNames(join(target.directory, name))}`));
		return `${target.directory}|${names.join('|')}`;
	}));
	return parts.join('\n');
}

/**
 * 列出一个路径的结构形态。
 *
 * @param path - 文件或目录路径。
 * @returns 目录为排序后的子项名，文件为 `file`，不存在为 `absent`。
 */
async function childNames(path: string): Promise<string> {
	const kind = await probePathAt(path);
	if (kind === null) return 'absent';
	if (kind !== 'directory') return 'file';
	try {
		return (await listDirAt(path)).map((entry) => entry.name).sort().join(',');
	} catch {
		return 'absent';
	}
}

/**
 * 取一个工作区的监视状态。
 *
 * 工作区可能在异步调用期间被关闭，因此每个用到它的入口都要重新取一次。
 *
 * @param key - 规范化后的工作区根。
 * @returns 监视状态；该工作区已不在监视时为 null。
 */
function workspaceOf(key: string): WorkspaceWatch | null {
	return workspaces.get(key) ?? null;
}

/**
 * 关闭一个句柄，忽略关闭时的失败。
 *
 * 句柄可能已被对端关闭，关闭失败不代表监视出问题；多处收尾都按这一口径处理。
 *
 * @param close - 关闭函数。
 * @returns 无。
 */
function closeQuietly(close: WatchCloser): void {
	closeQuietly(close);
}

/**
 * 关闭一个公共目录的全部监视句柄。
 *
 * @param key - 规范化后的公共目录。
 * @returns 无。
 */
function closeHandles(key: string): void {
	const existing = handles.get(key);
	handles.delete(key);
	repoOfCommon.delete(key);
	commonDirOf.delete(key);
	lastState.delete(key);
	if (existing === undefined) return;
	for (const close of existing.values()) closeQuietly(close);
}

/**
 * 在一个监视目标上挂载句柄。
 *
 * 名字命中监视目标时直接报告；名字缺失时先核对结构状态，状态未变则不报告。Windows 上普通
 * `git status` 会在公共目录产生一条不带名字的 `change`，直接当结构变化会让面板反复重扫。
 *
 * @param key - 规范化后的公共目录。
 * @param target - 监视目标。
 * @returns 句柄；目录不存在或无法监视时为 null。
 */
function watchTarget(key: string, target: WatchTarget): WatchCloser | null {
	const onChange: DirChangeListener = (error, name) => {
		if (error !== undefined) {
			logWarn('watcher', `监视句柄报错，${String(REARM_MS)} ms 后重挂：${target.directory}：${error.message}`);
			void handles.get(key)?.get(target.directory)?.().catch(() => { /* 句柄已关闭 */ });
			handles.get(key)?.delete(target.directory);
			const timer = setTimeout(() => { sync(key); }, REARM_MS);
			if (typeof timer.unref === 'function') timer.unref();
			return;
		}
		if (name !== null && name !== undefined) {
			if (!isStructureChange(target, name)) return;
			schedule(key);
			return;
		}
		void confirmStructure(key).then((changed) => {
			if (changed) schedule(key);
		}).catch(() => {
			/* 核对失败按结构变化处理，由接收方重新枚举 */
			schedule(key);
		});
	};
	/*
	 * 句柄在异步挂载完成后才可用：挂载期间发生的事件由紧随其后的 sync 与结构核对覆盖。
	 */
	const controller = new AbortController();
	let closer: WatchCloser | null = null;
	const pending = watchDirAt(target.directory, onChange, controller.signal).then((close) => {
		closer = close;
		return close;
	}).catch((error: unknown) => {
		// 目录尚不存在：由上级目录的事件触发补挂。
		logDebug('watcher', `暂时无法监视，等待上级目录事件后再挂：${target.directory}：${errorText(error)}`);
		return null;
	});
	void pending;
	return async () => {
		controller.abort();
		if (closer !== null) await closer();
	};
}

/**
 * 核对一个仓库的结构是否与上次记录不同。
 *
 * 只读文件系统。建立基线发生在挂句柄之前（见 `sync`），因此正常路径上总有记录可比；
 * 记录缺失时按变化处理，不能断定结构未变。核对与同步共用同一把锁，避免并发核对互相覆盖记录。
 *
 * @param key - 规范化后的公共目录。
 * @returns 结构已变时为 true。
 */
async function confirmStructure(key: string): Promise<boolean> {
	if (confirming.has(key)) return false;
	const repo = repoOfCommon.get(key);
	if (repo === undefined) return false;
	confirming.add(key);
	try {
		const commonDir = commonDirOf.get(key) ?? key;
		const state = await structureState(structureWatchTargets(repo, commonDir, await declaredSubmodules(repo)));
		const previous = lastState.get(key);
		lastState.set(key, state);
		return previous === undefined || previous !== state;
	} finally {
		confirming.delete(key);
	}
}

/**
 * 按仓库当前的形态补挂缺失的监视目录、摘掉已消失的目录。
 *
 * 已有句柄保持不动：整体重建会关闭并重开句柄，重建窗口内的事件因此丢失。
 *
 * @param key - 规范化后的公共目录。
 * @returns 无。
 */
function sync(key: string): void {
	if (syncing.has(key)) return;
	const repo = repoOfCommon.get(key);
	if (repo === undefined) return;
	syncing.add(key);
	void (async () => {
		try {
			const submodules = await declaredSubmodules(repo);
			const commonDir = commonDirOf.get(key) ?? key;
			const targets = structureWatchTargets(repo, commonDir, submodules);
			// 挂句柄之前先记下结构状态：此后名字缺失的事件才有基线可比。
			lastState.set(key, await structureState(targets));
			const wanted = new Set(targets.map((target) => target.directory));
			let current = handles.get(key);
			if (current === undefined) {
				current = new Map();
				handles.set(key, current);
			}
			for (const [directory, close] of [...current]) {
				if (wanted.has(directory)) continue;
				closeQuietly(close);
				current.delete(directory);
			}
			for (const target of targets) {
				if (current.has(target.directory)) continue;
				const handle = watchTarget(key, target);
				if (handle !== null) current.set(target.directory, handle);
			}
		} finally {
			syncing.delete(key);
		}
	})();
}

/**
 * 解析一个仓库的公共目录并开始监视；已监视时跳过。
 *
 * @param repo - 仓库路径。
 * @returns 无。
 */
function arm(repo: string): void {
	void (async () => {
		/*
		 * 只登记自身就是仓库根的路径。未检出的子模块目录里没有 `.git`，向上解析会拿到外层仓库的
		 * 公共目录，把句柄挂在父仓库名下并把事件报成该子模块的。
		 */
		if (await gitDirAt(repo) === null) return;
		const commonDir = await resolveGitCommonDir(repo);
		if (commonDir === null) return;
		// 比较键按规范化的公共目录生成，真实路径另存映射：区分大小写的文件系统上，键值路径可能不存在。
		const key = nodeId(commonDir);
		/*
		 * 只有磁盘上确实存在 git 目录的路径才登记为已知仓库：目录已删除的路径留在集合里，
		 * 会让此后每一条名字缺失的事件都判定为仓库集合变化。
		 */
		knownRepos.add(nodeId(repo));
		if (handles.has(key)) return;
		handles.set(key, new Map());
		repoOfCommon.set(key, repo);
		commonDirOf.set(key, commonDir);
		sync(key);
	})();
}

/**
 * 登记一个按 key 合并的定时器
 * @param table - key 到定时器的映射。
 * @param key - 合并键。
 * @param delayMs - 合并窗口毫秒数。
 * @param run - 到点后的动作。
 * @returns 无。
 */
function scheduleTimer(table: Map<string, ReturnType<typeof setTimeout>>, key: string, delayMs: number, run: () => void): void {
	const existing = table.get(key);
	if (existing !== undefined) clearTimeout(existing);
	const timer = setTimeout(() => {
		table.delete(key);
		run();
	}, delayMs);
	if (typeof timer.unref === 'function') timer.unref();
	table.set(key, timer);
}

/**
 * 合并一次结构变化并通知订阅者。
 *
 * @param key - 规范化后的公共目录。
 * @returns 无。
 */
function schedule(key: string): void {
	scheduleTimer(pending, key, COALESCE_MS, () => {
		const repo = repoOfCommon.get(key);
		if (repo === undefined) return;
		// 先补挂再通知：接收方重新枚举期间产生的事件也要能落到句柄上。
		sync(key);
		notify(repo);
	});
}

/**
 * 监视一组仓库的结构变化。
 *
 * @param repos - 仓库、工作树或子模块路径。
 * @returns 无。
 */
export function watchRepositories(repos: readonly string[]): void {
	for (const repo of repos) {
		if (repo === '') continue;
		arm(repo);
	}
	logDebug('watcher', `登记仓库监视：本次 ${String(repos.length)} 个路径，当前监视 ${String(handles.size)} 个公共目录`);
	while (handles.size > MAX_WATCHED_REPOS) {
		const oldest = handles.keys().next();
		if (oldest.done === true) break;
		closeHandles(oldest.value);
		logDebug('watcher', `监视数超过上限 ${String(MAX_WATCHED_REPOS)}，淘汰最早登记的公共目录`);
	}
}

/**
 * 判定一次工作区事件是否可能表示仓库集合变化。
 *
 * @param target - 事件给出的绝对路径；名字缺失时为 null。
 * @param kind - 事件类型。
 * @param repos - 已知仓库路径；省略时用监视登记的集合。
 * @returns 需要重新枚举仓库集合时为 true。
 */
export async function isRepositorySetChange(
	target: string | null,
	kind: string,
	repos: Iterable<string> = knownRepos,
	scope: string | null = null,
): Promise<boolean> {
	const known = new Set([...repos].map((repo) => nodeId(repo)));
	if (target === null) {
		if (scope !== null) return await repositorySetChangedUnder(scope);
		/*
		 * 已知仓库不再有 git 目录时把它移出已知集合：仓库已消失，留在集合里会让此后每一条
		 * 名字缺失的事件都判定为变化，反复触发重新枚举。
		 */
		let changed = false;
		for (const repo of [...known]) {
			if (await gitDirAt(repo) !== null) continue;
			known.delete(repo);
			knownRepos.delete(repo);
			changed = true;
		}
		return changed;
	}
	const parts = resolve(target).split(/[\\/]/);
	const gitIndex = parts.indexOf('.git');
	if (gitIndex !== -1) {
		const owner = parts.slice(0, gitIndex).join('/');
		return owner === '' || !known.has(nodeId(owner));
	}
	if (kind !== 'rename') return false;
	const id = nodeId(target);
	for (const repo of known) {
		if (repo === id || repo.startsWith(`${id}/`)) return true;
	}
	return await holdsRepository(target, PROBE_DEPTH);
}

/**
 * 核对一个被监视目录下的仓库集合是否与上次不同。
 *
 * @param scope - 被监视的目录（工作区根或其直接子目录）。
 * @returns 仓库集合已变时为 true。
 */
async function repositorySetChangedUnder(scope: string): Promise<boolean> {
	const key = nodeId(scope);
	const names: string[] = [];
	if (await gitDirAt(scope) !== null) names.push('.');
	try {
		await listDirAt(scope);
	} catch {
		// 目录已消失：与「空集合」比较，消失前有仓库即算变化。
		const previous = lastWorkspaceRepos.get(key) ?? '';
		lastWorkspaceRepos.set(key, '');
		return previous !== '';
	}
	/*
	 * 枚举到 `PROBE_DEPTH` 层：后端只报「这个目录变了」时，深度 2 的新仓库不会有任何句柄
	 * 先看到它，只能由这里发现。只记仓库名，新建空目录与普通文件改动因此不产生通知。
	 */
	const collect = async (dir: string, depth: number): Promise<void> => {
		let children;
		try {
			children = await listDirAt(dir);
		} catch {
			return;
		}
		for (const child of children) {
			if (child.type !== 'directory') continue;
			if (shouldPruneDirectory(child.name)) continue;
			const path = join(dir, child.name);
			if (await gitDirAt(path) !== null) names.push(nodeId(path));
			else if (depth > 1) await collect(path, depth - 1);
		}
	};
	await collect(scope, PROBE_DEPTH);
	const snapshot = names.sort().join(',');
	const previous = lastWorkspaceRepos.get(key);
	lastWorkspaceRepos.set(key, snapshot);
	return previous !== undefined && previous !== snapshot;
}

/**
 * 判定一个目录自身或其下若干层内是否有仓库。

 * @param dir - 目录。
 * @param depth - 还要下探的层数。
 * @returns 自身或任一子目录含 `.git` 条目时为 true。
 */
async function holdsRepository(dir: string, depth: number): Promise<boolean> {
	if (await gitDirAt(dir) !== null) return true;
	if (depth <= 0) return false;
	let entries;
	try {
		entries = await listDirAt(dir);
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (entry.type !== 'directory') continue;
		if (await holdsRepository(join(dir, entry.name), depth - 1)) return true;
	}
	return false;
}

/**
 * 合并一次工作区级事件并通知订阅者。
 *
 * @param watch - 监视状态。
 * @returns 无。
 */
function scheduleWorkspace(watch: WorkspaceWatch): void {
	if (watch.timer !== null) clearTimeout(watch.timer);
	watch.timer = setTimeout(() => {
		watch.timer = null;
		notify(watch.root);
	}, WORKSPACE_COALESCE_MS);
	if (typeof watch.timer.unref === 'function') watch.timer.unref();
}

/**
 * 合并一次子目录句柄的补挂。
 *
 * 子目录的出现与消失不改变仓库集合，因此不能等 {@link scheduleWorkspace}：新建一个空目录时
 * 集合没变，却必须挂上句柄，否则它内部随后新建的仓库收不到任何事件。
 *
 * @param key - 规范化后的工作区根。
 * @returns 无。
 */
function scheduleChildSync(key: string): void {
	scheduleTimer(childSyncTimers, key, WORKSPACE_COALESCE_MS, () => { void syncWorkspaceChildren(key); });
}

/**
 * 通知一次结构变化。
 *
 * @param repo - 结构可能已变的仓库或工作区路径。
 * @returns 无。
 */
function notify(repo: string): void {
	for (const listener of listeners.snapshot()) {
		try {
			listener(repo);
		} catch {
			/* 单个订阅者异常不影响其它订阅者 */
		}
	}
}

/**
 * 监视一个工作区的仓库集合变化。
 *
 * 递归监视工作区根：新建的仓库与工作树此前没有任何句柄，仓库级监视发现不了它们。已知仓库
 * 内部的结构变化由仓库级监视负责，这里只按 {@link isRepositorySetChange} 判定，普通 git 操作
 * 与文件读写都不触发。
 *
 * 同一工作区只挂一个句柄：调用方可能给出同一路径的不同写法（分隔符与大小写都不同），去重按
 * 规范化后的比较键。超出上限时淘汰最早登记的工作区。
 *
 * @param root - 工作区根路径。
 * @returns 无。
 */
export function watchWorkspace(root: string): void {
	if (root === '') return;
	const key = nodeId(root);
	if (workspaces.has(key)) return;
	// 先占位：挂载是异步的，同步段里重复调用不能挂两套句柄。
	workspaces.set(key, { root, handle: null, children: new Map(), timer: null });
	const controller = new AbortController();
	workspaceSignals.set(key, controller);
	void workspaceWatch(key, root, controller.signal).then(async (close) => {
		const current = workspaces.get(key);
		if (current === undefined) { await close().catch(() => undefined); return; }
		current.handle = close;
		// 先记基线：此后「目录变了」的事件才能据此判断仓库集合是否真的变了。
		await repositorySetChangedUnder(root);
		logInfo('watcher', `已开始监视工作区：${root}`);
		await syncWorkspaceChildren(key);
	}).catch((error: unknown) => {
		// 工作区不可监视：目录不存在或没有权限。
		closeWorkspace(key);
		logWarn('watcher', `工作区无法监视，仓库集合变化将不会被自动发现：${root}：${errorText(error)}`);
	}).finally(() => {
		while (workspaces.size > MAX_WATCHED_WORKSPACES) {
			const oldest = workspaces.keys().next();
			if (oldest.done === true) break;
			closeWorkspace(oldest.value);
		}
	});
}

/**
 * 按工作区当前的形态补挂缺失的子目录句柄、摘掉已消失的。
 *
 * 只在后端不支持递归监视时生效：`ctx.fs.watch` 观察不到子目录里的变化，第二层因此要自己挂。
 * 已有句柄保持不动，避免重建窗口内丢事件。
 *
 * @param key - 规范化后的工作区根。
 * @returns 无。
 */
async function syncWorkspaceChildren(key: string): Promise<void> {
	const watchState = workspaceOf(key);
	if (watchState === null) return;
	const signal = workspaceSignals.get(key)?.signal;
	if (signal === undefined) return;
	let entries;
	try {
		entries = await listDirAt(watchState.root);
	} catch {
		return;
	}
	const wanted = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== 'directory') continue;
		if (shouldPruneDirectory(entry.name)) continue;
		const dir = join(watchState.root, entry.name);
		wanted.set(nodeId(dir), dir);
	}
	for (const [childKey, close] of [...watchState.children]) {
		if (wanted.has(childKey)) continue;
		closeQuietly(close);
		watchState.children.delete(childKey);
	}
	for (const [childKey, dir] of wanted) {
		if (watchState.children.has(childKey)) continue;
		// 先占位：挂载是异步的，事件到达前重复同步不能挂两套。
		const placeholder: { close: WatchCloser | null } = { close: null };
		watchState.children.set(childKey, () => {
			void placeholder.close?.().catch(() => { /* 句柄已关闭 */ });
			return Promise.resolve();
		});
		void workspaceChildWatch(key, dir, signal).then((close) => {
			const current = workspaces.get(key);
			if (current === undefined || !current.children.has(childKey)) { closeQuietly(close); return; }
			placeholder.close = close;
			current.children.set(childKey, close);
			// 子目录同样先记基线，否则它内部的第一次变化会被当成「没有基线」。
			void repositorySetChangedUnder(dir);
		}).catch((error: unknown) => {
			watchState.children.delete(childKey);
			logDebug('watcher', `子目录无法监视，其内部新建的仓库不会被自动发现：${dir}：${errorText(error)}`);
		});
	}
}

/**
 * 把一个目录的变化判定为「仓库集合是否已变」，变了就排一次通知。
 *
 * 根目录与它的直接子目录共用同一套判定：名字给出时按名字判，名字缺失时核对该目录下的
 * 仓库集合快照。
 *
 * @param key - 规范化后的工作区根。
 * @param scope - 被监视的目录。
 * @param filename - 事件给出的名字；缺失时为 null。
 * @param kind - 事件类型；缺失时为 null。
 * @returns 无。
 */
function noteDirectoryChange(key: string, scope: string, filename: string | null | undefined, kind: string | null | undefined): void {
	const watchState = workspaceOf(key);
	if (watchState === null) return;
	const target = typeof filename === 'string' && filename !== '' ? join(scope, filename) : null;
	void isRepositorySetChange(target, kind ?? 'change', knownRepos, scope).then((changed) => {
		if (changed) scheduleWorkspace(watchState);
	}).catch(() => {
		/* 判定失败不影响监视 */
	});
}

/**
 * 在一个工作区的直接子目录上挂句柄。
 *
 * 子目录里出现或消失仓库时，事件的名字是仓库目录名，判定与根目录同一套。
 *
 * @param key - 规范化后的工作区根。
 * @param dir - 子目录绝对路径。
 * @param signal - 取消监视。
 * @returns 关闭函数。
 */
function workspaceChildWatch(key: string, dir: string, signal: AbortSignal): Promise<WatchCloser> {
	const onChange: DirChangeListener = (error, filename, kind) => {
		if (error !== undefined) {
			logDebug('watcher', `子目录监视句柄报错：${dir}：${error.message}`);
			return;
		}
		noteDirectoryChange(key, dir, filename, kind);
	};
	return watchDirAt(dir, onChange, signal);
}

/**
 * 在一个工作区根上挂句柄。
 *
 * @param key - 规范化后的工作区根。
 * @param root - 工作区根路径。
 * @param signal - 取消挂载。
 * @returns 关闭函数。
 */
function workspaceWatch(key: string, root: string, signal: AbortSignal): Promise<WatchCloser> {
	const onChange: DirChangeListener = (error, filename, kind) => {
		if (error !== undefined) {
			logWarn('watcher', `工作区监视句柄报错，已停止监视：${root}：${error.message}`);
			closeWorkspace(key);
			return;
		}
		// 子目录的出现与消失不改变仓库集合，但必须据此补挂或摘掉句柄。
		scheduleChildSync(key);
		noteDirectoryChange(key, root, filename, kind);
	};
	return watchDirAt(root, onChange, signal);
}

/**
 * 关闭一个工作区的监视。
 *
 * @param key - 规范化后的工作区根。
 * @returns 无。
 */
function closeWorkspace(key: string): void {
	const watchState = workspaces.get(key);
	workspaces.delete(key);
	workspaceSignals.get(key)?.abort();
	workspaceSignals.delete(key);
	if (watchState === undefined) return;
	if (watchState.timer !== null) clearTimeout(watchState.timer);
	void watchState.handle?.().catch(() => { /* 句柄已关闭 */ });
	for (const close of watchState.children.values()) {
		closeQuietly(close);
	}
	watchState.children.clear();
	lastWorkspaceRepos.delete(nodeId(watchState.root));
	const childTimer = childSyncTimers.get(key);
	if (childTimer !== undefined) clearTimeout(childTimer);
	childSyncTimers.delete(key);
}

/**
 * 关闭全部监视句柄、合并定时器与订阅者。
 *
 * @returns 无。
 */
export function closeRepositoryWatchers(): void {
	logInfo('watcher', `关闭全部监视：${String(handles.size)} 个仓库、${String(workspaces.size)} 个工作区`);
	for (const key of [...handles.keys()]) closeHandles(key);
	for (const key of [...workspaces.keys()]) closeWorkspace(key);
	for (const timer of pending.values()) clearTimeout(timer);
	pending.clear();
	syncing.clear();
	confirming.clear();
	lastState.clear();
	knownRepos.clear();
	lastWorkspaceRepos.clear();
	listeners.clear();
}
