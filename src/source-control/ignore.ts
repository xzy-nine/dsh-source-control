/**
 * 忽略规则的写入：最近的 `.gitignore`，以及仓库的本地排除文件 `.git/info/exclude`。
 *
 * 目标是当前工作树（子模块与链接工作树都以自身为仓库根），向上搜索不越过传入的仓库路径，
 * 找不到 `.gitignore` 时在仓库根新建。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { gitOrThrow, runGit } from './working-tree.js';
import { appendIgnoreRule, hasIgnoreRule, ignoreEntriesOf, ignoreRuleOf, isIgnorableTarget, normalizeIgnoreTarget } from './ignore-rules.js';

/** 写入 `.gitignore` 的结果。 */
export interface IgnoreWriteResult {
	/** 规则写入的文件，相对仓库根，使用 `/` 分隔。 */
	readonly file: string;
	/** 该文件是否为本次新建。 */
	readonly created: boolean;
	/** 写入前该文件是否已在版本控制中：未跟踪时没有可比较的差异。 */
	readonly tracked: boolean;
	/** 本次写入的规则；规则已存在时为 null。 */
	readonly rule: string | null;
}

/** 本地排除文件的状态。 */
export interface LocalExcludeState {
	/** 排除文件的绝对路径。 */
	readonly path: string;
	/** 有效条目：已去掉空行与注释。 */
	readonly entries: readonly string[];
}

/**
 * 目标路径是否为目录。
 *
 * @param repo - 仓库根。
 * @param target - 相对仓库根的路径。
 * @returns 是目录时为 true。
 */
async function isDirectory(repo: string, target: string): Promise<boolean> {
	try {
		return (await fs.stat(nodePath.join(repo, target))).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 目标路径的父目录链，从最近的父目录排到仓库根（空串）。
 *
 * @param target - 相对仓库根的路径。
 * @returns 父目录列表。
 */
function parentDirsOf(target: string): string[] {
	const dirs: string[] = [];
	let dir = nodePath.posix.dirname(target);
	while (dir !== '.' && dir !== '/' && dir !== '') {
		dirs.push(dir);
		const parent = nodePath.posix.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	dirs.push('');
	return dirs;
}

/**
 * 读取文件内容；不存在时返回空串。
 *
 * @param file - 文件绝对路径。
 * @returns 文件内容。
 */
async function readIfExists(file: string): Promise<string> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return '';
	}
}

/**
 * 取相对仓库根的路径，使用 `/` 分隔。
 *
 * @param repo - 仓库根。
 * @param file - 文件绝对路径。
 * @returns 相对路径。
 */
function relativeToRepo(repo: string, file: string): string {
	return nodePath.relative(repo, file).split(nodePath.sep).join('/');
}

/**
 * 找到最近的 `.gitignore`。
 *
 * 从目标路径的父目录逐级向上到仓库根，取第一个已存在的；都没有时用仓库根的路径，标记为待新建。
 *
 * @param repo - 仓库根。
 * @param target - 相对仓库根的路径。
 * @returns 所在目录（相对仓库根）、文件绝对路径与文件是否已存在。
 */
async function nearestGitignore(repo: string, target: string): Promise<{ dir: string; file: string; exists: boolean }> {
	for (const dir of parentDirsOf(target)) {
		const file = nodePath.join(repo, dir, '.gitignore');
		try {
			await fs.access(file);
			return { dir, file, exists: true };
		} catch {
			/* 该层没有 .gitignore，继续向上 */
		}
	}
	return { dir: '', file: nodePath.join(repo, '.gitignore'), exists: false };
}

/**
 * 把路径写进最近的 `.gitignore`。
 *
 * @param repo - 仓库根。
 * @param filePath - 目标路径，相对仓库根。
 * @returns 写入结果；路径不合法时抛出错误。
 */
export async function addToGitignore(repo: string, filePath: string): Promise<IgnoreWriteResult> {
	const target = normalizeIgnoreTarget(filePath);
	if (!isIgnorableTarget(target)) throw new Error('该路径不在当前仓库内，无法写入忽略规则。');
	const folder = await isDirectory(repo, target);
	const { dir, file, exists } = await nearestGitignore(repo, target);
	const rule = ignoreRuleOf(dir === '' ? target : nodePath.posix.relative(dir, target), folder);
	const content = await readIfExists(file);
	const relative = relativeToRepo(repo, file);
	const tracked = (await runGit(['ls-files', '--error-unmatch', '--', relative], repo)).code === 0;
	if (rule === '' || hasIgnoreRule(content, rule)) {
		return { file: relative, created: false, tracked, rule: null };
	}
	await fs.writeFile(file, appendIgnoreRule(content, rule), 'utf8');
	return { file: relative, created: !exists, tracked, rule };
}

/**
 * 本地排除文件的绝对路径。
 *
 * `--git-path` 在链接工作树与子模块下同样给出正确的排除文件位置。
 *
 * @param repo - 仓库根。
 * @returns 排除文件绝对路径。
 */
export async function localExcludePath(repo: string): Promise<string> {
	const out = (await gitOrThrow(['rev-parse', '--git-path', 'info/exclude'], repo)).trim();
	if (out === '') throw new Error('无法定位本地排除文件。');
	return nodePath.isAbsolute(out) ? out : nodePath.resolve(repo, out);
}

/**
 * 读取本地排除文件的条目。
 *
 * @param repo - 仓库根。
 * @returns 排除文件路径与有效条目；文件不存在时条目为空。
 */
export async function localExcludeState(repo: string): Promise<LocalExcludeState> {
	const file = await localExcludePath(repo);
	return { path: file, entries: ignoreEntriesOf(await readIfExists(file)) };
}

/**
 * 把路径写进本地排除文件。
 *
 * @param repo - 仓库根。
 * @param filePath - 目标路径，相对仓库根。
 * @returns 写入后的状态；路径不合法时抛出错误。
 */
export async function addToLocalExclude(repo: string, filePath: string): Promise<LocalExcludeState> {
	const target = normalizeIgnoreTarget(filePath);
	if (!isIgnorableTarget(target)) throw new Error('该路径不在当前仓库内，无法写入本地排除。');
	const folder = await isDirectory(repo, target);
	const rule = ignoreRuleOf(target, folder);
	const file = await localExcludePath(repo);
	const content = await readIfExists(file);
	if (rule !== '' && !hasIgnoreRule(content, rule)) {
		await fs.mkdir(nodePath.dirname(file), { recursive: true });
		await fs.writeFile(file, appendIgnoreRule(content, rule), 'utf8');
	}
	return { path: file, entries: ignoreEntriesOf(await readIfExists(file)) };
}
