/**
 * 仓库结构监视：观察 git 目录里的工作树登记、子模块目录、工作区的子模块声明，以及工作区里
 * 仓库目录的出现与消失。
 *
 * 工作树与子模块的增删不一定经过本插件的执行层：宿主自己的工作树工具、外部命令与编辑器
 * 都会改动它们，因此结构变化只能从文件系统观察。监视只通知「某处结构可能已变」，不携带
 * 数据，由接收方重新枚举。
 *
 * 两套监视层次不同：
 * - 仓库级：按 git 公共目录去重，观察工作树登记与子模块；主工作树、链接工作树与子模块共用
 *   同一公共目录，因此同一仓库只挂一套句柄。目标见 {@link structureWatchTargets}。
 * - 工作区级：递归观察工作区根，只判定「仓库集合是否可能已变」。新建的仓库或工作树此前没有
 *   任何句柄，只能由这一层发现。见 {@link watchWorkspace}。
 *
 * 事件到达后按当前形态补挂缺失的目录、摘掉已消失的目录，已有句柄保持不动：整体重建会让
 * 重建窗口内的事件丢失。
 */
import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseSubmodulePaths } from './submodule-parse.js';
import { gitDirAt, resolveGitCommonDir } from './worktree-branches.js';

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

/**
 * 把路径规范化为与仓库节点标识一致的比较键。
 *
 * @param path - 任意路径。
 * @returns 使用 `/` 分隔的绝对路径；Windows 上统一小写。
 */
function pathKey(path: string): string {
	const normalized = resolve(path).split(sep).join('/');
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 结构变化订阅者。 */
const listeners = new Set<(repo: string) => void>();

/** git 公共目录（规范化） -> 目录 -> 监视句柄。 */
const handles = new Map<string, Map<string, FSWatcher>>();

/** git 公共目录（规范化） -> 该套句柄对应的仓库路径。 */
const repoOfCommon = new Map<string, string>();

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

/** 一个工作区的级监视状态。 */
interface WorkspaceWatch {
	/** 工作区根路径，保持登记时的写法。 */
	root: string;
	/** 句柄；平台不支持递归监视时为根目录的单层句柄。 */
	handle: FSWatcher;
	/** 合并定时器。 */
	timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 订阅仓库结构变化。
 *
 * @param listener - 结构变化时调用，参数为仓库路径。
 * @returns 取消订阅。
 */
export function onRepositoryTreeChange(listener: (repo: string) => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/**
 * 读取一个仓库在 `.gitmodules` 里声明的子模块目录。
 *
 * @param repo - 仓库根。
 * @returns 子模块目录的绝对路径；没有 `.gitmodules` 时为 null。
 */
async function declaredSubmodules(repo: string): Promise<string[] | null> {
	try {
		return parseSubmodulePaths(await readFile(join(repo, '.gitmodules'), 'utf8'))
			.map((relative) => resolve(repo, relative));
	} catch {
		return null;
	}
}

/**
 * 取一个仓库需要监视的目标。
 *
 * 三类目标：
 * - git 公共目录：`worktrees` 与 `modules` 两个名字的出现与消失（新建或移除工作树、初始化
 *   子模块都会改动它们）；
 * - 仓库根：`.gitmodules` 的出现与消失（新增或删除子模块声明）；
 * - 每个声明的子模块：其父目录（子模块目录的出现与消失）。
 *
 * 仓库根只按 `.gitmodules` 过滤，**不含 `.git`**：`.git` 目录内部每次写操作都会以 `.git`
 * 名字冒泡到父目录（实测一轮 `status` / `add` / `commit` 产生数十次），而结构变化本身已由
 * 公共目录上的 `worktrees` / `modules` 名字事件覆盖。监视 `.git` 会形成
 * 「事件 → 重扫 → git → 事件」的死循环。`.gitmodules` 在普通 git 操作中不产生事件。
 *
 * 不监视 `worktrees` 与 `modules` 目录自身：Windows 上这两个目录的句柄在目录被删除后持续
 * 报错，且每次工作树操作会触发数万次事件。
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
	try {
		const info = await stat(path);
		if (!info.isDirectory()) return 'file';
		return (await readdir(path)).sort().join(',');
	} catch {
		return 'absent';
	}
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
	lastState.delete(key);
	if (existing === undefined) return;
	for (const handle of existing.values()) {
		try {
			handle.close();
		} catch {
			/* 句柄已关闭 */
		}
	}
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
function watchTarget(key: string, target: WatchTarget): FSWatcher | null {
	try {
		const handle = watch(target.directory, { persistent: false }, (_event, filename) => {
			const name = typeof filename === 'string' ? filename : null;
			if (name !== null) {
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
		});
		handle.on('error', () => {
			try {
				handle.close();
			} catch {
				/* 句柄已关闭 */
			}
			handles.get(key)?.delete(target.directory);
			const timer = setTimeout(() => { sync(key); }, REARM_MS);
			if (typeof timer.unref === 'function') timer.unref();
		});
		return handle;
	} catch {
		// 目录尚不存在：由上级目录的事件触发补挂。
		return null;
	}
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
		const state = await structureState(structureWatchTargets(repo, key, await declaredSubmodules(repo)));
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
			const targets = structureWatchTargets(repo, key, submodules);
			// 挂句柄之前先记下结构状态：此后名字缺失的事件才有基线可比。
			lastState.set(key, await structureState(targets));
			const wanted = new Set(targets.map((target) => target.directory));
			let current = handles.get(key);
			if (current === undefined) {
				current = new Map();
				handles.set(key, current);
			}
			for (const [directory, handle] of [...current]) {
				if (wanted.has(directory)) continue;
				try {
					handle.close();
				} catch {
					/* 句柄已关闭 */
				}
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
		const commonDir = await resolveGitCommonDir(repo);
		if (commonDir === null) return;
		const key = commonDir.toLowerCase();
		if (handles.has(key)) return;
		handles.set(key, new Map());
		repoOfCommon.set(key, repo);
		sync(key);
	})();
}

/**
 * 合并一次结构变化并通知订阅者。
 *
 * @param key - 规范化后的公共目录。
 * @returns 无。
 */
function schedule(key: string): void {
	const existing = pending.get(key);
	if (existing !== undefined) clearTimeout(existing);
	const timer = setTimeout(() => {
		pending.delete(key);
		const repo = repoOfCommon.get(key);
		if (repo === undefined) return;
		// 先补挂再通知：接收方重新枚举期间产生的事件也要能落到句柄上。
		sync(key);
		for (const listener of [...listeners]) {
			try {
				listener(repo);
			} catch {
				/* 单个订阅者异常不影响其它订阅者 */
			}
		}
	}, COALESCE_MS);
	// 监视不应阻止宿主退出。
	if (typeof timer.unref === 'function') timer.unref();
	pending.set(key, timer);
}

/**
 * 监视一组仓库的结构变化。
 *
 * 同一公共目录只挂一套句柄；超出上限时淘汰最早登记的仓库。
 *
 * @param repos - 仓库、工作树或子模块路径。
 * @returns 无。
 */
export function watchRepositories(repos: readonly string[]): void {
	for (const repo of repos) {
		if (repo === '') continue;
		knownRepos.add(pathKey(repo));
		arm(repo);
	}
	while (handles.size > MAX_WATCHED_REPOS) {
		const oldest = handles.keys().next();
		if (oldest.done === true) break;
		closeHandles(oldest.value);
	}
}

/**
 * 判定一次工作区事件是否可能表示仓库集合变化。
 *
 * 三条判据，与句柄在这台机器上实际报出的形态对应：
 * - 名字里有 `.git` 段：取其所属的仓库根，根未知才算变化。已知仓库内部的 `.git` 写操作由
 *   仓库级监视负责；普通 git 操作会在 `.git` 下产生数十次事件，在这里一并触发会形成
 *   「事件 → 重新发现 → 读 `.git` → 事件」的死循环。
 * - 名字是有过的普通路径且事件为 `rename`：该路径自身或下探 {@link PROBE_DEPTH} 层内出现
 *   或消失了仓库（新建仓库先建目录再写 `.git`，事件只给目录名），或者是已知仓库及其祖先
 *   （仓库目录被整体删除）。
 * - 名字缺失：核对已知仓库是否仍存在。Windows 的递归句柄删除目录树时只报 `change` 而不给
 *   名字，仓库被整个删除只有这条信号；普通 git 操作同样会报一条，此处几个 `stat` 即可结束。
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
): Promise<boolean> {
	const known = new Set([...repos].map((repo) => pathKey(repo)));
	if (target === null) {
		for (const repo of known) {
			if (await gitDirAt(repo) === null) return true;
		}
		return false;
	}
	const parts = resolve(target).split(/[\\/]/);
	const gitIndex = parts.indexOf('.git');
	if (gitIndex !== -1) {
		const owner = parts.slice(0, gitIndex).join('/');
		return owner === '' || !known.has(pathKey(owner));
	}
	if (kind !== 'rename') return false;
	const id = pathKey(target);
	for (const repo of known) {
		if (repo === id || repo.startsWith(`${id}/`)) return true;
	}
	return await holdsRepository(target, PROBE_DEPTH);
}

/**
 * 判定一个目录自身或其下若干层内是否有仓库。
 *
 * @param dir - 目录。
 * @param depth - 还要下探的层数。
 * @returns 自身或任一子目录含 `.git` 条目时为 true。
 */
async function holdsRepository(dir: string, depth: number): Promise<boolean> {
	if (await gitDirAt(dir) !== null) return true;
	if (depth <= 0) return false;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
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
 * 通知一次结构变化。
 *
 * @param repo - 结构可能已变的仓库或工作区路径。
 * @returns 无。
 */
function notify(repo: string): void {
	for (const listener of [...listeners]) {
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
	const key = pathKey(root);
	if (workspaces.has(key)) return;
	let handle: FSWatcher;
	try {
		handle = workspaceWatch(key, root, true);
	} catch {
		try {
			handle = workspaceWatch(key, root, false);
		} catch {
			/* 工作区不可监视：目录不存在或没有权限 */
			return;
		}
	}
	workspaces.set(key, { root, handle, timer: null });
	while (workspaces.size > MAX_WATCHED_WORKSPACES) {
		const oldest = workspaces.keys().next();
		if (oldest.done === true) break;
		closeWorkspace(oldest.value);
	}
}

/**
 * 在一个工作区根上挂句柄。
 *
 * @param key - 规范化后的工作区根。
 * @param root - 工作区根路径。
 * @param recursive - 是否递归。
 * @returns 句柄。
 */
function workspaceWatch(key: string, root: string, recursive: boolean): FSWatcher {
	const handle = watch(root, { recursive, persistent: false }, (eventKind, filename) => {
		const watchState = workspaces.get(key);
		if (watchState === undefined) return;
		// 名字缺失是合法的：新目录的内容在句柄注册之前变化时只报 change。
		const target = typeof filename === 'string' && filename !== '' ? join(root, filename) : null;
		void isRepositorySetChange(target, eventKind).then((changed) => {
			if (changed) scheduleWorkspace(watchState);
		}).catch(() => {
			/* 判定失败不影响监视 */
		});
	});
	handle.on('error', () => {
		try {
			handle.close();
		} catch {
			/* 句柄已关闭 */
		}
		workspaces.delete(key);
	});
	return handle;
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
	if (watchState === undefined) return;
	if (watchState.timer !== null) clearTimeout(watchState.timer);
	try {
		watchState.handle.close();
	} catch {
		/* 句柄已关闭 */
	}
}

/**
 * 关闭全部监视句柄、合并定时器与订阅者。
 *
 * @returns 无。
 */
export function closeRepositoryWatchers(): void {
	for (const key of [...handles.keys()]) closeHandles(key);
	for (const key of [...workspaces.keys()]) closeWorkspace(key);
	for (const timer of pending.values()) clearTimeout(timer);
	pending.clear();
	syncing.clear();
	confirming.clear();
	lastState.clear();
	knownRepos.clear();
	listeners.clear();
}
