/**
 * git 钩子的探测与临时禁用判据。
 *
 * 提交钩子（`pre-commit`、`commit-msg`）与推送钩子（`pre-push`）的启用状态由三处决定：
 * `core.hooksPath` 指向的目录、`core.hooksPath` 为空时的 `<git 目录>/hooks`，以及钩子文件
 * 是否可执行。`--no-verify` 让本次调用跳过这些钩子，但不改配置。
 *
 * 探测只读文件系统，不调用 git。
 */
import { access, constants, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { gitCommonDirOf, resolveGitDir, workTreeBaseOf } from './worktree-branches.js';

/** 提交时会运行的钩子名；任一存在即可视为「提交钩子处于激活状态」。 */
const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg'] as const;

/** 推送时会运行的钩子名。 */
const PUSH_HOOKS = ['pre-push'] as const;

/** 钩子探测结果。 */
export interface HooksState {
	/** 存在可执行的提交钩子。 */
	readonly commit: boolean;
	/** 存在可执行的推送钩子。 */
	readonly push: boolean;
	/** 钩子目录的绝对路径；无法定位 git 目录时为 null。 */
	readonly directory: string | null;
}

/**
 * 判定一个文件是否可执行。
 *
 * Windows 上不可执行位不生效，存在即可执行；其余平台要求任一执行位。
 *
 * @param path - 文件路径。
 * @returns 可执行时为 true。
 */
async function isExecutableFile(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return false;
		if (process.platform === 'win32') return true;
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 解析钩子目录。
 *
 * `core.hooksPath` 非空时以它为准：绝对路径直接用，相对路径按工作树根解析（普通工作树按其工作树
 * 根，裸仓库按其 git 目录）。未配置时用 **git 公共目录**下的 `hooks`，因此链接工作树与子模块
 * 共用主仓库的钩子目录。
 *
 * @param repo - 仓库路径。
 * @param hooksPath - `core.hooksPath` 的取值；未配置为空串。
 * @returns 钩子目录的绝对路径；无法定位 git 目录时为 null。
 */
export async function resolveHooksDirectory(repo: string, hooksPath: string): Promise<string | null> {
	const gitDir = await resolveGitDir(repo);
	if (gitDir === null) return null;
	const configured = hooksPath.trim();
	if (configured !== '') {
		if (isAbsolute(configured)) return resolve(configured);
		return resolve(await workTreeBaseOf(gitDir), configured);
	}
	/*
	 * 钩子目录在**公共目录**下：链接工作树与子模块的 git 目录是 `worktrees/<name>` 或
	 * `modules/<name>`，实际的 hooks 目录由公共目录提供。
	 */
	return join(await gitCommonDirOf(gitDir), 'hooks');
}

/**
 * 探测仓库的钩子状态。
 *
 * @param repo - 仓库路径。
 * @param hooksPath - `core.hooksPath` 的取值；未配置为空串。
 * @returns 钩子状态。
 */
export async function detectHooks(repo: string, hooksPath: string): Promise<HooksState> {
	const directory = await resolveHooksDirectory(repo, hooksPath);
	if (directory === null) return { commit: false, push: false, directory: null };
	const has = async (names: readonly string[]): Promise<boolean> => {
		for (const name of names) {
			if (await isExecutableFile(join(directory, name))) return true;
		}
		return false;
	};
	const [commit, push] = await Promise.all([has(COMMIT_HOOKS), has(PUSH_HOOKS)]);
	return { commit, push, directory };
}
