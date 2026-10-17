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
	/** 文件改动事件是否触发自动刷新。 */
	autoRefresh: boolean;
	/** 是否定时抓取远程。 */
	autoFetch: boolean;
	/** 定时抓取的间隔（秒）。 */
	autoFetchPeriod: number;
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

/** 提交哈希索引的四份缓存：统计、完整信息、译文与译文对应的原文。 */
export interface CommitCacheMaps {
	/** 提交哈希 -> 改动统计。 */
	readonly statsByHash: ReadonlyMap<string, CommitStats>;
	/** 提交哈希 -> 完整提交信息；未取到时缺省。 */
	readonly messageByHash: ReadonlyMap<string, string>;
	/** 提交哈希 -> 译文；未翻译过时缺省。 */
	readonly translatedByHash: ReadonlyMap<string, string>;
	/** 提交哈希 -> 译文对应的原文；与当前文本相同才可用该译文。 */
	readonly translatedFromByHash: ReadonlyMap<string, string>;
}

/** 一次仓库操作的执行入口：按影响面记忙碌，成功后按需对账。 */
export type RunOperation = (
	scope: BusyScope,
	operation: () => Promise<void>,
	repo?: string,
	optimistic?: (entries: readonly WorkingTreeEntry[]) => WorkingTreeEntry[],
	options?: { readonly historyChanged?: boolean },
) => Promise<void>;

/** 变更区与提交框共用的仓库操作入口。 */
export interface ChangeActions {
	/** 一次仓库操作的执行入口。 */
	readonly run: RunOperation;
	readonly stagePaths: (cwd: string, paths: readonly string[]) => Promise<unknown>;
	readonly unstagePaths: (cwd: string, paths: readonly string[]) => Promise<unknown>;
	readonly discardPaths: (cwd: string, paths: readonly string[], untracked: boolean) => Promise<unknown>;
	readonly openDiff: (hash: string, path: string, staged: boolean, isNew?: boolean) => Promise<void>;
	/** 把路径加入 .gitignore。 */
	readonly onAddToGitignore: (path: string) => void;
	/** 把路径加入本地排除文件。 */
	readonly onAddToLocalExclude: (path: string) => void;
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

/**
 * 忙碌范围：按操作的影响面分级。
 *
 * - read：只读取或导出仓库数据、不改动仓库的操作（提交图、工作区、差异内容、归档导出）。
 * - commit：工作区与暂存区的写入（暂存、取消暂存、丢弃、忽略规则、贮藏、提交）。
 * - history：分支、标签、远程配置与历史改写（检出、合并、变基、重置、远程增删改）。
 * - network：与远端或 gh 的往返（抓取、推送、拉取、发布、创建 Pull Request）。
 */
export type BusyScope = 'read' | 'commit' | 'history' | 'network';

/** 一条进行中的操作：目标仓库路径与影响面。 */
export interface BusyEntry {
	readonly repo: string;
	readonly scope: BusyScope;
}

/** 某个仓库四个影响面各自的忙碌标志；供分区按控件用途取用。 */
export interface BusyFlags {
	readonly read: boolean;
	readonly commit: boolean;
	readonly history: boolean;
	readonly network: boolean;
}

/** 面板状态。 */
export interface PanelState {
	phase: PanelPhase;
	error: string | null;
	commits: Commit[];
	head: string | null;
	/** 是否还有更多提交未加载。 */
	more: boolean;
	/**
	 * 下一个窗口在宿主 `git log` 中的偏移量。
	 *
	 * 由宿主按日志记录数给出，不按 `commits` 长度推导：列表里可能含贮藏行与未提交伪提交行，
	 * 它们都不是日志记录。
	 */
	nextSkip: number;
	entries: WorkingTreeEntry[];
	selectedHash: string | null;
	/**
	 * 展开的提交详情。
	 *
	 * `compareWith` 非空时 `files` 是两个提交之间的改动，方向为 `compareWith → commit`。
	 * `loading` 为 true 表示文件列表仍在读取；空提交读取完成后为 false 且 files 为空。
	 */
	detail: { commit: Commit; files: CommitFile[]; compareWith: Commit | null; loading: boolean } | null;
	/** 进行中的操作；不同仓库、不同影响面之间互不阻塞。 */
	busy: readonly BusyEntry[];
	remotes: Remote[];
	/** 被别的工作树检出的本地分支：照常显示，但不可在本工作树检出、删除或重命名。 */
	foreignBranches: readonly string[];
	/** 是否处于未完成的合并：有冲突待解决，或无冲突但尚未提交。 */
	merging: boolean;
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
