/**
 * 本地 SSH 状态：宿主探测结果与客户端展示共用同一份形状。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

/** 本地 SSH 状态。 */
export interface SshStatus {
	/** ssh 可执行文件是否可用。 */
	readonly installed: boolean;
	/** ssh 版本行；不可用时为 null。 */
	readonly version: string | null;
	/** `~/.ssh` 下的私钥文件名（不含 `.pub`）。 */
	readonly keys: readonly string[];
	/** 探测的目标主机。 */
	readonly host: string;
	/** 目标主机是否接受本机公钥。 */
	readonly authenticated: boolean;
	/** 是否可直接用于 SSH 远程操作：客户端可用且认证通过。 */
	readonly ready: boolean;
	/** 未就绪时的说明：探测输出原文，没有输出时为兜底一句；就绪时为 null。 */
	readonly message: string | null;
}
