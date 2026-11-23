/**
 * 合并视图的三方内容：宿主取数与客户端载荷共用同一数据形状。
 *
 * 运行时无平台依赖，宿主与客户端各自打包。
 */

/** 三方内容。 */
export interface MergeContents {
	/** 基线（共同祖先）；双方新增的冲突没有基线段，为 null。 */
	readonly base: string | null;
	/** 我方。 */
	readonly ours: string | null;
	/** 对方。 */
	readonly theirs: string | null;
}
