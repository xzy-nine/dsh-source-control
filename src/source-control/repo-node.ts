/**
 * 仓库树节点：类型、路径归一与目录探测。
 *
 * 节点构造（工作树与子模块枚举）在 `repo-enrich.ts`，发现流程在 `repo-discovery.ts`。
 */
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { logDebug } from './logger.js';

/** 节点种类：主工作树仓库、链接工作树、子模块。 */
export type RepoNodeKind = 'repo' | 'worktree' | 'submodule';

/** 一个仓库、工作树或子模块节点。 */
export interface RepoNode {
	/** 规范化绝对路径派生的稳定标识。 */
	readonly id: string;
	/** 节点绝对路径。 */
	readonly path: string;
	/** 末段目录名。 */
	readonly name: string;
	/** 节点种类。 */
	readonly kind: RepoNodeKind;
	/** 展示缩进层级。 */
	readonly depth: number;
	/** 当前分支；分离头指针为 null。 */
	readonly branch: string | null;
	/** 提交短哈希；仅工作树枚举提供。 */
	readonly head: string | null;
	/** 路径在磁盘上是否存在。 */
	readonly available: boolean;
	/** 工作树与子模块。 */
	readonly children: RepoNode[];
}

/** 一次发现的结果。 */
export interface DiscoveryResult {
	/** 发现的仓库（扁平列表，按路径排序），工作树与子模块挂在各自仓库下。 */
	readonly nodes: RepoNode[];
	/** 是否因目录数上限提前结束。 */
	readonly truncated: boolean;
}

/** 发现选项。 */
export interface DiscoveryOptions {
	/** 仓库发现的最大递归层数；工作区根为第 0 层。 */
	readonly maxDepth?: number;
	/** 最多访问的目录数。 */
	readonly maxDirectories?: number;
	/**
	 * 已知的顶层仓库路径。
	 *
	 * 给出时不再逐层扫描：只核对这些路径是否仍是仓库，再补上工作树与子模块。仓库位置基本
	 * 不变，扫描成本却随目录数增长（默认上限 5000 个目录），因此缓存命中时走这条快路径。
	 * 核对不通过的路径被忽略；整个列表都失效时退回完整扫描。
	 */
	readonly knownRepos?: readonly string[];
	/**
	 * 只产出顶层仓库节点。
	 *
	 * 为 true 时每个仓库节点的 `children` 一律为空数组，不读工作树登记、不读 `.gitmodules`；
	 * 工作树与子模块由 {@link enrichRepositories} 事后补齐。
	 */
	readonly shallow?: boolean;
}

/** 递归时跳过的目录名。 */
const PRUNED_DIRECTORIES = new Set([
	'.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv', '__pycache__',
	'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache', '.turbo',
	'.gradle', '.m2', '.pnpm-store', '.yarn', '.codegraph', '.idea',
]);

/** 默认最大递归层数。 */
export const DEFAULT_MAX_DEPTH = 3;

/** 默认最多访问的目录数。 */
export const DEFAULT_MAX_DIRECTORIES = 5000;

/**
 * 把路径规范化为节点标识。
 *
 * @param path - 任意路径。
 * @returns 使用 `/` 分隔的绝对路径；Windows 上统一小写。
 */
export function nodeId(path: string): string {
	const normalized = resolve(path).split(sep).join('/');
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 按入参顺序去重一组候选路径。
 *
 * 已在 `visited` 或 `submoduleIds` 中的路径跳过，保留首次出现的路径；命中的标识写入 `visited`。
 *
 * @param paths - 候选路径。
 * @param visited - 已访问目录标识，就地更新。
 * @param submoduleIds - 子模块路径标识。
 * @returns 去重后的绝对路径，顺序与入参一致。
 */
export function dedupeCandidates(
	paths: readonly string[],
	visited: Set<string>,
	submoduleIds: ReadonlySet<string>,
): string[] {
	const candidates: string[] = [];
	for (const candidate of paths) {
		const dir = resolve(candidate);
		const id = nodeId(dir);
		if (visited.has(id) || submoduleIds.has(id)) continue;
		visited.add(id);
		candidates.push(dir);
	}
	return candidates;
}

/**
 * 目录名是否属于递归剪枝集合。
 *
 * @param name - 目录名。
 * @returns 需要跳过时为 true。
 */
export function shouldPruneDirectory(name: string): boolean {
	return PRUNED_DIRECTORIES.has(name);
}

/**
 * 解析 `.git/HEAD`。
 *
 * @param source - `HEAD` 文件内容。
 * @returns 分支名与分离头指针的短哈希。
 */
export function parseHead(source: string): { branch: string | null; head: string | null } {
	const text = source.trim();
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
	if (ref !== null) return { branch: ref[1].trim(), head: null };
	return { branch: null, head: /^[0-9a-f]{7,40}$/.test(text) ? text.slice(0, 7) : null };
}

/**
 * 读取目录的 `.git` 条目类型。
 *
 * @param dir - 目录。
 * @returns `dir`（主工作树）、`file`（工作树/子模块检出）或 null。
 */
export async function gitEntryOf(dir: string): Promise<'dir' | 'file' | null> {
	try {
		const info = await stat(join(dir, '.git'));
		return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null;
	} catch {
		return null;
	}
}

/**
 * 目录内是否存在 `.git` 条目（目录或文件）。
 *
 * @param dir - 目录。
 * @returns 存在 `.git` 目录或文件时为 true。
 */
export async function hasGitEntry(dir: string): Promise<boolean> {
	return (await gitEntryOf(dir)) !== null;
}

/**
 * 列出目录下参与递归的子目录。
 *
 * @param dir - 目录。
 * @returns 绝对子目录路径；符号链接与剪枝目录除外。
 */
export async function subdirectories(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && !shouldPruneDirectory(entry.name))
			.map((entry) => join(dir, entry.name));
	} catch (error) {
		// 权限不足或目录已消失：不影响其它层级的发现，但要知道是哪一层没读到。
		logDebug('repo', `无法读取目录 ${dir}，跳过其子目录：${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
