/**
 * 分区空态的判据：什么情况下三个分区都读不到仓库数据，以及唯一的下一步动作是什么。
 *
 * 判据是纯函数：面板据此同时决定更改区（含提交框）与图形区显示什么，两个分区因此不会一处显示
 * 空态、另一处显示取数占位。不依赖 React，可直接单测。
 */
import type { RepoNode } from '../shared/types.ts';

/** 空态里可执行的动作。 */
export type WorkspaceEmptyAction = 'init-workspace' | 'init-submodule' | 'none';

/** 一块分区空态。 */
export interface WorkspaceEmpty {
	/** 一句话结论。 */
	readonly title: string;
	/** 说明当前为何读不到仓库数据。 */
	readonly description: string;
	/** 主按钮文案；`none` 动作时为 null。 */
	readonly action: string | null;
	/** 主按钮的动作。 */
	readonly actionKind: WorkspaceEmptyAction;
	/** 动作的目标路径：初始化子模块时为子模块路径，其余为空串。 */
	readonly path: string;
}

/** 空态判据的入参。 */
export interface WorkspaceEmptyInput {
	/** 会话是否有工作区。 */
	readonly hasWorkspace: boolean;
	/** 仓库树是否仍在发现中。 */
	readonly treeLoading: boolean;
	/** 选中的节点；未选中时为 null。 */
	readonly selectedNode: RepoNode | null;
	/** 工作区根自身是否是一个仓库节点。 */
	readonly workspaceIsRepo: boolean;
}

/**
 * 取选中的节点读不到数据时的空态。
 *
 * @param node - 选中节点。
 * @returns 空态；节点可用时为 null。
 */
function unavailableNodeEmpty(node: RepoNode): WorkspaceEmpty | null {
	if (node.available) return null;
	if (node.kind === 'submodule') {
		return {
			title: `子模块 ${node.name} 尚未检出`,
			description: '该目录在当前磁盘上没有工作区，分支与提交都读不到。初始化后即可查看。',
			action: '初始化子模块',
			actionKind: 'init-submodule',
			path: node.path,
		};
	}
	return {
		title: `${node.name} 不在磁盘上`,
		description: '该目录已被删除或移动。刷新存储库区后这个节点会随之消失。',
		action: null,
		actionKind: 'none',
		path: node.path,
	};
}

/**
 * 取工作区里没有仓库时的空态。
 *
 * @param treeLoading - 仓库树是否仍在发现中。
 * @param workspaceIsRepo - 工作区根自身是否是一个仓库节点。
 * @returns 空态；仓库树仍在发现或工作区根已是仓库时为 null。
 */
function absentRepositoryEmpty(treeLoading: boolean, workspaceIsRepo: boolean): WorkspaceEmpty | null {
	if (treeLoading || workspaceIsRepo) return null;
	return {
		title: '该工作区还没有 git 仓库',
		description: '在工作区根初始化一个空仓库后，这里会显示更改与提交图。',
		action: '初始化仓库',
		actionKind: 'init-workspace',
		path: '',
	};
}

/**
 * 判定当前要显示的分区空态。
 *
 * 顺序即优先级：选中的节点读不到数据时先说明该节点；仓库树就绪且工作区里没有仓库时再说明工作区。
 * 两者都不成立时返回 null，各分区按自己的加载与就绪状态渲染。
 *
 * @param input - 见 {@link WorkspaceEmptyInput}。
 * @returns 空态；不需要空态时为 null。
 */
export function workspaceEmptyOf(input: WorkspaceEmptyInput): WorkspaceEmpty | null {
	if (!input.hasWorkspace) return null;
	if (input.selectedNode !== null) return unavailableNodeEmpty(input.selectedNode);
	return absentRepositoryEmpty(input.treeLoading, input.workspaceIsRepo);
}
