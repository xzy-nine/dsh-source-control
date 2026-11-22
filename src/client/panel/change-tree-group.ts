/**
 * 变更树分组的公共属性：折叠集合、逐项切换与分组键。
 *
 * 暂存/未暂存分组与合并冲突分组共用这一组字段。
 */

/** 变更树分组的三项。 */
export interface ChangeTreeGroupFields {
	/** 折叠路径集合。 */
	readonly collapsed: ReadonlySet<string>;
	/** 切换某条目的折叠状态。 */
	readonly toggleChange: (key: string, path: string) => void;
	/** 分组键，用于区分不同分组的折叠状态。 */
	readonly groupKey: string;
}
