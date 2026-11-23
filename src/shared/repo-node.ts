/**
 * 仓库树节点：宿主枚举与客户端渲染共用同一数据形状。
 *
 * 运行时无平台依赖，宿主与客户端各自打包。
 */

/** 节点种类：主工作树仓库、链接工作树、子模块。 */
export type RepoNodeKind = 'repo' | 'worktree' | 'submodule';

/** 一个仓库、工作树或子模块节点。 */
export interface RepoNode {
	/** 规范化绝对路径派生的稳定标识。 */
	readonly id: string;
	/** 节点绝对路径。 */
	readonly path: string;
	/** 末段目录名。 */
	readonly name: string;
	/** 节点种类。 */
	readonly kind: RepoNodeKind;
	/** 展示缩进层级。 */
	readonly depth: number;
	/** 当前分支；分离头指针为 null。 */
	readonly branch: string | null;
	/** 分离头指针时的提交短哈希；已检出的子模块同样提供。 */
	readonly head: string | null;
	/** 路径在磁盘上是否存在。 */
	readonly available: boolean;
	/** 该节点所属仓库是否为浅克隆：历史被截断，浅克隆之外的分支与标签不可见。 */
	readonly shallowClone: boolean;
	/** 工作树与子模块。 */
	readonly children: RepoNode[];
}
