/**
 * 仓库节点构造：读取 HEAD、枚举工作树与子模块，并按路径补齐。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseSubmodulePaths, submodulePathsWithin } from './submodule-parse.js';
import { logDebug } from './logger.js';
import { gitDirAt, readWorktrees, resolveGitCommonDir } from './worktree-branches.js';
import { dedupeCandidates, gitEntryOf, hasGitEntry, nodeId, parseHead } from './repo-node.js';
import type { RepoNode } from './repo-node.js';

/**
 * 读取仓库自身的工作区分支。
 *
 * `HEAD` 位于 git 目录下：主工作树是 `<dir>/.git/HEAD`，链接工作树与子模块是 `.git` 文件中
 * `gitdir:` 指向目录下的 `HEAD`。
 *
 * @param dir - 仓库根。
 * @returns 分支名与分离头指针的短哈希。
 */
async function headOf(dir: string): Promise<{ branch: string | null; head: string | null }> {
	const gitDir = await gitDirAt(dir);
	if (gitDir === null) return { branch: null, head: null };
	try {
		return parseHead(await readFile(join(gitDir, 'HEAD'), 'utf8'));
	} catch (error) {
		logDebug('repo', `读取 HEAD 失败，该仓库按无分支处理：${dir}：${error instanceof Error ? error.message : String(error)}`);
		return { branch: null, head: null };
	}
}

/**
 * 枚举一个仓库的工作树并构造节点，不挂子模块。
 *
 * 读公共目录下的工作树登记项，不起 git 子进程。自身那一项跳过；工作树目录已删除而登记项
 * 仍在时照常列出，标记为不可用。
 *
 * @param dir - 仓库根。
 * @returns 工作树节点列表（不含自身）。
 */
async function worktreesOf(dir: string): Promise<RepoNode[]> {
	const commonDir = await resolveGitCommonDir(dir);
	if (commonDir === null) return [];
	const selfId = nodeId(dir);
	const nodes: RepoNode[] = [];
	try {
		const records = await readWorktrees(commonDir);
		for (const worktree of records) {
			if (worktree.bare || nodeId(worktree.path) === selfId) continue;
			nodes.push({
				id: nodeId(worktree.path), path: worktree.path, name: basename(worktree.path),
				kind: 'worktree', depth: 1, branch: worktree.branch, head: worktree.head,
				available: await gitDirAt(worktree.path) !== null, children: [],
			});
		}
	} catch (error) {
		// 工作树枚举失败不影响仓库节点，但会让工作树节点缺失，需要留痕。
		logDebug('repo', `枚举工作树失败，该仓库按无工作树处理：${error instanceof Error ? error.message : String(error)}`);
	}
	return nodes;
}

/**
 * 判定仓库是否可能带链接工作树。
 *
 * 纯文件系统判定，不调用 git：解析仓库的 git 公共目录，再看其 `worktrees` 目录是否存在且非空。
 * 链接工作树记录只存在于该目录下，因此目录缺失或为空即可断定没有链接工作树。
 *
 * @param repo - 仓库根或工作树根路径。
 * @returns `none` 表示确定没有链接工作树；`some` 表示存在记录；`unknown` 表示无法解析 git 目录。
 */
export async function linkedWorktreePresence(repo: string): Promise<'none' | 'some' | 'unknown'> {
	const commonDir = await resolveGitCommonDir(repo);
	if (commonDir === null) return 'unknown';
	try {
		const entries = await readdir(join(commonDir, 'worktrees'));
		return entries.length > 0 ? 'some' : 'none';
	} catch {
		return 'none';
	}
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
		for (const relativePath of submodulePathsWithin(dir, parseSubmodulePaths(source))) {
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
 * @param shallow - 只产出顶层节点时为 true，不枚举工作树与子模块。
 * @returns 仓库节点。
 */
export async function repoNodeOf(
	dir: string,
	depth: number,
	submoduleIds: Set<string>,
	shallow = false,
): Promise<RepoNode> {
	const head = await headOf(dir);
	const node: RepoNode = {
		id: nodeId(dir), path: dir, name: basename(dir) || dir, kind: 'repo', depth,
		branch: head.branch, head: head.head, available: true, children: [],
	};
	if (shallow) return node;
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
 * 判定仓库是否没有任何可补齐的子节点来源。
 *
 * 判定只走文件系统，且只对 `.git` 为目录的仓库生效：`.git` 为文件时（链接工作树、子模块）
 * 主工作树要从 `core.worktree` 推导，这类路径一律走完整枚举。
 *
 * `.git` 为目录且没有链接工作树记录、也没有 `.gitmodules` 时，工作树与子模块枚举都只会
 * 得到空结果。
 *
 * @param dir - 仓库根。
 * @returns 无需枚举工作树与子模块时为 true。
 */
async function hasNoChildSources(dir: string): Promise<boolean> {
	if (await gitEntryOf(dir) !== 'dir') return false;
	if (await linkedWorktreePresence(dir) !== 'none') return false;
	try {
		await stat(join(dir, '.gitmodules'));
		return false;
	} catch {
		return true;
	}
}

/**
 * 为顶层仓库路径补齐工作树与子模块。
 *
 * 每个路径构造一个完整仓库节点（含工作树登记项枚举的工作树与 `.gitmodules` 声明的子模块），
 * 与完整扫描得到的节点结构一致；不是仓库的路径被忽略。
 *
 * 没有链接工作树、也没有 `.gitmodules` 的仓库不读工作树登记：这类仓库的两个来源都必然为空。
 *
 * @param repos - 顶层仓库路径，按入参顺序去重。
 * @returns 仓库节点列表，顺序与去重后的入参一致。
 */
export async function enrichRepositories(repos: readonly string[]): Promise<RepoNode[]> {
	const submoduleIds = new Set<string>();
	const visited = new Set<string>();
	const candidates = dedupeCandidates(repos, visited, submoduleIds);
	const entries = await Promise.all(candidates.map((dir) => hasGitEntry(dir)));
	const repoDirs = candidates.filter((dir, index) => entries[index]);
	const trivial = await Promise.all(repoDirs.map((dir) => hasNoChildSources(dir)));
	const targets = repoDirs.map((dir, index) => ({ dir, trivial: trivial[index] }));
	return Promise.all(targets.map((target) => repoNodeOf(target.dir, 0, submoduleIds, target.trivial)));
}
