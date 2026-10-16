/**
 * `git worktree list --porcelain` 的解析与「别的工作树占用的分支」判定。
 *
 * 与 git 调用分离的纯逻辑，便于直接单测。
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/** 一条工作树记录。 */
export interface WorktreeEntry {
	/** 工作树路径。 */
	readonly path: string;
	/** 检出的分支名；分离头指针为 null。 */
	readonly branch: string | null;
	/** 提交短哈希。 */
	readonly head: string | null;
	/** 是否为裸仓库。 */
	readonly bare: boolean;
}

/**
 * 解析 `git worktree list --porcelain` 的输出。
 *
 * 记录以空行分隔；`worktree <path>` 开始一条记录，`bare` 标记裸仓库。
 *
 * @param stdout - git 的标准输出。
 * @returns 全部工作树记录（含裸仓库，由调用方决定是否过滤）。
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: { path: string; branch: string | null; head: string | null; bare: boolean } | null = null;
	const flush = (): void => {
		if (current !== null) entries.push(current);
		current = null;
	};
	for (const line of stdout.split(/\r?\n/)) {
		if (line === '') {
			flush();
			continue;
		}
		const at = line.indexOf(' ');
		const key = at === -1 ? line : line.slice(0, at);
		const value = at === -1 ? '' : line.slice(at + 1);
		if (key === 'worktree') {
			flush();
			current = { path: value, branch: null, head: null, bare: false };
			continue;
		}
		if (current === null) continue;
		if (key === 'HEAD') current.head = value.slice(0, 7);
		else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
		else if (key === 'bare') current.bare = true;
	}
	flush();
	return entries;
}

/**
 * 取被「别的工作树」检出的分支名。
 *
 * 一个分支同时只能被一个工作树检出。查看某个工作树时，别的工作树占用的分支不可删除
 * （git 报 `cannot delete branch ... used by worktree at ...`），需从候选与标签中排除；
 * 当前工作树自己的分支保留。
 *
 * @param entries - 工作树记录。
 * @param selfPath - 当前查看的工作树路径。
 * @param normalize - 路径规范化函数，用于跨平台比较。
 * @returns 被别的工作树占用的分支名集合。
 */
export function foreignWorktreeBranches(
	entries: readonly WorktreeEntry[],
	selfPath: string,
	normalize: (path: string) => string,
): Set<string> {
	const branches = new Set<string>();
	const self = normalize(selfPath);
	for (const entry of entries) {
		if (normalize(entry.path) === self) continue;
		if (entry.branch !== null && entry.branch !== '') branches.add(entry.branch);
	}
	return branches;
}

/**
 * 解析一个仓库的 git 公共目录（common dir）。
 *
 * 判定全部走文件系统，不调用 git：`.git` 为目录时即它本身；为文件时读其中的 `gitdir:` 指向；
 * 该目录内存在 `commondir` 文件时按其中的相对路径再解析一层，得到链接工作树与子模块共用的公共目录。
 *
 * @param repo - 仓库根或工作树根路径。
 * @returns 公共目录的绝对路径；路径不存在或格式不可识别时为 null。
 */
export async function resolveGitCommonDir(repo: string): Promise<string | null> {
	const gitEntry = resolve(repo, '.git');
	let gitDir: string;
	try {
		const info = await stat(gitEntry);
		if (info.isDirectory()) {
			gitDir = gitEntry;
		} else if (info.isFile()) {
			const pointer = await readFile(gitEntry, 'utf8');
			const line = pointer.split(/\r?\n/).find((entry) => entry.startsWith('gitdir:'));
			if (line === undefined) return null;
			const target = line.slice('gitdir:'.length).trim();
			if (target === '') return null;
			gitDir = resolve(repo, target);
		} else {
			return null;
		}
	} catch {
		return null;
	}

	try {
		const common = (await readFile(resolve(gitDir, 'commondir'), 'utf8')).trim();
		return common === '' ? gitDir : resolve(gitDir, common);
	} catch {
		return gitDir;
	}
}
