/**
 * 合并视图的三方内容：宿主取数结果与客户端拿到的载荷共用同一份形状。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
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
