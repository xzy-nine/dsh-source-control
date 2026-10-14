/**
 * 客户端领域类型：宿主返回的数据形状与面板内部使用的结构。
 */

/** 提交引用标记（分支/远程/标签）。 */
export interface CommitTag {
	readonly name: string;
}

/** 远程分支引用标记。 */
export interface CommitRemote {
	readonly name: string;
	readonly remote?: string;
}

/** 贮藏引用标记。 */
export interface CommitStash {
	readonly selector?: string;
}

/** 一条提交。 */
export interface Commit {
	/** 完整哈希；`*` 表示工作区未提交变更的伪提交。 */
	readonly hash: string;
	/** 父提交哈希。 */
	readonly parents?: readonly string[];
	/** 指向该提交的本地分支。 */
	readonly heads?: readonly string[];
	/** 指向该提交的远程分支。 */
	readonly remotes?: readonly CommitRemote[];
	/** 指向该提交的标签。 */
	readonly tags?: readonly CommitTag[];
	/** 贮藏标记；非贮藏提交为 null。 */
	readonly stash?: CommitStash | null;
	/** 提交信息。 */
	readonly message?: string;
	/** 作者名。 */
	readonly author?: string;
	/** 作者邮箱。 */
	readonly email?: string;
	/** 提交时间（秒）。 */
	readonly date?: number;
}

/** 工作区变更条目。 */
export interface WorkingTreeEntry {
	/** 当前路径，相对仓库根，使用 `/` 分隔。 */
	readonly path: string;
	/** 重命名/复制前的路径；其余为 null。 */
	readonly origPath?: string | null;
	/** 索引状态码。 */
	readonly index: string;
	/** 工作区状态码。 */
	readonly worktree: string;
}

/** 提交改动文件。 */
export interface CommitFile {
	/** 文件路径，相对仓库根。 */
	readonly path: string;
	/** 状态字符。 */
	readonly type: string;
	/** 新增行数；未知为 null。 */
	readonly additions: number | null;
	/** 删除行数；未知为 null。 */
	readonly deletions: number | null;
}

/** 仓库树的节点种类。 */
export type RepoNodeKind = 'repo' | 'worktree' | 'submodule';

/** 仓库树节点。 */
export interface RepoNode {
	/** 稳定标识。 */
	readonly id: string;
	/** 绝对路径。 */
	readonly path: string;
	/** 末段目录名。 */
	readonly name: string;
	/** 节点种类。 */
	readonly kind: RepoNodeKind;
	/** 展示缩进层级。 */
	readonly depth: number;
	/** 当前分支；分离头指针为 null。 */
	readonly branch: string | null;
	/** 提交短哈希；仅工作树枚举提供。 */
	readonly head: string | null;
	/** 路径在磁盘上是否存在。 */
	readonly available: boolean;
	/** 工作树与子模块。 */
	readonly children: RepoNode[];
}

/** 仓库领先/落后信息。 */
export interface RepoSync {
	readonly branch: string | null;
	readonly upstream: string | null;
	readonly ahead: number;
	readonly behind: number;
}

/** 远端条目。 */
export interface Remote {
	readonly name: string;
	readonly url?: string;
	readonly pushUrl?: string;
}

/** 日期格式设置。 */
export interface DateFormat {
	type: number;
	iso: boolean;
}

/** Issue 链接配置。 */
export interface IssueLinkingConfig {
	issueRegex?: string;
	issueUrlTemplate?: string;
}

/** 面板设置。 */
export interface Settings {
	commitOrdering: string;
	dateFormat: DateFormat;
	showStashes: boolean;
	showTags: boolean;
	showRemoteBranches: boolean;
	onlyFollowFirstParent: boolean;
	includeCommitsMentionedByReflogs: boolean;
	issueLinkingConfig: IssueLinkingConfig | null;
	markdown: boolean;
	muteMergeCommits: boolean;
	fetchAndPrune: boolean;
	fetchAndPruneTags: boolean;
	onRepoLoadScrollToHead: boolean;
	showAvatars: boolean;
	graphColours: readonly string[] | null;
	aiCommitProvider: string;
	aiCommitModel: string;
	aiCommitRules: string;
}

/** 提交改动统计。 */
export interface CommitStats {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
}

/** 引用列表项。 */
export interface RefItem {
	readonly name: string;
	readonly hash: string;
	readonly type: 'branch' | 'remote' | 'tag';
	readonly kind: string;
}

/** 提交行右键识别出的引用信息。 */
export interface RefInfo {
	readonly type: string | null;
	readonly name: string | null;
}

/** 面板加载阶段。 */
export type PanelPhase = 'loading' | 'ready' | 'no-workspace';

/** 面板状态。 */
export interface PanelState {
	phase: PanelPhase;
	error: string | null;
	commits: Commit[];
	head: string | null;
	more: boolean;
	entries: WorkingTreeEntry[];
	selectedHash: string | null;
	/**
	 * 展开的提交详情。
	 *
	 * `compareWith` 非空时 `files` 是两个提交之间的改动，方向为 `compareWith → commit`。
	 */
	detail: { commit: Commit; files: CommitFile[]; compareWith: Commit | null } | null;
	busy: boolean;
	remotes: Remote[];
}

/** AI 生成提交信息的用量统计。 */
export interface AiStats {
	readonly tps: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	/** 解码时长（总时长扣除首 token 延迟）。 */
	readonly elapsed: string;
	/** 首 token 延迟。 */
	readonly ttft: string;
}
