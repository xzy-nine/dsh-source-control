/**
 * 损坏子模块登记的识别与降级参数：工作区某个子模块的模块目录缺失或残缺时，git 会把整条
 * `status` / `diff` 判成失败。
 *
 * 判据是 git 的失败文本，随平台有两种形态：Windows 报 `fatal: not a git repository:
 * <被指向的 gitdir>`，gitdir 落在 `.git/modules/` 下；Linux 报 `fatal: gitfile does not
 * point to a valid repository: <子模块>/.git`。两者都表示子模块的 gitfile 指向的模块目录
 * 不可用，与仓库本身是否可用无关，降级后其余改动照常可读。
 *
 * 纯字符串与数组处理，不调用 git、不读文件系统，可直接单测。
 */

/**
 * 子模块模块目录不可用时的 git 失败文本形态。
 *
 * Windows 报 `not a git repository: <gitdir>`，gitdir 落在 `.git/modules/` 下；Linux 报
 * `gitfile does not point to a valid repository: <子模块>/.git`，指向子模块工作树的 gitfile。
 * git 拼接路径时用正斜杠，判据同时接受反斜杠以兼容宿主改写过的路径。
 */
const BROKEN_MODULE_PATTERNS: readonly RegExp[] = [
	/not a git repository:.*\.git\/modules\//i,
	/gitfile does not point to a valid repository:[^\r\n]*[\\/]\.git(?:[\\/\r\n]|$)/i,
];

/**
 * 判定一条 git 失败是否为「子模块的模块目录不可用」。
 *
 * 只认带路径的两种诊断：不带路径的 `not a git repository` 属于别的问题（工作目录不在
 * 仓库里、`.git` 被整体删除），降级对它没有帮助。
 *
 * @param stderr - git 的标准错误。
 * @returns 命中任一形态时为 true。
 */
export function isBrokenSubmoduleFailure(stderr: string): boolean {
	return BROKEN_MODULE_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * 子模块工作树内部改动不参与比较时要追加的参数。
 *
 * 取 `dirty` 而不是 `all`：已提交的 gitlink 移动（子模块指向的提交与索引不一致）属于本
 * 仓库的改动，照常报出。忽略的是子模块工作树内部的脏与未跟踪文件，而探测它们正是需要
 * 缺失的那个模块目录。
 */
export const IGNORE_SUBMODULE_DIRT = '--ignore-submodules=dirty';

/**
 * 判定参数里是否已有子模块忽略口径。
 *
 * 已有口径说明调用方自己做了取舍，再追加一条只会让两个口径叠在一起。
 *
 * @param args - git 参数。
 * @returns 含 `--ignore-submodules` 任一种写法时为 true。
 */
export function hasIgnoreSubmodulesFlag(args: readonly string[]): boolean {
	return args.some((arg) => arg === '--ignore-submodules' || arg.startsWith('--ignore-submodules='));
}

/**
 * 给一条 git 参数加上子模块工作树内部不参与比较的口径。
 *
 * 选项插在路径分隔符 `--` 的紧前一个位置：该分隔符之后的实参一律按路径解释。
 *
 * @param args - git 参数。
 * @returns 追加了口径的新数组；已有口径时原样复制。
 */
export function withIgnoredSubmoduleDirt(args: readonly string[]): string[] {
	if (hasIgnoreSubmodulesFlag(args)) return [...args];
	const separator = args.indexOf('--');
	return separator === -1
		? [...args, IGNORE_SUBMODULE_DIRT]
		: [...args.slice(0, separator), IGNORE_SUBMODULE_DIRT, ...args.slice(separator)];
}
