/**
 * GitHub 提交页地址：从远端列表里取 GitHub 仓库。
 */
import type { Remote } from '../types.ts';

/**
 * 取远端列表里 GitHub 仓库的提交页地址。
 *
 * @param remotes - 远端列表。
 * @param hash - 提交哈希。
 * @returns 提交页地址；没有 GitHub 远端时返回 null。
 */
export function githubCommitUrl(remotes: readonly Remote[], hash: string): string | null {
	const ordered = [...remotes].sort((left, right) => (right.name === 'origin' ? 1 : 0) - (left.name === 'origin' ? 1 : 0));
	for (const remote of ordered) {
		const url = typeof remote.url === 'string' ? remote.url.trim().replace(/\/+$/, '') : '';
		const match = /^(?:https?:\/\/|git@)(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
		if (match !== null) return `https://github.com/${match[1]}/${match[2]}/commit/${hash}`;
	}
	return null;
}
