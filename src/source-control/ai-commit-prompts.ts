/**
 * AI 提交提示词的读取层：加载 ai-commit-prompts.json 并代入占位符。
 *
 * JSON 是提示词文本的唯一数据源，本层只声明类型与代入逻辑，不含任何文本内容。
 */
import source from './ai-commit-prompts.json' with { type: 'json' };

/** AI 提交生成的提示词文本；占位符由调用方代入。 */
export interface AiCommitPromptTexts {
	/** 系统提示词主体。 */
	readonly system: string;
	/** 指定语言时追加到系统提示词末尾，占位符 `{language}`；未指定语言时不追加。 */
	readonly language: string;
	/** 普通生成的用户请求模板，占位符 `{diff}`。 */
	readonly request: string;
	/** 修补上一次提交时的用户请求模板，占位符 `{diff}`。 */
	readonly requestAmend: string;
}

/** 提示词文本，数据源为 ai-commit-prompts.json。 */
export const AI_COMMIT_PROMPTS: AiCommitPromptTexts = source;

/**
 * 代入提示词模板里的占位符。
 *
 * 用切分拼接而不是 `replace`：diff 里可能出现 `$&` 这类会被 `replace` 当作替换模式的序列。
 *
 * @param template - 含 `{name}` 占位符的模板。
 * @param values - 占位符取值。
 * @returns 代入后的文本。
 */
export function fillPrompt(template: string, values: Record<string, string>): string {
	let text = template;
	for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(value);
	return text;
}
