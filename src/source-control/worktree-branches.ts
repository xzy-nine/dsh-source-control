/**
 * `git worktree list --porcelain` 的解析与「别的工作树占用的分支」判定。
 *
 * 与 git 调用分离的纯逻辑，便于直接单测。
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** `HEAD` 文件的解析结果。 */
export interface HeadRef {
	/** 指向的分支名；分离头指针时为 null。 */
	readonly branch: string | null;
	/** 分离头指针的提交哈希；指向分支时为 null。 */
	readonly hash: string | null;
}

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
 * 解析 `HEAD` 文件的内容。
 *
 * 内容有两种形态：`ref: refs/heads/<分支>` 表示指向某个分支；一串提交哈希表示分离头指针。
 *
 * @param content - `HEAD` 文件的正文。
 * @returns 分支名或提交哈希；无法识别时两者皆为 null。
 */
export function parseHeadRef(content: string): HeadRef {
	const text = content.trim();
	if (text === '') return { branch: null, hash: null };
	const refPrefix = 'ref:';
	if (text.startsWith(refPrefix)) {
		const target = text.slice(refPrefix.length).trim();
		if (target === '') return { branch: null, hash: null };
		return { branch: target.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : null, hash: null };
	}
	return /^[0-9a-fA-F]{7,64}$/.test(text) ? { branch: null, hash: text } : { branch: null, hash: null };
}

/**
 * 读取一个仓库的 `HEAD` 文件。
 *
 * 不调用 git：`HEAD` 位于该工作树自己的 git 目录下，`gitDirOf` 与 `resolveGitDir` 都能定位它。
 * 链接工作树与子模块的 `HEAD` 因此同样可读。
 *
 * @param repo - 仓库根或工作树根路径。
 * @returns HEAD 的解析结果；读不到时为 null。
 */
export async function readHeadRef(repo: string): Promise<HeadRef | null> {
	const gitDir = await resolveGitDir(repo);
	if (gitDir === null) return null;
	try {
		return parseHeadRef(await readFile(resolve(gitDir, 'HEAD'), 'utf8'));
	} catch {
		return null;
	}
}

/**
 * 取一个目录自身的 git 目录，不向上查找。
 *
 * `.git` 为目录时即它本身；为文件时读其中的 `gitdir:` 指向，该写法见于链接工作树与子模块。
 *
 * @param dir - 目录。
 * @returns git 目录绝对路径；该目录没有 `.git` 或格式不可识别时为 null。
 */
export async function gitDirAt(dir: string): Promise<string | null> {
	const gitEntry = join(dir, '.git');
	try {
		const info = await stat(gitEntry);
		if (info.isDirectory()) return gitEntry;
		if (!info.isFile()) return null;
		const pointer = await readFile(gitEntry, 'utf8');
		const line = pointer.split(/\r?\n/).find((row) => row.startsWith('gitdir:'));
		if (line === undefined) return null;
		const target = line.slice('gitdir:'.length).trim();
		return target === '' ? null : resolve(dir, target);
	} catch {
		return null;
	}
}

/**
 * 判定一个目录自身是否为裸仓库的 git 目录。
 *
 * 裸仓库没有 `.git`，判据与 git 一致：同时含 `HEAD` 文件与 `objects`、`refs` 目录。
 *
 * @param dir - 目录。
 * @returns 是裸仓库的 git 目录时为 true。
 */
async function isBareGitDir(dir: string): Promise<boolean> {
	try {
		const [head, objects, refs] = await Promise.all([
			stat(join(dir, 'HEAD')),
			stat(join(dir, 'objects')),
			stat(join(dir, 'refs')),
		]);
		return head.isFile() && objects.isDirectory() && refs.isDirectory();
	} catch {
		return false;
	}
}

/**
 * 解析一个仓库的 git 目录。
 *
 * 判定走文件系统，不调用 git。查找顺序与 git 一致：从给定目录起逐级向上，每级先看 `.git`
 * （目录，或链接工作树与子模块那种指向别处的文件），再判断该目录自身是否为裸仓库；
 * 因此传入仓库的子目录同样能定位到 git 目录。
 *
 * @param repo - 仓库根、工作树根或其子目录。
 * @returns git 目录的绝对路径；向上到文件系统根仍未找到时为 null。
 */
export async function resolveGitDir(repo: string): Promise<string | null> {
	let dir = resolve(repo);
	for (;;) {
		const found = await gitDirAt(dir);
		if (found !== null) return found;
		if (await isBareGitDir(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * 解析一个仓库的 git 公共目录（common dir）。
 *
 * 判定全部走文件系统，不调用 git：先由 {@link resolveGitDir} 得到 git 目录；该目录内存在
 * `commondir` 文件时按其中的相对路径再解析一层，得到链接工作树与子模块共用的公共目录。
 *
 * @param repo - 仓库根或工作树根路径。
 * @returns 公共目录的绝对路径；路径不存在或格式不可识别时为 null。
 */
export async function resolveGitCommonDir(repo: string): Promise<string | null> {
	const gitDir = await resolveGitDir(repo);
	if (gitDir === null) return null;

	try {
		const common = (await readFile(resolve(gitDir, 'commondir'), 'utf8')).trim();
		return common === '' ? gitDir : resolve(gitDir, common);
	} catch {
		return gitDir;
	}
}
