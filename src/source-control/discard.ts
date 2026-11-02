/**
 * 丢弃工作区改动：未跟踪文件、已跟踪文件与子模块条目。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { gitInPathBatches, runGit } from './git-exec.js';
import { GITLINK_MODE, parseIndexEntries } from './git-parse.js';
import { normalizeSlashes } from './submodule-ops.js';

/** 一次丢弃里一个子模块条目的结局。 */
export type SubmoduleDiscardStatus = 'moved' | 'unchanged' | 'blocked' | 'uninitialized';

/** 一次丢弃里一个子模块条目的处置结果。 */
export interface SubmoduleDiscardOutcome {
	/** 子模块路径，相对仓库根，`/` 分隔。 */
	readonly path: string;
	/**
	 * 结局：
	 * - `moved`：子模块 HEAD 已移动到索引记录的提交。
	 * - `unchanged`：HEAD 已是索引记录的提交，未做改动。
	 * - `blocked`：HEAD 需要移动，但 git 拒绝（通常是本地改动会被覆盖）。
	 * - `uninitialized`：子模块工作区未检出，未做任何操作。
	 */
	readonly status: SubmoduleDiscardStatus;
	/** 阻止移动的 git 原文；其余结局为 null。 */
	readonly reason: string | null;
	/** 处置后子模块工作区是否仍有未提交改动。 */
	readonly dirty: boolean;
}

/** 一次丢弃的结局。 */
export interface DiscardOutcome {
	/** 丢弃后该条目应从变更列表消失的路径。 */
	readonly discarded: readonly string[];
	/** 涉及的子模块条目及其结局。 */
	readonly submodules: readonly SubmoduleDiscardOutcome[];
	/** 未跟踪但未被删除的路径：其内是独立仓库，`git clean` 会跳过。 */
	readonly skippedRepositories: readonly string[];
}

/**
 * 丢弃指定路径的工作区改动。
 *
 * 未跟踪文件用 `git clean` 删除，已跟踪文件用 `git restore` 还原到索引内容。子模块条目
 * （索引模式 `160000`）不适用 `restore`：`restore` 对它只移动工作区的 HEAD，不保证成功且
 * 不会清理内部改动；这里改为显式移动子模块 HEAD，并且**不触碰子模块内部的未提交改动**，
 * 处置结局随返回值回报。
 *
 * @param repo - 仓库路径。
 * @param paths - 要丢弃的路径。
 * @param untracked - 这些路径是否都是未跟踪文件。
 * @returns 丢弃结局。
 */
export async function discardPaths(repo: string, paths: readonly string[], untracked: boolean): Promise<DiscardOutcome> {
	if (untracked) return discardUntracked(repo, paths);
	const gitlinks = await gitlinksIn(repo, paths);
	if (gitlinks.size === 0) {
		if (paths.length > 0) await gitInPathBatches(repo, (batch) => ['restore', '--', ...batch], paths);
		return { discarded: [...paths], submodules: [], skippedRepositories: [] };
	}
	// 子模块条目本身不交给 restore：目录型 pathspec 里它们的子路径仍要还原，因此只剔除精确匹配。
	const plain = paths.filter((path) => !gitlinks.has(normalizeSlashes(path)));
	if (plain.length > 0) await gitInPathBatches(repo, (batch) => ['restore', '--', ...batch], plain);
	/*
	 * 报告里只列变更列表的条目：包含子模块的目录是容器，不是条目，它自身不出现在变更列表里，
	 * 由其中的子模块路径代表。
	 */
	const containers = ancestorsOf([...gitlinks.keys()]);
	const discarded: string[] = plain.filter((path) => !containers.has(normalizeSlashes(path)));
	const submodules: SubmoduleDiscardOutcome[] = [];
	for (const [path, sha] of gitlinks) {
		const outcome = await discardSubmodule(repo, path, sha);
		submodules.push(outcome);
		// 只有处置后工作区干净的条目才会从变更列表消失：内部仍有改动时父仓库照常显示该行。
		const settled = outcome.status === 'moved' || outcome.status === 'unchanged';
		if (settled && !outcome.dirty) discarded.push(path);
	}
	return { discarded, submodules, skippedRepositories: [] };
}

/**
 * 取一组路径的全部上级目录。
 *
 * @param paths - 相对仓库根的路径。
 * @returns 上级目录路径集合。
 */
function ancestorsOf(paths: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const path of paths) {
		const segments = path.split('/');
		for (let index = 1; index < segments.length; index += 1) out.add(segments.slice(0, index).join('/'));
	}
	return out;
}

/**
 * 丢弃未跟踪路径。
 *
 * @param repo - 仓库路径。
 * @param paths - 未跟踪路径。
 * @returns 丢弃结局；仍存在的路径是 `git clean` 跳过的独立仓库。
 */
async function discardUntracked(repo: string, paths: readonly string[]): Promise<DiscardOutcome> {
	if (paths.length > 0) await gitInPathBatches(repo, (batch) => ['clean', '-f', '--', ...batch], paths);
	const discarded: string[] = [];
	const skippedRepositories: string[] = [];
	for (const path of paths) {
		if (await pathExists(nodePath.join(repo, ...normalizeSlashes(path).split('/')))) skippedRepositories.push(path);
		else discarded.push(path);
	}
	return { discarded, submodules: [], skippedRepositories };
}

/**
 * 取给定路径里属于子模块的条目。
 *
 * 路径既可以是子模块本身，也可以是包含子模块的目录：目录型 pathspec 命中的子模块同样要处置，
 * 否则对文件夹「丢弃改动」时子模块条目会静默留下。
 *
 * @param repo - 仓库路径。
 * @param paths - 要丢弃的路径。
 * @returns 子模块相对路径到索引记录提交哈希的映射，按路径顺序。
 */
async function gitlinksIn(repo: string, paths: readonly string[]): Promise<Map<string, string>> {
	const wanted = paths.map((path) => normalizeSlashes(path)).filter((path) => path !== '');
	const found = new Map<string, string>();
	if (wanted.length === 0) return found;
	const stdout = await gitInPathBatches(repo, (batch) => ['ls-files', '-s', '-z', '--', ...batch], paths);
	for (const entry of parseIndexEntries(stdout)) {
		if (entry.stage !== 0 || entry.mode !== GITLINK_MODE) continue;
		const hit = wanted.some((path) => entry.path === path || entry.path.startsWith(`${path}/`));
		if (!hit || found.has(entry.path)) continue;
		found.set(entry.path, entry.sha);
	}
	return found;
}

/**
 * 把一个子模块条目处置到索引记录的提交。
 *
 * 只移动 HEAD，不还原也不清理子模块内部的任何改动：工作区有改动时 git 仍会保留它们，
 * 改动会与目标提交冲突时 git 拒绝移动，此时按 `blocked` 回报原文。
 *
 * @param repo - 父仓库路径。
 * @param path - 子模块路径，相对仓库根。
 * @param sha - 索引记录的提交哈希。
 * @returns 处置结局。
 */
async function discardSubmodule(repo: string, path: string, sha: string): Promise<SubmoduleDiscardOutcome> {
	const dir = nodePath.join(repo, ...path.split('/'));
	if (!(await hasGitEntry(dir))) return { path, status: 'uninitialized', reason: null, dirty: false };
	// HEAD 与脏状态都跳过缓存：两者决定是否移动 HEAD，必须读到当前值。
	const head = await runGit(['rev-parse', 'HEAD'], dir, { noCache: true });
	if (head.code !== 0) return { path, status: 'uninitialized', reason: head.stderr.trim() || null, dirty: false };
	const dirty = await submoduleDirty(dir);
	if (head.stdout.trim() === sha) return { path, status: 'unchanged', reason: null, dirty };
	const checkout = await runGit(['checkout', '--detach', sha], dir);
	if (checkout.code !== 0) {
		return { path, status: 'blocked', reason: checkout.stderr.trim() || checkout.stdout.trim() || null, dirty };
	}
	return { path, status: 'moved', reason: null, dirty: await submoduleDirty(dir) };
}

/**
 * 子模块工作区是否有未提交改动。
 *
 * 跳过只读缓存：判定结果取决于工作区的当前内容，而插件之外的写（编辑器、外部命令）不会让
 * 缓存失效，命中缓存会读到改动前的旧值。
 *
 * @param dir - 子模块工作区路径。
 * @returns 有改动时为 true。
 */
async function submoduleDirty(dir: string): Promise<boolean> {
	const status = await runGit(['status', '--porcelain', '-z', '--untracked-files=all'], dir, { noCache: true });
	return status.code === 0 && status.stdout !== '';
}

/**
 * 路径是否存在。
 *
 * @param path - 绝对路径。
 * @returns 存在时为 true。
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * 目录里是否有 git 入口（`.git` 目录或文件）。
 *
 * @param dir - 目录路径。
 * @returns 存在时为 true。
 */
async function hasGitEntry(dir: string): Promise<boolean> {
	return pathExists(nodePath.join(dir, '.git'));
}
