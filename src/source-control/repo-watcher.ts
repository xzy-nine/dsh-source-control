/**
 * 仓库结构监视：观察 git 目录里的工作树登记、子模块目录与工作区的子模块声明。
 *
 * 工作树与子模块的增删不一定经过本插件的执行层：宿主自己的工作树工具、外部命令与编辑器
 * 都会改动它们，因此结构变化只能从文件系统观察。监视只通知「某仓库结构可能已变」，不携带
 * 数据，由接收方重新枚举。
 *
 * 监视按 git 公共目录去重：主工作树、链接工作树与子模块共用同一公共目录，因此同一仓库只
 * 挂一套句柄。目标见 {@link structureWatchTargets}。
 *
 * 事件到达后按当前形态补挂缺失的目录、摘掉已消失的目录，已有句柄保持不动：整体重建会让
 * 重建窗口内的事件丢失。
 */
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseSubmodulePaths } from './submodule-parse.js';
import { resolveGitCommonDir } from './worktree-branches.js';

/** 一次结构变化的合并窗口（毫秒）：创建工作树会连续产生多次目录事件。 */
const COALESCE_MS = 250;

/** 监视句柄出错后重新同步的延迟（毫秒）。 */
const REARM_MS = 1000;

/** 同时监视的仓库数上限；超出按登记顺序淘汰最早的。 */
const MAX_WATCHED_REPOS = 32;

/** 一个监视目标：目录与触发结构变化的名字。 */
export interface WatchTarget {
	/** 被监视的目录。 */
	readonly directory: string;
	/** 触发结构变化的名字；空数组表示该目录下任意变化都触发。 */
	readonly names: readonly string[];
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
 * @param target - 监视目标。
 * @param filename - 事件给出的名字；无法给出时为 null。
 * @returns 属于结构变化时为 true。
 */
export function isStructureChange(target: WatchTarget, filename: string | null): boolean {
	if (target.names.length === 0) return true;
	if (filename === null) return true;
	return target.names.includes(filename);
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
 * @param key - 规范化后的公共目录。
 * @param target - 监视目标。
 * @returns 句柄；目录不存在或无法监视时为 null。
 */
function watchTarget(key: string, target: WatchTarget): FSWatcher | null {
	try {
		const handle = watch(target.directory, { persistent: false }, (_event, filename) => {
			if (!isStructureChange(target, typeof filename === 'string' ? filename : null)) return;
			schedule(key);
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
		arm(repo);
	}
	while (handles.size > MAX_WATCHED_REPOS) {
		const oldest = handles.keys().next();
		if (oldest.done === true) break;
		closeHandles(oldest.value);
	}
}

/**
 * 关闭全部监视句柄、合并定时器与订阅者。
 *
 * @returns 无。
 */
export function closeRepositoryWatchers(): void {
	for (const key of [...handles.keys()]) closeHandles(key);
	for (const timer of pending.values()) clearTimeout(timer);
	pending.clear();
	syncing.clear();
	listeners.clear();
}
