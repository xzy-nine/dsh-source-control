/**
 * 贮藏条目：宿主解析出的形状与客户端组装提交图时用到的形状一致。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

/**
 * 一条 git 记录的作者与提交信息。
 *
 * 贮藏条目与 `git log` 记录都带这一组：它们读的是同一批 `%an` / `%ae` / `%at` / `%s` 字段。
 */
export interface CommitSignatureFields {
	/** 作者名。 */
	readonly author: string;
	/** 作者邮箱。 */
	readonly email: string;
	/** 作者时间戳（秒）。 */
	readonly date: number;
	/** 提交标题。 */
	readonly message: string;
}

/** 贮藏条目。 */
export interface StashEntry extends CommitSignatureFields {
	/** 贮藏提交哈希。 */
	readonly hash: string;
	/** 基提交哈希。 */
	readonly baseHash: string;
	/** 未跟踪文件所在的提交；无则为 null。 */
	readonly untrackedFilesHash: string | null;
	/** 选择器（如 `refs/stash@{0}`）。 */
	readonly selector: string;
}
