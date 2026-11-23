/**
 * 反馈提交的结局：宿主返回与客户端展示共用同一份形状。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

/** `gh` 失败的分类。 */
export type FeedbackFailureKind = 'ok' | 'missing-cli' | 'not-logged-in' | 'missing-scope' | 'forbidden' | 'invalid' | 'unknown';

/** 反馈提交结局的日志字段。 */
export interface FeedbackLogFields {
	/** 日志目录绝对路径：失败时提示用户手动提交用。 */
	readonly logDir: string;
	/** 已追加的日志评论条数；未附带日志时为 0。 */
	readonly commentCount: number;
	/** 日志评论提交失败的原因；全部成功或未附带日志时为 null。 */
	readonly commentError: string | null;
}
