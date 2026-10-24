/**
 * 工作树登记与「别的工作树占用的分支」判定。
 *
 * 工作树登记在 git 公共目录的 `worktrees` 下：每一项是一个目录，`gitdir` 指向工作树的
 * `.git` 文件、`HEAD` 给出该工作树的分支。因此枚举工作树读文件即可，不需要
 * `git worktree list`。判定与 git 调用分离，便于直接单测。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** `HEAD` 文件的解析结果。 */
export interface HeadRef {
	/** 指向的分支名；分离头指针时为 null。 */
	readonly branch: string | null;
	/** 分离头指针的提交哈希；指向分支时为 null。 */
	readonly hash: string | null;
}

/** 一条工作树记录。 */
export interface WorktreeRecord {
	/** 工作树路径。 */
	readonly path: string;
	/** 检出的分支名；分离头指针为 null。 */
	readonly branch: string | null;
	/** 提交短哈希。 */
	readonly head: string | null;
	/** 是否为裸仓库；此时 `path` 是裸仓库的 git 目录。 */
	readonly bare: boolean;
}

/** git 配置文件里 `core` 段的两项取值。 */
export interface CoreConfig {
	/** `core.bare`；缺省为 false。 */
	readonly bare: boolean;
	/** `core.worktree` 的原文；缺省为 null。 */
	readonly worktree: string | null;
}

/** 把 git 配置值去掉引号并还原转义。 */
function unquote(value: string): string {
	if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
	return value.slice(1, -1).replace(/\\([\\"])/g, '$1');
}

/** 把 `core.bare` 的文本按 git 的布尔写法求值。 */
function toBoolean(value: string): boolean {
	const text = value.toLowerCase();
	return !(text === '' || text === 'false' || text === 'no' || text === 'off' || text === '0');
}

/**
 * 解析 git 配置文件里的 `core` 段。
 *
 * 只取 `bare` 与 `worktree` 两项：段名与键名大小写不敏感，值可带引号，整行注释与反斜杠
 * 续行按 git 的写法处理。子段（`[core "name"]`）与其它段一律忽略。
 *
 * @param source - 配置文件正文。
 * @returns `core.bare` 与 `core.worktree`。
 */
export function parseCoreConfig(source: string): CoreConfig {
	let bare = false;
	let worktree: string | null = null;
	let inCore = false;
	let buffer = '';
	for (const raw of source.split(/\r?\n/)) {
		buffer += raw;
		if (buffer.endsWith('\\')) {
			buffer = buffer.slice(0, -1);
			continue;
		}
		const text = buffer.trim();
		buffer = '';
		if (text === '' || text.startsWith('#') || text.startsWith(';')) continue;
		const section = /^\[([^\]\s.]+)(?:\s+"[^"]*")?\]$/.exec(text);
		if (section !== null) {
			// 带子段名的写法（`[core "x"]`）是 `core.x.*`，不是 `core` 段。
			const named = /^\[[^\]]*\s+"/.test(text);
			inCore = !named && section[1].toLowerCase() === 'core';
			continue;
		}
		if (!inCore) continue;
		const at = text.indexOf('=');
		const key = (at === -1 ? text : text.slice(0, at)).trim().toLowerCase();
		const value = at === -1 ? 'true' : unquote(text.slice(at + 1).trim());
		if (key === 'bare') bare = toBoolean(value);
		else if (key === 'worktree') worktree = value;
	}
	return { bare, worktree };
}

/**
 * 把工作树里 `.git` 文件的绝对路径还原成工作树根。
 *
 * 工作树登记里的 `gitdir` 记的就是 `<工作树>/.git`；`worktree.useRelativePaths` 打开时
 * 记为相对路径，调用方先按登记目录解析成绝对路径。
 *
 * @param gitDir - 工作树 `.git` 文件的绝对路径。
 * @returns 工作树根；路径不以 `.git` 结尾时为 null。
 */
export function worktreeRootOf(gitDir: string): string | null {
	const normalized = gitDir.replace(/\\/g, '/').replace(/\/+$/, '');
	const root = normalized.replace(/\/\.git$/i, '');
	return root === normalized || root === '' ? null : root;
}

/** 读一个 `HEAD` 文件的分支与短哈希。 */
async function readHeadRecord(headPath: string): Promise<{ branch: string | null; head: string | null }> {
	try {
		const ref = parseHeadRef(await readFile(headPath, 'utf8'));
		return { branch: ref.branch, head: ref.hash === null ? null : ref.hash.slice(0, 7) };
	} catch {
		return { branch: null, head: null };
	}
}

/** 读一个文件，失败时返回 null。 */
async function readTextFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf8');
	} catch {
		return null;
	}
}

/**
 * 枚举一个仓库的全部工作树。
 *
 * 主工作树由公共目录推导：`core.bare` 为真时是裸仓库，记一条 `bare` 记录；否则有
 * `core.worktree` 时按它解析、没有时取公共目录的父目录，并且只有该目录确实是工作树
 * （自身含 `.git` 条目）时才记一条。链接工作树逐个读 `worktrees` 下的登记项，工作树
 * 目录已删除而登记项仍在的记录照常列出，与 `git worktree list` 一致。
 *
 * @param commonDir - git 公共目录。
 * @returns 全部工作树记录，主工作树在首位（裸仓库时为 `bare` 记录）。
 */
export async function readWorktrees(commonDir: string): Promise<WorktreeRecord[]> {
	const config = parseCoreConfig((await readTextFile(join(commonDir, 'config'))) ?? '');
	const records: WorktreeRecord[] = [];
	if (config.bare) {
		records.push({ path: commonDir, ...(await readHeadRecord(join(commonDir, 'HEAD'))), bare: true });
	} else {
		const root = config.worktree === null ? dirname(commonDir) : resolve(commonDir, config.worktree);
		if (await gitDirAt(root) !== null) {
			records.push({ path: root, ...(await readHeadRecord(join(commonDir, 'HEAD'))), bare: false });
		}
	}
	const dir = join(commonDir, 'worktrees');
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return records;
	}
	const linked = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
		const recordDir = join(dir, entry.name);
		const pointer = await readTextFile(join(recordDir, 'gitdir'));
		if (pointer === null) return null;
		const target = pointer.trim();
		if (target === '') return null;
		const root = worktreeRootOf(resolve(recordDir, target));
		if (root === null) return null;
		return { path: root, ...(await readHeadRecord(join(recordDir, 'HEAD'))), bare: false };
	}));
	for (const record of linked) if (record !== null) records.push(record);
	return records;
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
	entries: readonly WorktreeRecord[],
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
 * 读取一个引用文件里的提交哈希。
 *
 * 松散引用位于 git 公共目录的 `refs` 下；打包引用在 `packed-refs` 里，每行形如
 * `<哈希> <引用名>`，首字符为 `#` 的行是注释、`^` 开头的行为附注标签的剥离目标，一并跳过。
 *
 * @param commonDir - git 公共目录。
 * @param refName - 完整引用名，如 `refs/heads/main`。
 * @returns 提交哈希；引用不存在时返回 null。
 */
async function readRefHash(commonDir: string, refName: string): Promise<string | null> {
	try {
		const loose = (await readFile(resolve(commonDir, refName), 'utf8')).trim();
		if (loose !== '') return loose;
	} catch {
		/* 松散引用不存在，回退打包引用 */
	}
	try {
		const packed = await readFile(resolve(commonDir, 'packed-refs'), 'utf8');
		for (const line of packed.split('\n')) {
			if (line === '' || line.startsWith('#') || line.startsWith('^')) continue;
			const space = line.indexOf(' ');
			if (space === -1) continue;
			if (line.slice(space + 1).trim() === refName) return line.slice(0, space);
		}
	} catch {
		/* 没有打包引用 */
	}
	return null;
}

/**
 * 读取仓库当前 HEAD 指向的提交哈希。
 *
 * 判定走文件系统，不起子进程：这是缓存键需要的高频取值。`HEAD` 指向分支时按分支引用解析，
 * 分离头指针时 `HEAD` 文件本身即哈希。
 *
 * @param repo - 仓库根或工作树根路径。
 * @returns 提交哈希；读不到时返回 null。
 */
export async function readHeadHash(repo: string): Promise<string | null> {
	const head = await readHeadRef(repo);
	if (head === null) return null;
	if (head.hash !== null) return head.hash;
	if (head.branch === null) return null;
	const commonDir = await resolveGitCommonDir(repo);
	if (commonDir === null) return null;
	return await readRefHash(commonDir, `refs/heads/${head.branch}`);
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
 * 由 git 目录解析其公共目录。
 *
 * `commondir` 文件给出公共目录相对于该 git 目录的路径；链接工作树与子模块据此回到公共目录。
 * 读不到该文件时公共目录即 git 目录本身。
 *
 * @param gitDir - git 目录的绝对路径。
 * @returns 公共目录的绝对路径。
 */
export async function gitCommonDirOf(gitDir: string): Promise<string> {
	try {
		const common = (await readFile(resolve(gitDir, 'commondir'), 'utf8')).trim();
		return common === '' ? gitDir : resolve(gitDir, common);
	} catch {
		return gitDir;
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
	return gitCommonDirOf(gitDir);
}

/**
 * 取一个 git 目录的相对路径解析基准目录。
 *
 * 链接工作树的 git 目录在公共目录的 `worktrees` 下，其中的 `gitdir` 文件指向工作树的
 * `.git` 文件，据此还原工作树根；子模块的 git 目录在 `modules` 下，工作区根由
 * `core.worktree` 给出；裸仓库没有工作区，基准即 git 目录本身。
 *
 * @param gitDir - git 目录的绝对路径。
 * @returns 基准目录的绝对路径。
 */
export async function workTreeBaseOf(gitDir: string): Promise<string> {
	const pointer = await readTextFile(join(gitDir, 'gitdir'));
	if (pointer !== null) {
		const target = pointer.trim();
		if (target !== '') {
			const root = worktreeRootOf(resolve(gitDir, target));
			if (root !== null) return root;
		}
	}
	const config = parseCoreConfig((await readTextFile(join(gitDir, 'config'))) ?? '');
	if (config.worktree !== null) return resolve(gitDir, config.worktree);
	if (config.bare) return gitDir;
	return dirname(gitDir);
}
