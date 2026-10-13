/**
 * 提交信息语言判定：估算文本中「非当前语言」的字符占比。
 *
 * 判定基于书写系统而不是逐词识别：CJK 统一表意文字与当前语言一致时算「同语言」，
 * 拉丁字母在中文界面下算「非当前语言」。这足以决定是否需要翻译，且不引入额外依赖。
 */

/** 文本的语言构成。 */
export interface LanguageMix {
	/** 参与的字符总数（忽略空白、标点与数字）。 */
	readonly total: number;
	/** 与当前语言同书写系统的字符数。 */
	readonly same: number;
}

/** 当前语言是否为中日韩文字。 */
function isCjkLocale(locale: string): boolean {
	return /^(zh|ja|ko)/i.test(locale);
}

/**
 * 判断一个字符属于哪一类书写系统。
 *
 * @param character - 单个字符。
 * @returns `cjk`、`latin`，或 `other`（标点、数字、空白、其他符号）。
 */
function scriptOf(character: string): 'cjk' | 'latin' | 'other' {
	const code = character.codePointAt(0) ?? 0;
	// CJK 统一表意文字（含扩展 A）、日文假名、韩文音节。
	if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)
		|| (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) return 'cjk';
	if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return 'latin';
	return 'other';
}

/**
 * 统计文本中与当前语言同书写系统的字符占比。
 *
 * @param text - 待判定文本。
 * @param locale - 当前语言标签，如 `zh`、`zh-CN`、`en`。
 * @returns 计数结果；无可判定字符时 `total` 为 0。
 */
export function languageMix(text: string, locale: string): LanguageMix {
	const cjk = isCjkLocale(locale);
	let total = 0;
	let same = 0;
	for (const character of text) {
		const script = scriptOf(character);
		if (script === 'other') continue;
		total++;
		if ((cjk && script === 'cjk') || (!cjk && script === 'latin')) same++;
	}
	return { total, same };
}

/**
 * 判断是否需要翻译：非当前语言的字符占比超过阈值。
 *
 * 无判定字符（纯符号或数字）时不需要翻译；样本过短时按同语言处理，避免把
 * 一两个字符的差异当成需要翻译。
 *
 * @param text - 待判定文本。
 * @param locale - 当前语言标签。
 * @param threshold - 非当前语言占比阈值，默认 0.5。
 * @param minimum - 判定所需的最少字符数，默认 4。
 * @returns 需要翻译时为 true。
 */
export function needsTranslation(text: string, locale: string, threshold = 0.5, minimum = 4): boolean {
	const mix = languageMix(text, locale);
	if (mix.total < minimum) return false;
	return 1 - mix.same / mix.total > threshold;
}

/** 一行提交信息拆分出的前缀与正文。 */
export interface CommitLineParts {
	/** git 惯例前缀（含冒号与紧随的空格），如 `feat: `、`fix(api): `；无前缀时为空串。 */
	readonly prefix: string;
	/** 前缀之后的正文。 */
	readonly body: string;
}

/**
 * 拆分 conventional commit 前缀与正文。
 *
 * 前缀形如 `type`、`type(scope)`，可带 `!`，后跟冒号：这部分是 git 惯例的机器可读标记，
 * 翻译会破坏工具链识别，因此整体保留原样，只翻译正文。前缀后无正文时正文为空串。
 *
 * @param line - 一行提交信息。
 * @returns 前缀与正文。
 */
export function splitCommitPrefix(line: string): CommitLineParts {
	const match = /^([A-Za-z]+(?:\([^)]*\))?!?:[ \t]*)/.exec(line);
	if (match === null) return { prefix: '', body: line };
	return { prefix: match[1], body: line.slice(match[1].length) };
}
