/**
 * 终端克隆命令的构造。
 *
 * 命令只依赖 `git -C <父目录> clone -- <地址>`：不必切换终端当前目录，克隆结果落在父目录下
 * 与仓库同名的子目录里。两种 shell 的转义规则不同，含无法安全转义的字符时返回 null，
 * 由调用方提示手动执行。本模块只导入地址解析，供面板与单元测试直接使用。
 */
import { parseRemoteAddress } from './remote-url.ts';

/**
 * 仅在这些字符之外才自动生成命令：双引号、`$`、反引号、单引号与换行在 PowerShell 与
 * POSIX shell 中的转义规则不同，无法用同一段文本安全表达。
 */
const UNSAFE = /["$`'\r\n\0]/;

/**
 * 取仓库名：地址末段并去掉 `.git` 后缀。
 *
 * @param url - 远程地址。
 * @returns 仓库名；取不到时为空串。
 */
export function repositoryNameOf(url: string): string {
	const text = url.trim().replace(/[/\\]+$/, '');
	if (text === '') return '';
	const parsed = parseRemoteAddress(text);
	// 带 scheme 却没有仓库路径的地址（如 `https://github.com`）不是可克隆的地址。
	if (parsed === null && text.includes('://')) return '';
	const tail = parsed !== null ? parsed.path : text;
	const segments = tail.split(/[/\\]/).filter((segment) => segment !== '');
	const last = segments[segments.length - 1] ?? '';
	const name = last.endsWith('.git') ? last.slice(0, -'.git'.length) : last;
	return name === '' || name === '.' || name === '..' || /[\\/\0]/.test(name) ? '' : name;
}

/**
 * 克隆选项。
 *
 * 浅克隆只取最近的历史：`--depth=N` 把历史截断到 N 个提交，`--single-branch` 只取一个分支
 * （git 在指定 depth 时默认就会这样做，显式写出是为了不依赖版本差异）。`--no-tags` 一并
 * 关掉标签跟随，否则浅克隆仍会拉取指向截断范围之外的标签并失败。
 */
export interface CloneOptions {
	/** 浅克隆深度；0 表示完整克隆。 */
	readonly depth?: number;
}

/** 浅克隆深度的取值范围：git 要求正整数。 */
export const CLONE_DEPTH_MIN = 1;
export const CLONE_DEPTH_MAX = 100000;

/**
 * 构造浅克隆的参数片段。
 *
 * @param depth - 深度；0 或非法值表示不做浅克隆。
 * @returns 参数数组；非浅克隆时为空数组。
 */
export function shallowCloneArgs(depth: number | undefined): string[] {
	if (depth === undefined || !Number.isFinite(depth)) return [];
	const value = Math.floor(depth);
	if (value < CLONE_DEPTH_MIN) return [];
	return [`--depth=${Math.min(value, CLONE_DEPTH_MAX)}`, '--single-branch', '--no-tags'];
}

/**
 * 构造在终端里执行的克隆命令。
 *
 * @param parentDir - 用户选定的父目录。
 * @param url - 远程地址。
 * @param options - 见 {@link CloneOptions}。
 * @returns 命令文本；地址或目录不可安全表达时返回 null。
 */
export function cloneTerminalCommand(parentDir: string, url: string, options: CloneOptions = {}): string | null {
	const parent = parentDir.trim().replace(/[/\\]+$/, '');
	const source = url.trim();
	if (parent === '' || source === '' || source.startsWith('-')) return null;
	if (repositoryNameOf(source) === '') return null;
	if (UNSAFE.test(parent) || UNSAFE.test(source)) return null;
	const extra = shallowCloneArgs(options.depth);
	const flags = extra.length > 0 ? ` ${extra.join(' ')}` : '';
	return `git -C "${parent}" clone${flags} -- "${source}"`;
}
