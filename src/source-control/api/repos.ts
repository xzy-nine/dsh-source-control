/**
 * 仓库发现与仓库树取数命令：发现、补齐、单仓库与批量领先/落后。
 */
import { discoverWorkspace, enrichRepositories, loadRepoSync, loadReposSync } from '../repo-discovery.js';
import { watchRepositories, watchWorkspace } from '../repo-watcher.js';
import { whenWorktreeIdle } from '../git-exec.js';
import type { RepoNode } from '../repo-discovery.js';
import type { ApiContext } from './context.js';

/**
 * 取节点树里全部可用节点的路径。
 *
 * 只有磁盘上确实存在的节点才纳入：目录已删除的工作树与子模块留在监视集合里，会让此后每一条
 * 名字缺失的事件都判定为仓库集合变化。
 *
 * @param nodes - 仓库节点列表。
 * @returns 全部可用路径，含工作树与子模块。
 */
function flattenRepoPaths(nodes: readonly RepoNode[]): string[] {
	const paths: string[] = [];
	const walk = (list: readonly RepoNode[]): void => {
		for (const node of list) {
			if (node.available) paths.push(node.path);
			walk(node.children);
		}
	};
	walk(nodes);
	return paths;
}

/**
 * 处理仓库发现与同步取数的一条命令。
 *
 * @param ctx - 命令上下文。
 * @returns 是否已处理；未识别的命令返回 false。
 */
export async function handleRepoCommand(ctx: ApiContext): Promise<boolean> {
	const { repo, bool, num, arr, respondResult } = ctx;
	switch (ctx.command) {
		case 'discoverRepositories':
			await respondResult('discoverRepositories', async () => {
				// knownRepos 命中时走快路径：只核对已知路径，不逐层扫描目录。
				const knownRepos = arr<string>('knownRepos').filter((path) => typeof path === 'string' && path !== '');
				const result = await discoverWorkspace(repo, {
					shallow: bool('shallow'),
					fullScan: bool('fullScan'),
					maxDepth: num('maxDepth', 3),
					knownRepos: knownRepos.length > 0 ? knownRepos : undefined,
				});
				// 顶层仓库纳入结构监视：工作树与子模块的增删由此即时反映。
				watchRepositories(result.nodes.filter((node) => node.kind === 'repo').map((node) => node.path));
				// 工作区根本身纳入监视：新建或删除的仓库此前没有任何句柄，只能由这一层发现。
				watchWorkspace(repo);
				return { root: repo, nodes: result.nodes, truncated: result.truncated, usedCache: result.usedCache };
			});
			break;
		case 'enrichRepositories':
			await respondResult('enrichRepositories', async () => {
				// 入参为空时不扫目录：nodes 为空数组。
				const repos = arr<string>('repos').filter((path) => typeof path === 'string' && path !== '');
				if (repos.length === 0) return { nodes: [] };
				const nodes = await enrichRepositories(repos);
				// 补齐结果里的工作树与子模块同样纳入监视：它们的登记项增删要即时反映。
				watchRepositories(flattenRepoPaths(nodes));
				return { nodes };
			});
			break;
		case 'loadRepoSync':
			await respondResult('loadRepoSync', async () => {
				// 读引用，不碰工作区：抓取期间照常读。
				await whenWorktreeIdle(repo);
				const sync = await loadRepoSync(repo);
				return { repo, branch: sync.branch, upstream: sync.upstream, ahead: sync.ahead, behind: sync.behind };
			});
			break;
		case 'loadReposSync':
			await respondResult('loadReposSync', async () => {
				// 入参路径逐个回显：结果按 path 与入参一一对应。
				const repos = arr<string>('repos').filter((path) => typeof path === 'string' && path !== '');
				// 空列表不读仓库：results 为空数组。
				if (repos.length === 0) return { repo, results: [] };
				await whenWorktreeIdle(repo);
				return { repo, results: await loadReposSync(repos) };
			});
			break;
		default:
			return false;
	}
	return true;
}