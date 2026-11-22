/**
 * 贮藏条目：宿主解析出的形状与客户端组装提交图时用到的形状一致。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

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
