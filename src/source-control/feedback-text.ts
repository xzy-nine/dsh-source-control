/**
 * 反馈的正文拼装（纯函数）：类型前缀、环境信息、日志打包说明与脱敏摘要。
 *
 * 正文结构固定为四段：用户描述、环境、日志、脱敏。日志段落给出压缩包文件名与上传步骤，
 * 收件方据此知道正文之外的附件应当是什么。
 */

/** 反馈类型。 */
export type FeedbackType = 'bug' | 'suggestion' | 'other';

/** 类型到 issue 标题前缀与中文名的映射。 */
export const FEEDBACK_TYPES: Readonly<Record<FeedbackType, { readonly label: string; readonly prefix: string }>> = {
	bug: { label: '缺陷', prefix: '[Bug]' },
	suggestion: { label: '建议', prefix: '[建议]' },
	other: { label: '其它', prefix: '[其它]' },
};

/** 本插件接收反馈的仓库。 */
export const FEEDBACK_REPO = 'xzy-nine/dsh-source-control';

/** 拼装正文所需的事实。 */
export interface FeedbackFacts {
	/** 反馈类型。 */
	readonly type: FeedbackType;
	/** 用户描述。 */
	readonly description: string;
	/** 插件版本；未知时为空串。 */
	readonly pluginVersion: string;
	/** 平台描述，如 `win32 10.0 x64`。 */
	readonly platform: string;
	/** Node 版本。 */
	readonly node: string;
	/** 打包后的日志文件名；未附带时为 null。 */
	readonly logFile: string | null;
	/** 日志体积（字节）；未附带时为 null。 */
	readonly logSize: number | null;
	/** 脱敏摘要；未做任何替换时为空串。 */
	readonly redaction: string;
	/** 登记豁免的字符串数量。 */
	readonly exemptionCount: number;
}

/**
 * issue 标题：类型前缀 + 用户标题。
 *
 * @param type - 反馈类型。
 * @param title - 用户填的标题。
 * @returns 标题文本。
 */
export function feedbackIssueTitle(type: FeedbackType, title: string): string {
	return `${FEEDBACK_TYPES[type].prefix} ${title.trim()}`;
}

/**
 * 字节数的可读形式。
 *
 * @param bytes - 字节数。
 * @returns 文本，如 `312.4 KB`。
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${String(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 日志段落的正文：压缩包名、体积与上传步骤。
 *
 * @param facts - 见 {@link FeedbackFacts}。
 * @returns 段落文本。
 */
function logSection(facts: FeedbackFacts): string[] {
	if (facts.logFile === null) return ['未附带日志。'];
	return [
		`日志已打包为 \`${facts.logFile}\`（${formatBytes(facts.logSize ?? 0)}），格式为 logcat threadtime，每次启动一个文件。`,
		'',
		'> 请把该压缩包拖到本条 issue 的评论框上传（GitHub 的附件接口不接受日志等文本类型，只能由界面手动上传）。',
		'> 本地路径已在创建反馈时告知，可直接从该目录取用。',
	];
}

/**
 * 拼装 issue 正文。
 *
 * @param facts - 见 {@link FeedbackFacts}。
 * @returns 正文文本。
 */
export function buildIssueBody(facts: FeedbackFacts): string {
	const lines: string[] = [];
	lines.push('## 描述', '', facts.description.trim(), '');
	lines.push('## 环境', '');
	lines.push(`- 插件版本：${facts.pluginVersion === '' ? '未知' : facts.pluginVersion}`);
	lines.push(`- 类型：${FEEDBACK_TYPES[facts.type].label}`);
	lines.push(`- 平台：${facts.platform}`);
	lines.push(`- Node：${facts.node}`);
	lines.push('');
	lines.push('## 日志', '');
	lines.push(...logSection(facts));
	lines.push('');
	lines.push('## 脱敏', '');
	if (facts.redaction === '') {
		lines.push('本次提交未触发脱敏替换。');
	} else {
		lines.push(`已屏蔽：${facts.redaction}。占位符 \`<url-credential>\` 为 URL 里的账号口令，\`<token>\` 为令牌，\`<user>\` 为系统用户名。`);
	}
	if (facts.exemptionCount > 0) {
		lines.push('', `本次登记 ${String(facts.exemptionCount)} 处豁免，相关字符串按原样保留。`);
	}
	lines.push('', '---', '', '由 dsh-source-control 的反馈入口自动创建。');
	return lines.join('\n');
}
