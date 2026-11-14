/**
 * 客户端领域类型：宿主返回的数据形状与面板内部使用的结构。
 */
import type { ConflictKind } from '../../shared/conflict-kind.ts';

export type { ConflictKind };

/** 可执行的冲突解决动作。 */
export type ConflictAction = 'ours' | 'theirs' | 'delete' | 'markResolved' | 'restoreMarkers';

/** 一个未合并路径在索引里的三个阶段是否存在。 */
export interface ConflictStages {
	/** 基线（共同祖先）。 */
	readonly base: boolean;
	/** 我方（当前分支）。 */
	readonly ours: boolean;
	/** 对方（被合并的一侧）。 */
	readonly theirs: boolean;
}

/** 一次冲突解决的结局。 */
export interface ConflictReport {
	/** 已处置的路径。 */
	readonly resolved: readonly string[];
	/** 未能处置的路径与原因，按 git 原文。 */
	readonly errors: readonly string[];
}

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
	/** 是否是未合并（冲突）条目：两列组成七种冲突组合之一。 */
	readonly unmerged?: boolean;
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

/** 合并方式：默认交给 git 决定是否快进，强制建立合并提交，或压缩为一次待提交的改动。 */
export type MergeMode = 'default' | 'no-ff' | 'squash';

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
	/** 该节点所属仓库是否为浅克隆：历史被截断，浅克隆之外的分支与标签不可见。 */
	readonly shallowClone: boolean;
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
	/** 兜底轮询的间隔（秒）：页签可见时的快档。 */
	pollActiveSeconds: number;
	/** 兜底轮询的间隔（秒）：页签不可见时的慢档。 */
	pollIdleSeconds: number;
	/** 提交统计与完整提交信息的清理周期（秒）。 */
	cleanupSeconds: number;
	onRepoLoadScrollToHead: boolean;
	showAvatars: boolean;
	/** 差异页默认左右并排；单侧改动时仍退回单列。 */
	diffSplit: boolean;
	/** 差异页默认自动换行。 */
	diffWrap: boolean;
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
	options?: {
		/** 是否可能改动引用与提交历史；false 表示只改工作区条目。 */
		readonly historyChanged?: boolean;
		/** 用户意图描述，供日志记录用户点了什么；省略时按影响面记一条。 */
		readonly intent?: string;
	},
) => Promise<void>;

/** 一个子模块条目的丢弃结局。 */
export type SubmoduleDiscardStatus = 'moved' | 'unchanged' | 'blocked' | 'uninitialized';

/** 一个子模块条目的处置结果。 */
export interface SubmoduleDiscardReport {
	/** 子模块路径，相对仓库根。 */
	readonly path: string;
	/** 结局：已移动 / 本来就一致 / 被拒绝 / 未初始化。 */
	readonly status: SubmoduleDiscardStatus;
	/** 被拒绝时的 git 原文；其余为 null。 */
	readonly reason: string | null;
	/** 处置后子模块工作区是否仍有未提交改动。 */
	readonly dirty: boolean;
}

/** 一次丢弃的结局。 */
export interface DiscardReport {
	/** 丢弃后应从变更列表消失的路径。 */
	readonly discarded: readonly string[];
	/** 涉及的子模块条目。 */
	readonly submodules: readonly SubmoduleDiscardReport[];
	/** 未跟踪但未被删除的路径：其内是独立仓库。 */
	readonly skippedRepositories: readonly string[];
}

/** 变更区与提交框共用的仓库操作入口。 */
export interface ChangeActions {
	/** 一次仓库操作的执行入口。 */
	readonly run: RunOperation;
	readonly stagePaths: (cwd: string, paths: readonly string[]) => Promise<unknown>;
	readonly unstagePaths: (cwd: string, paths: readonly string[]) => Promise<unknown>;
	readonly discardPaths: (cwd: string, paths: readonly string[], untracked: boolean) => Promise<DiscardReport>;
	readonly openDiff: (hash: string, path: string, staged: boolean, isNew?: boolean, baseHash?: string, files?: readonly string[]) => Promise<void>;
	/** 对未合并条目执行一个解决动作，并把未完成的路径原因回报给用户。 */
	readonly resolveConflict: (repo: string, paths: readonly string[], action: ConflictAction) => Promise<ConflictReport>;
	/** 把路径加入 .gitignore。 */
	readonly onAddToGitignore: (path: string) => void;
	/** 把路径加入本地排除文件。 */
	readonly onAddToLocalExclude: (path: string) => void;
}

/** 引用列表项。 */
export interface RefItem {
	/** 完整引用名，如 `refs/heads/main`；手选筛选按它持久化。 */
	readonly id: string;
	/** 显示用短名，如 `main`、`origin/main`。 */
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

/** 单个分区的就绪阶段。 */
export type SectionPhase = 'loading' | 'ready';

/**
 * 忙碌范围：按操作的影响面分级。
 *
 * - read：只读取或导出仓库数据、不改动仓库的操作（提交图、工作区、差异内容、归档导出）。
 * - commit：工作区与暂存区的写入（暂存、取消暂存、丢弃、忽略规则、贮藏、提交）。
 * - history：分支、标签、远程配置与历史改写（检出、合并、变基、重置、远程增删改）。
 * - network：与远端或 gh 的往返（抓取、推送、拉取、发布、创建 Pull Request）。
 */
export type BusyScope = 'read' | 'commit' | 'history' | 'network';

/**
 * 执行一次仓库操作并刷新面板。
 *
 * `repo` 省略时用当前选中的工作树；`optimistic` 给出时按它的推算就地更新条目；
 * `historyChanged` 缺省为 true，即按可能改动引用与提交历史处理。
 */
export type PanelRun = (
	scope: BusyScope,
	operation: () => Promise<void>,
	repo?: string,
	optimistic?: (entries: readonly WorkingTreeEntry[]) => WorkingTreeEntry[],
	options?: { readonly historyChanged?: boolean; readonly intent?: string },
) => Promise<void>;

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

/**
 * 后台刷新的作用面：提交图与工作区快照各自一路。
 *
 * 与 `BusyScope` 分开：忙碌是用户发起且会禁用控件，后台刷新是面板自行取数，不禁用任何控件。
 */
export type BackgroundScope = 'graph' | 'entries';

/** 一次后台刷新的登记：作用面与开始时刻。 */
export interface BackgroundRefresh {
	readonly scope: BackgroundScope;
	readonly at: number;
}

/** 后台刷新在各作用面上的进行中标志。 */
export interface BackgroundFlags {
	readonly graph: boolean;
	readonly entries: boolean;
}

/** 面板状态。 */
export interface PanelState {
	phase: PanelPhase;
	/**
	 * 变更列表那一路的就绪阶段。
	 *
	 * 与 `phase` 分开：一次刷新里提交图与工作区快照并行发出，快照通常先回。共用一个阶段会让
	 * 更改区陪着提交图一起显示占位 —— 提交图被慢操作挡住时，已经取到的变更列表也画不出来。
	 */
	entriesPhase: SectionPhase;
	error: string | null;
	commits: Commit[];
	/** 当前分支名；分离头指针时为 null。 */
	head: string | null;
	/** 当前 HEAD 指向的提交哈希；尚无提交时为 null。 */
	headHash: string | null;
	/** 上游远程跟踪分支名；无上游时为 null。 */
	upstream: string | null;
	/**
	 * 相对上游领先的提交数。
	 *
	 * 与 `upstream` 同源（宿主一次 `git status --branch`），因此图形区、更改区与提交框读的是
	 * 同一份值；仓库树另有自己的取数（`loadReposSync`），两者互不覆盖。
	 */
	ahead: number;
	/** 相对上游落后的提交数。 */
	behind: number;
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
	/** 工作区条目是否因上限而截断：为 true 时 `entries` 只是前一部分。 */
	entriesTruncated: boolean;
	selectedHash: string | null;
	/**
	 * 展开的提交详情。
	 *
	 * `compareWith` 非空时 `files` 是两个提交之间的改动，方向为 `compareWith → commit`。
	 * `loading` 为 true 表示文件列表仍在读取；空提交读取完成后为 false 且 files 为空。
	 */
	detail: { commit: Commit; files: CommitFile[]; compareWith: Commit | null; loading: boolean; truncated: boolean } | null;
	/** 进行中的操作；不同仓库、不同影响面之间互不阻塞。 */
	busy: readonly BusyEntry[];
	remotes: Remote[];
	/** 被别的工作树检出的本地分支：照常显示，但不可在本工作树检出、删除或重命名。 */
	foreignBranches: readonly string[];
	/** 是否处于未完成的合并：有冲突待解决，或无冲突但尚未提交。 */
	merging: boolean;
	/** 后台刷新登记；事件驱动、宿主写事件、兜底轮询与定时抓取都走这里。 */
	background: readonly BackgroundRefresh[];
	/** 最近一次后台刷新完成的时刻；从未刷新时为 0。 */
	lastRefreshAt: number;
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