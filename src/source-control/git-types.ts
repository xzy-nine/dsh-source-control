/**
 * 宿主侧 git 数据层的数据形状。
 *
 * 字段名即前端契约：`src/client/shared/types.ts` 与 `src/client/api/` 按这些名字读取响应。
 */

/** 错误信息；null 表示无错误。 */
export type ErrorInfo = string | null;

/** 文件改动状态码，取 `git diff --name-status` 的首字符。 */
export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'U';

/** 提交排序方式，对应 `git log --<order>-order`。 */
export type CommitOrdering = 'date' | 'author-date' | 'topo';

/** 重置模式，对应 `git reset --<mode>`。 */
export type ResetMode = 'soft' | 'mixed' | 'hard';

/** 推送模式，对应 `git push --<mode>`；空串表示普通推送。 */
export type PushMode = '' | 'force' | 'force-with-lease';

/** 配置读写位置。 */
export type ConfigLocation = 'local' | 'global';

/** 签名校验状态码，取 `git log --format=%G?` 的取值。 */
export type SignatureStatus = 'G' | 'U' | 'X' | 'Y' | 'R' | 'E' | 'B';

/** 提交上的标签标记。 */
export interface CommitTag {
	/** 标签名。 */
	readonly name: string;
	/** 是否为附注标签。 */
	readonly annotated: boolean;
}

/** 提交上的远程分支标记。 */
export interface CommitRemote {
	/** 远程分支短名（如 `origin/main`）。 */
	readonly name: string;
	/** 所属远程名；无法匹配已知远程时为 null。 */
	readonly remote: string | null;
}

/** 提交上的贮藏标记。 */
export interface CommitStash {
	/** 选择器（如 `refs/stash@{0}`）。 */
	readonly selector: string;
	/** 贮藏的基提交。 */
	readonly baseHash: string;
	/** 未跟踪文件所在的提交；无则为 null。 */
	readonly untrackedFilesHash: string | null;
}

/** 提交图中的一条提交。 */
export interface CommitNode {
	/** 完整哈希；`*` 表示工作区未提交变更的伪提交。 */
	readonly hash: string;
	/** 父提交哈希。 */
	readonly parents: readonly string[];
	/** 作者名。 */
	readonly author: string;
	/** 作者邮箱。 */
	readonly email: string;
	/** 提交时间（秒）。 */
	readonly date: number;
	/** 提交标题。 */
	readonly message: string;
	/** 指向该提交的本地分支。 */
	readonly heads: readonly string[];
	/** 指向该提交的标签。 */
	readonly tags: readonly CommitTag[];
	/** 指向该提交的远程分支。 */
	readonly remotes: readonly CommitRemote[];
	/** 贮藏标记；非贮藏提交为 null。 */
	readonly stash: CommitStash | null;
}

/** 提交图内容，不含错误信息。 */
export interface CommitGraph {
	/** 提交列表，按请求的排序。 */
	readonly commits: CommitNode[];
	/** 当前 HEAD 指向的提交哈希；无提交时为 null。 */
	readonly head: string | null;
	/** 出现过的标签名（去重）。 */
	readonly tags: string[];
	/** 是否还有更多提交未返回。 */
	readonly moreCommitsAvailable: boolean;
	/**
	 * 下一个窗口应使用的偏移量。
	 *
	 * 按 `git log` 记录数计，不按本页 `commits` 长度：`commits` 可能插入贮藏行，它们是引用而非
	 * 日志记录，计入会让偏移虚高、下一页跳过真实提交。
	 */
	readonly nextSkip: number;
}

/** 提交图读取结果。 */
export interface CommitData extends CommitGraph {
	readonly error: ErrorInfo;
}

/** 一条文件改动。 */
export interface FileChange {
	/** 改动前的路径。 */
	readonly oldFilePath: string;
	/** 改动后的路径。 */
	readonly newFilePath: string;
	/** 状态码。 */
	readonly type: FileStatus;
	/** 新增行数；未知为 null。 */
	readonly additions: number | null;
	/** 删除行数；未知为 null。 */
	readonly deletions: number | null;
}

/** 签名信息。 */
export interface Signature {
	/** 签名密钥。 */
	readonly key: string;
	/** 签名者。 */
	readonly signer: string;
	/** 校验状态。 */
	readonly status: SignatureStatus;
}

/** 提交详情。 */
export interface CommitDetails {
	readonly hash: string;
	readonly parents: readonly string[];
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly committer: string;
	readonly committerEmail: string;
	readonly committerDate: number;
	readonly signature: Signature | null;
	/** 完整提交信息（含正文）。 */
	readonly body: string;
	/** 改动文件。 */
	readonly fileChanges: readonly FileChange[];
}

/** 提交详情读取结果。 */
export interface CommitDetailsData {
	readonly commitDetails: CommitDetails | null;
	readonly error: ErrorInfo;
}

/** 提交对比结果。 */
export interface CommitComparisonData {
	readonly fileChanges: FileChange[];
	readonly error: ErrorInfo;
}

/** 贮藏条目。 */
export interface StashEntry {
	/** 贮藏提交哈希。 */
	readonly hash: string;
	/** 基提交哈希。 */
	readonly baseHash: string;
	/** 未跟踪文件所在的提交；无则为 null。 */
	readonly untrackedFilesHash: string | null;
	/** 选择器（如 `refs/stash@{0}`）。 */
	readonly selector: string;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}


/** 分支的远程配置。 */
export interface RepoConfigBranch {
	/** `branch.<name>.pushremote`。 */
	readonly pushRemote: string | null;
	/** `branch.<name>.remote`。 */
	readonly remote: string | null;
}

/** 远程条目。 */
export interface SettingsRemote {
	/** 远程名。 */
	readonly name: string;
	/** 抓取 URL。 */
	readonly url: string | null;
	/** 推送 URL；未单独配置时为 null。 */
	readonly pushUrl: string | null;
}

/** 仓库配置。 */
export interface RepoConfig {
	/** 各分支的远程配置。 */
	readonly branches: { readonly [branchName: string]: RepoConfigBranch };
	/** `diff.tool`。 */
	readonly diffTool: string | null;
	/** `diff.guitool`。 */
	readonly guiDiffTool: string | null;
	/** `remote.pushdefault`。 */
	readonly pushDefault: string | null;
	/** 已知远程。 */
	readonly remotes: readonly SettingsRemote[];
	/** 用户身份（本地与全局）。 */
	readonly user: {
		readonly name: { readonly local: string | null; readonly global: string | null };
		readonly email: { readonly local: string | null; readonly global: string | null };
	};
}

/** 仓库配置读取结果。 */
export interface RepoConfigData {
	readonly config: RepoConfig | null;
	readonly error: ErrorInfo;
}

/** 仓库信息。 */
export interface RepoInfo {
	/** 分支名列表；当前分支排在首位。 */
	readonly branches: string[];
	/** 当前分支名；分离头指针时为 null。 */
	readonly head: string | null;
	/** 远程列表。 */
	readonly remotes: SettingsRemote[];
	/** 贮藏列表。 */
	readonly stashes: StashEntry[];
	readonly error: ErrorInfo;
}
