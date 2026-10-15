/**
 * 仓库发现：从工作区根按层递归寻找最多三层的 git 仓库，并枚举各仓库的工作树与子模块。
 *
 * 递归只用于仓库发现。子模块按 `.gitmodules` 判定、工作树按 `git worktree list`
 * 枚举，两者都不参与递归、不受层数限制，工作树可位于工作区根之外。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { runGit } from './working-tree.js';
import { foreignWorktreeBranches, parseWorktreeList } from './worktree-branches.js';

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
}

/** 一个工作树的枚举结果。 */
interface WorktreeInfo {
	readonly path: string;
	readonly branch: string | null;
	readonly head: string | null;
}

/** 递归时跳过的目录名。 */
const PRUNED_DIRECTORIES = new Set([
	'.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv', '__pycache__',
	'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache', '.turbo',
	'.gradle', '.m2', '.pnpm-store', '.yarn', '.codegraph', '.idea',
]);

/** 默认最大递归层数。 */
const DEFAULT_MAX_DEPTH = 3;

/** 默认最多访问的目录数。 */
const DEFAULT_MAX_DIRECTORIES = 5000;

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
 * 目录名是否属于递归剪枝集合。
 *
 * @param name - 目录名。
 * @returns 需要跳过时为 true。
 */
export function shouldPruneDirectory(name: string): boolean {
	return PRUNED_DIRECTORIES.has(name);
}

/**
 * 解析 `.gitmodules` 中的子模块路径。
 *
 * @param source - `.gitmodules` 文本。
 * @returns 相对仓库根的子模块路径，按出现顺序。
 */
export function parseSubmodulePaths(source: string): string[] {
	const paths: string[] = [];
	const section = /^\s*\[.*\]\s*$/;
	const submodule = /^\s*\[submodule\s+"/;
	const pathProperty = /^\s*path\s*=\s*(.*)$/;
	let inSubmodule = false;
	for (const line of source.split(/\r?\n/)) {
		if (section.test(line)) {
			inSubmodule = submodule.test(line);
			continue;
		}
		if (!inSubmodule) continue;
		const match = pathProperty.exec(line);
		const value = match === null ? '' : match[1].trim();
		if (value !== '') paths.push(value);
	}
	return paths;
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
 * 解析 `git worktree list --porcelain` 的输出。
 *
 * @param stdout - git 的标准输出。
 * @returns 每个非 bare 工作树的路径、分支与短哈希。
 */
export function parseWorktrees(stdout: string): WorktreeInfo[] {
	return parseWorktreeList(stdout)
		.filter((entry) => !entry.bare)
		.map((entry) => ({ path: entry.path, branch: entry.branch, head: entry.head }));
}

/**
 * 读取目录的 `.git` 条目类型。
 *
 * @param dir - 目录。
 * @returns `dir`（主工作树）、`file`（工作树/子模块检出）或 null。
 */
async function gitEntryOf(dir: string): Promise<'dir' | 'file' | null> {
	try {
		const info = await stat(join(dir, '.git'));
		return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null;
	} catch {
		return null;
	}
}

/**
 * 列出目录下参与递归的子目录。
 *
 * @param dir - 目录。
 * @returns 绝对子目录路径；符号链接与剪枝目录除外。
 */
async function subdirectories(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && !shouldPruneDirectory(entry.name))
			.map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

/**
 * 读取仓库自身的工作区分支。
 *
 * @param dir - 仓库根。
 * @returns 分支名与分离头指针的短哈希。
 */
async function headOf(dir: string): Promise<{ branch: string | null; head: string | null }> {
	try {
		return parseHead(await readFile(join(dir, '.git', 'HEAD'), 'utf8'));
	} catch {
		return { branch: null, head: null };
	}
}

/**
 * 枚举一个仓库的工作树并构造节点，不挂子模块。
 *
 * @param dir - 仓库根。
 * @returns 工作树节点列表（不含自身）。
 */
async function worktreesOf(dir: string): Promise<RepoNode[]> {
	const nodes: RepoNode[] = [];
	const selfId = nodeId(dir);
	try {
		const listed = await runGit(['worktree', 'list', '--porcelain'], dir);
		if (listed.code === 0) {
			for (const worktree of parseWorktrees(listed.stdout)) {
				if (nodeId(worktree.path) === selfId) continue;
				nodes.push({
					id: nodeId(worktree.path), path: worktree.path, name: basename(worktree.path),
					kind: 'worktree', depth: 1, branch: worktree.branch, head: worktree.head,
					available: true, children: [],
				});
			}
		}
	} catch {
		/* 工作树枚举失败不影响仓库节点 */
	}
	return nodes;
}

/**
 * 枚举指定仓库下在 `.gitmodules` 中声明的子模块（实际打开/检出）。
 *
 * 子模块仅作为叶子节点列出，不再下钻内部结构。
 *
 * @param dir - 仓库根或工作树根。
 * @param submoduleIds - 收集到的子模块路径标识，供递归跳过。
 * @returns 子模块节点列表。
 */
async function submodulesOf(dir: string, submoduleIds: Set<string>): Promise<RepoNode[]> {
	const nodes: RepoNode[] = [];
	try {
		const source = await readFile(join(dir, '.gitmodules'), 'utf8');
		for (const relativePath of parseSubmodulePaths(source)) {
			const path = resolve(dir, relativePath);
			submoduleIds.add(nodeId(path));
			nodes.push({
				id: nodeId(path), path, name: basename(path), kind: 'submodule', depth: 1,
				branch: null, head: null, available: (await gitEntryOf(path)) !== null, children: [],
			});
		}
	} catch {
		/* 没有 .gitmodules */
	}
	return nodes;
}

/**
 * 构造一个仓库节点并枚举其工作树与子模块。
 * 工作树节点自身也会枚举其子模块（如果有 `.gitmodules`）。
 *
 * @param dir - 仓库根。
 * @param depth - 展示层级（仓库平级 depth=0）。
 * @param submoduleIds - 收集子模块路径标识，供递归跳过。
 * @returns 仓库节点。
 */
async function repoNodeOf(dir: string, depth: number, submoduleIds: Set<string>): Promise<RepoNode> {
	const head = await headOf(dir);
	const node: RepoNode = {
		id: nodeId(dir), path: dir, name: basename(dir) || dir, kind: 'repo', depth,
		branch: head.branch, head: head.head, available: true, children: [],
	};
	// 枚举工作树
	const worktrees = await worktreesOf(dir);
	for (const wt of worktrees) {
		// 工作树也枚举子模块
		wt.children.push(...await submodulesOf(wt.path, submoduleIds));
	}
	node.children.push(...worktrees);
	// 枚举仓库自己的子模块
	node.children.push(...await submodulesOf(dir, submoduleIds));
	return node;
}

/**
 * 发现工作区根下的仓库，并补齐工作区根所属的仓库。
 *
 * @param root - 工作区根目录。
 * @param options - 层数与目录数上限。
 * @returns 仓库扁平列表与是否被截断。
 */
export async function discoverRepositories(root: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
	// 缓存命中：只核对已知路径，跳过整层目录扫描。
	if (options.knownRepos !== undefined && options.knownRepos.length > 0) {
		return discoverKnownRepositories(root, options.knownRepos);
	}
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
	const nodes: RepoNode[] = [];
	const submoduleIds = new Set<string>();
	const visited = new Set<string>();
	let visitedCount = 0;
	let truncated = false;
	let level: Array<{ dir: string; depth: number }> = [{ dir: resolve(root), depth: 0 }];
	while (level.length > 0) {
		const next: Array<{ dir: string; depth: number }> = [];
		for (const current of level) {
			if (visitedCount >= maxDirectories) {
				truncated = true;
				break;
			}
			visitedCount++;
			const id = nodeId(current.dir);
			if (visited.has(id) || submoduleIds.has(id)) continue;
			visited.add(id);
			const gitEntry = await gitEntryOf(current.dir);
			if (gitEntry === 'dir') nodes.push(await repoNodeOf(current.dir, current.depth, submoduleIds));
			// 工作树与子模块检出由权威枚举负责，不再下钻。
			if (gitEntry === 'file') continue;
			if (current.depth >= maxDepth) continue;
			for (const child of await subdirectories(current.dir)) next.push({ dir: child, depth: current.depth + 1 });
		}
		level = next;
	}
	const enclosing = await enclosingRepo(root, visited, submoduleIds);
	if (enclosing !== null) nodes.unshift(enclosing);
	nodes.sort((left, right) => left.path.localeCompare(right.path));
	return { nodes, truncated };
}

/**
 * 按已知路径取仓库节点，不扫描目录。
 *
 * 每个路径核一次 `.git` 是否存在：仍是仓库就构造节点（含工作树与子模块），否则跳过。
 * 已不是仓库的路径被忽略；整个列表都失效时退回完整扫描，避免仓库树空掉。
 *
 * @param root - 工作区根目录。
 * @param known - 已知的顶层仓库路径。
 * @returns 仓库扁平列表与是否被截断（快路径不截断）。
 */
async function discoverKnownRepositories(root: string, known: readonly string[]): Promise<DiscoveryResult> {
	const nodes: RepoNode[] = [];
	const submoduleIds = new Set<string>();
	const visited = new Set<string>();
	for (const candidate of known) {
		const dir = resolve(candidate);
		const id = nodeId(dir);
		if (visited.has(id) || submoduleIds.has(id)) continue;
		if (await gitEntryOf(dir) !== 'dir') continue;
		visited.add(id);
		nodes.push(await repoNodeOf(dir, 0, submoduleIds));
	}
	if (nodes.length === 0) {
		return discoverRepositories(root, { maxDepth: DEFAULT_MAX_DEPTH, maxDirectories: DEFAULT_MAX_DIRECTORIES });
	}
	const enclosing = await enclosingRepo(root, visited, submoduleIds);
	if (enclosing !== null) nodes.unshift(enclosing);
	nodes.sort((left, right) => left.path.localeCompare(right.path));
	return { nodes, truncated: false };
}

/**
 * 工作区根位于某个仓库内部时补齐该仓库。
 *
 * @param root - 工作区根目录。
 * @param visited - 已访问目录标识。
 * @param submoduleIds - 收集子模块路径标识。
 * @returns 仓库节点；工作区根不在仓库内或已发现时为 null。
 */
async function enclosingRepo(root: string, visited: Set<string>, submoduleIds: Set<string>): Promise<RepoNode | null> {
	try {
		const result = await runGit(['rev-parse', '--show-toplevel'], root);
		if (result.code !== 0) return null;
		const top = result.stdout.trim();
		if (top === '' || visited.has(nodeId(top))) return null;
		visited.add(nodeId(top));
		return await repoNodeOf(resolve(top), 0, submoduleIds);
	} catch {
		return null;
	}
}

/**
 * 取被「别的工作树」检出的分支。
 *
 * 一个分支同时只能被一个工作树检出。查看某个工作树时，别的工作树占用的分支既不是它的
 * 当前分支，也不可删除（git 报 `cannot delete branch ... used by worktree at ...`），
 * 因此要从分支标签与删除候选中排除；而**当前工作树自己的分支**保留，仍作为当前分支显示。
 *
 * 比较用规范化路径，因此查看主工作树或任一链接工作树都得到正确结果。
 *
 * @param repo - 当前查看的仓库或工作树路径。
 * @returns 被别的工作树占用的分支名集合；枚举失败时为空集。
 */
export async function branchesOfOtherWorktrees(repo: string): Promise<Set<string>> {
	try {
		const listed = await runGit(['worktree', 'list', '--porcelain'], repo);
		if (listed.code !== 0) return new Set();
		return foreignWorktreeBranches(parseWorktreeList(listed.stdout), repo, nodeId);
	} catch {
		/* 枚举失败时不排除任何分支 */
		return new Set();
	}
}

/**
 * 读取一个仓库相对其上游的领先/落后提交数。
 *
 * @param repo - 仓库路径。
 * @returns 分支、上游名与领先/落后数；无上游时两者为 0。
 */
export async function loadRepoSync(repo: string): Promise<{
	branch: string | null; upstream: string | null; ahead: number; behind: number;
}> {
	const head = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], repo);
	const branch = head.code === 0 ? head.stdout.trim() : '';
	if (branch === '') return { branch: null, upstream: null, ahead: 0, behind: 0 };
	const upstreamResult = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repo);
	if (upstreamResult.code !== 0) return { branch, upstream: null, ahead: 0, behind: 0 };
	const upstream = upstreamResult.stdout.trim();
	const counts = await runGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], repo);
	if (counts.code !== 0) return { branch, upstream, ahead: 0, behind: 0 };
	const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
	const behind = Number.parseInt(behindRaw ?? '', 10);
	const ahead = Number.parseInt(aheadRaw ?? '', 10);
	return {
		branch, upstream,
		ahead: Number.isFinite(ahead) ? ahead : 0,
		behind: Number.isFinite(behind) ? behind : 0,
	};
}
