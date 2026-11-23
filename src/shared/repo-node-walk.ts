/**
 * 仓库节点树的遍历，宿主枚举与客户端预加载共用。
 *
 * 运行时无平台依赖，宿主与客户端各自打包。
 */
import type { RepoNode } from './repo-node.js';

/**
 * 按前序遍历仓库节点树。
 *
 * @param nodes - 根节点列表。
 * @param visit - 每个节点的回调。
 * @returns 无。
 */
export function walkRepoNodes(nodes: readonly RepoNode[], visit: (node: RepoNode) => void): void {
	for (const node of nodes) {
		visit(node);
		walkRepoNodes(node.children, visit);
	}
}
