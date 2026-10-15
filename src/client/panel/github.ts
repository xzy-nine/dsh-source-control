/**
 * GitHub 远端判定：从远端列表里取仓库标识、提交页地址与远程名。
 *
 * 识别的地址形态：`https://github.com/owner/repo.git`、`git@github.com:owner/repo.git`
 * 与 `ssh://git@github.com/owner/repo.git`。
 */
import type { Remote } from '../shared/types.ts';

/** 从远端 URL 里取 GitHub 的 `owner/repo`。 */
const GITHUB_REMOTE = /^(?:https?:\/\/|ssh:\/\/|git@)(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/;

/**
 * 取远端 URL 的规范化文本。
 *
 * @param remote - 远端条目。
 * @returns 去掉首尾空白与末尾斜杠的 URL；未配置时为空串。
 */
function remoteUrlOf(remote: Remote): string {
	return typeof remote.url === 'string' ? remote.url.trim().replace(/\/+$/, '') : '';
}

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
		const match = GITHUB_REMOTE.exec(remoteUrlOf(remote));
		if (match !== null) return `https://github.com/${match[1]}/${match[2]}/commit/${hash}`;
	}
	return null;
}

/**
 * 远端列表里是否有 GitHub 仓库。
 *
 * @param remotes - 远端列表。
 * @returns 存在 GitHub 远端时为 true。
 */
export function hasGitHubRemote(remotes: readonly Remote[]): boolean {
	return remotes.some((remote) => GITHUB_REMOTE.test(remoteUrlOf(remote)));
}

/**
 * 远端列表里指向 GitHub 的远程名。
 *
 * @param remotes - 远端列表。
 * @returns 远程名集合。
 */
export function githubRemoteNames(remotes: readonly Remote[]): ReadonlySet<string> {
	const names = new Set<string>();
	for (const remote of remotes) {
		if (GITHUB_REMOTE.test(remoteUrlOf(remote))) names.add(remote.name);
	}
	return names;
}

/**
 * 远程分支标记所属的远程名。
 *
 * 远程分支短名的形态是 `远程名/分支名`。
 *
 * @param branch - 远程分支短名。
 * @returns 远程名；无法拆出时为空串。
 */
export function remoteNameOfBranch(branch: string): string {
	const separator = branch.indexOf('/');
	return separator <= 0 ? '' : branch.slice(0, separator);
}
