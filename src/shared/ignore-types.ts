/**
 * 忽略规则写入与本地排除文件的返回形状。
 *
 * 运行时无平台依赖，宿主与客户端各自打包。
 */

/** 写入 `.gitignore` 的结果。 */
export interface IgnoreWriteResult {
	/** 规则写入的文件，相对仓库根，使用 `/` 分隔。 */
	readonly file: string;
	/** 该文件是否为新建。 */
	readonly created: boolean;
	/** 写入前该文件是否已在版本控制中：未跟踪时没有可比较的差异。 */
	readonly tracked: boolean;
	/** 写入的规则；规则已存在时为 null。 */
	readonly rule: string | null;
}

/** 本地排除文件的状态。 */
export interface LocalExcludeState {
	/** 排除文件的绝对路径。 */
	readonly path: string;
	/** 有效条目：已去掉空行与注释。 */
	readonly entries: readonly string[];
}
