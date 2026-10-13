/**
 * DSH 版 Git Graph 的 git 执行层：在指定仓库中以数组参数跑 git，无 shell。
 *
 * 工作区变更（状态、暂存、提交、工作树）在此实现；提交图查询与各类操作见
 * `git-query.ts` 与 `git-actions.ts`，两者共用这里的执行与错误处理。
 */
import { spawn } from 'node:child_process';

/** 一次 git 调用的结果。 */
export interface GitResult {
	/** 退出码；被信号终止时为 -1。 */
	readonly code: number;
	/** 标准输出（按 UTF-8 解码）。 */
	readonly stdout: string;
	/** 标准错误（按 UTF-8 解码）。 */
	readonly stderr: string;
}

/** 仓库尚无提交时 `git restore --staged` 的报错；git 会给出带引号的 HEAD。 */
const NO_HEAD_PATTERN = /could not resolve ['"]?HEAD['"]?|unknown revision|ambiguous argument ['"]?HEAD['"]?/i;

/**
 * 子进程环境：在父进程环境上禁用凭据交互与分页。
 *
 * `GIT_TERMINAL_PROMPT=0` 让缺凭据的远程操作直接失败，而不是挂在等待输入上；
 * `GIT_PAGER` 兜住 git 误判为交互终端的场合。
 *
 * @returns 传给子进程的环境变量。
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: '0',
		GIT_PAGER: 'cat',
		GIT_EDITOR: 'true',
	};
}

/** 一条工作区变更：索引与工作区各自的状态码。 */
export interface WorkingTreeEntry {
	/** 当前路径，相对仓库根，使用 `/` 分隔。 */
	readonly path: string;
	/** 重命名/复制前的路径；其余情况为 null。 */
	readonly origPath: string | null;
	/** 索引状态码（`git status --porcelain` 的第一列）。 */
	readonly index: string;
	/** 工作区状态码（第二列）。 */
	readonly worktree: string;
}

/**
 * 运行一次 git。
 *
 * 子进程无法启动（git 不在 PATH、工作目录不存在）时不抛错，而是以退出码 -1 与
 * stderr 为异常文本返回，使调用方的错误处理与 git 自身失败走同一条路径。
 *
 * @param args - 参数数组，按原样传给 git（不经过 shell）。
 * @param cwd - 工作目录，必须是仓库或其子目录。
 * @returns 退出码与输出。
 */
export function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
	return new Promise((resolve) => {
		const child = spawn('git', [...args], { cwd, windowsHide: true, env: gitEnvironment() });
		let stdout = '';
		let stderr = '';
		let settled = false;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => { stdout += chunk; });
		child.stderr.on('data', (chunk: string) => { stderr += chunk; });
		child.on('error', (error: Error) => {
			if (settled) return;
			settled = true;
			resolve({ code: -1, stdout, stderr: stderr !== '' ? stderr : error.message });
		});
		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			resolve({ code: code === null ? -1 : code, stdout, stderr });
		});
	});
}

/**
 * 运行一次 git，非零退出码时抛出携带 stderr 的错误。
 *
 * @param args - 参数数组。
 * @param cwd - 工作目录。
 * @returns 标准输出。
 */
export async function gitOrThrow(args: readonly string[], cwd: string): Promise<string> {
	const result = await runGit(args, cwd);
	if (result.code !== 0) {
		// 走查错误信息，git 的失败原因在 stderr；为空时退回 stdout。
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0] ?? ''} 执行失败`);
	}
	return result.stdout;
}

/**
 * 解析 `git status --porcelain -z` 的输出。
 *
 * 记录格式为 `XY PATH`，重命名/复制时追加 `ORIG` 记录；`-z` 以 NUL 分隔，路径不做转义。
 *
 * @param stdout - git 的标准输出。
 * @returns 工作区变更列表。
 */
export function parseStatus(stdout: string): WorkingTreeEntry[] {
	const fields = stdout.split('\0');
	const entries: WorkingTreeEntry[] = [];
	let index = 0;
	while (index < fields.length) {
		const record = fields[index];
		index++;
		if (record === undefined || record.length < 4) break;
		const indexStatus = record.slice(0, 1);
		const worktreeStatus = record.slice(1, 2);
		const path = record.slice(3);
		let origPath: string | null = null;
		if (indexStatus === 'R' || indexStatus === 'C') {
			origPath = fields[index] ?? null;
			index++;
		}
		entries.push({ path, origPath, index: indexStatus, worktree: worktreeStatus });
	}
	return entries;
}

/**
 * 读取仓库的工作区变更。
 *
 * @param repo - 仓库路径。
 * @returns 变更列表，按路径排序。
 */
export async function loadWorkingTree(repo: string): Promise<WorkingTreeEntry[]> {
	const stdout = await gitOrThrow(['status', '--porcelain', '-z', '--untracked-files=all'], repo);
	return parseStatus(stdout).sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 暂存指定路径；不传路径时暂存全部变更。
 *
 * @param repo - 仓库路径。
 * @param paths - 要暂存的路径。
 * @returns 无。
 */
export function stagePaths(repo: string, paths: readonly string[]): Promise<string> {
	return paths.length === 0
		? gitOrThrow(['add', '--all'], repo)
		: gitOrThrow(['add', '--', ...paths], repo);
}

/**
 * 取消暂存指定路径；不传路径时取消全部。
 *
 * `git restore` 没有 `--all` 选项，取消全部用 pathspec `.`。
 * 仓库尚无提交（没有 HEAD）时 `restore --staged` 需要 HEAD 才能工作，退回从索引移除。
 *
 * @param repo - 仓库路径。
 * @param paths - 要取消暂存的路径。
 * @returns 无。
 */
export async function unstagePaths(repo: string, paths: readonly string[]): Promise<string> {
	// 空数组表示全部：restore 与 rm 都用 `.` 这个 pathspec。
	const target = paths.length === 0 ? ['.'] : [...paths];
	try {
		return await gitOrThrow(['restore', '--staged', '--', ...target], repo);
	} catch (error) {
		// 走查错误信息：仅当仓库没有 HEAD 时才退回 rm --cached，其余失败原样抛出。
		// git 的实际措辞带引号（could not resolve 'HEAD'），正则因此不能写死无引号形式。
		const message = error instanceof Error ? error.message : String(error);
		if (!NO_HEAD_PATTERN.test(message)) throw error;
		return gitOrThrow(['rm', '--cached', '-r', '--quiet', '--', ...target], repo);
	}
}

/**
 * 提交暂存区内容。
 *
 * @param repo - 仓库路径。
 * @param message - 提交信息。
 * @param amend - 是否修补上一次提交。
 * @returns 新提交的完整哈希。
 */
export async function commitStaged(repo: string, message: string, amend: boolean): Promise<string> {
	const args = ['commit', '-m', message];
	if (amend) args.push('--amend');
	await gitOrThrow(args, repo);
	return (await gitOrThrow(['rev-parse', 'HEAD'], repo)).trim();
}

/**
 * 丢弃指定路径的工作区改动。
 *
 * 未跟踪文件用 `git clean` 删除，已跟踪文件用 `git restore` 还原到 HEAD。
 *
 * @param repo - 仓库路径。
 * @param paths - 要丢弃的路径。
 * @param untracked - 这些路径是否都是未跟踪文件。
 * @returns 无。
 */
export async function discardPaths(repo: string, paths: readonly string[], untracked: boolean): Promise<string> {
	if (untracked) return gitOrThrow(['clean', '-f', '--', ...paths], repo);
	return gitOrThrow(['restore', '--', ...paths], repo);
}

/**
 * 移除一个链接工作树。
 *
 * 主工作树不能被移除（git 报 `is a main working tree`）。工作树内有未提交改动时 git 会
 * 拒绝并要求 `--force`；目录已不存在时 git 会直接清理登记项，因此两种情况都不需要重试。
 *
 * @param repo - 仓库路径（任意工作树均可）。
 * @param worktreePath - 要移除的工作树路径。
 * @param force - 是否强制移除有改动的工作树。
 * @returns 无。
 */
export async function removeWorktree(repo: string, worktreePath: string, force: boolean): Promise<void> {
	const args = force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath];
	await gitOrThrow(args, repo);
}
