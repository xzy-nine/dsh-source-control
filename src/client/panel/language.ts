/**
 * 提交信息语言判定与翻译：估算文本中「非当前语言」的字符占比，并按行翻译提交信息。
 *
 * 判定基于书写系统而不是逐词识别：CJK 统一表意文字与当前语言一致时算「同语言」，
 * 拉丁字母在中文界面下算「非当前语言」。这足以决定是否需要翻译，且不引入额外依赖。
 */
import { forKey } from '../shared/cache.ts';

/** 翻译判定缓存的条目上限。 */
const TRANSLATION_JUDGE_CACHE_LIMIT = 1024;

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

/** 翻译判定缓存：键为「语言 + NUL + 文本」。 */
const translationJudge = forKey((key: string): boolean => {
	const at = key.indexOf('\u0000');
	return needsTranslation(key.slice(at + 1), key.slice(0, at));
}, { limit: TRANSLATION_JUDGE_CACHE_LIMIT });

/**
 * 判断是否需要翻译（按语言与文本缓存）。
 *
 * 图形区标题栏按可见窗口逐条判定，同一行在滚动中会被反复判定，结果按文本缓存。
 *
 * @param text - 待判定文本。
 * @param locale - 当前语言标签。
 * @returns 需要翻译时为 true。
 */
export function needsTranslationMemo(text: string, locale: string): boolean {
	return translationJudge(locale + '\u0000' + text);
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

/**
 * 当前界面语言标签。
 *
 * DSH 的语言服务把活动语言同步到 `<html lang>`（`zh` 写成 `zh-CN`），因此直接读它；
 * 读取不到时按英文处理。
 *
 * @returns 语言标签，如 `zh-CN`、`en`。
 */
export function interfaceLanguage(): string {
	if (typeof document === 'undefined') return 'en';
	const lang = document.documentElement.lang;
	return lang === '' ? 'en' : lang;
}

/** 翻译入口的判定事实。 */
export interface TranslateEntryFacts {
	/** 翻译服务是否可用；不可用时不给入口。 */
	readonly ready: boolean;
	/** 是否已有同类任务在进行；进行中不给入口。 */
	readonly busy: boolean;
	/** 待判定文本。 */
	readonly text: string;
	/** 当前语言标签。 */
	readonly locale: string;
	/** 已翻译过的原文；与 text 相同表示当前内容已是译文。 */
	readonly translatedFrom?: string | null;
}

/**
 * 判断是否给出翻译入口。
 *
 * 提交信息框与提交浮窗共用本判据：翻译服务可用、无进行中的同类任务、内容非空、
 * 尚未翻译过（或翻译后内容已变），且以非当前语言为主。
 *
 * @param facts - 见 {@link TranslateEntryFacts}。
 * @returns 应给出翻译入口时为 true。
 */
export function showTranslateEntry(facts: TranslateEntryFacts): boolean {
	const { ready, busy, text, locale, translatedFrom = null } = facts;
	return ready && !busy && text.trim() !== '' && text !== translatedFrom && needsTranslation(text, locale);
}

/**
 * 逐行翻译提交信息文本，保留换行结构与 git 惯例前缀。
 *
 * 逐行而不是整段一次：整段会被翻译服务拼成一行，丢失标题与要点的分行。
 * 空行保留为空行；每行的 git 惯例前缀（`feat:`、`fix(api):` 等）原样保留，只翻译其后的正文。
 *
 * @param source - 待翻译的提交信息。
 * @param translateLine - 单行正文翻译函数。
 * @returns 翻译后的文本。
 */
export async function translateCommitMessage(
	source: string,
	translateLine: (body: string) => Promise<string>,
): Promise<string> {
	const parts: string[] = [];
	for (const line of source.split('\n')) {
		if (line.trim() === '') { parts.push(''); continue; }
		// git 惯例前缀不翻译：翻译会破坏 type/scope 的机器可读语义。
		const { prefix, body } = splitCommitPrefix(line);
		parts.push(body.trim() === '' ? line : prefix + await translateLine(body));
	}
	return parts.join('\n');
}

/**
 * 取某行的标题译文。
 *
 * 译文有两个来源，据此判断它是否适用于该行：批量翻译译的是行标题，悬停单条翻译译的是
 * 完整提交信息；两者都以译文的首行为标题。原文与两者都不符时（内容已变）视为无译文。
 *
 * @param title - 该行显示的标题。
 * @param fullMessage - 该提交的完整信息；未取回时为 null。
 * @param translation - 该提交的译文；无译文时为 null。
 * @param translatedFrom - 译文对应的原文；无译文时为 null。
 * @returns 标题译文；无可用译文时为 null。
 */
export function translatedTitle(
	title: string,
	fullMessage: string | null,
	translation: string | null,
	translatedFrom: string | null,
): string | null {
	if (translation === null || translation === '' || translatedFrom === null) return null;
	if (translatedFrom !== title && translatedFrom !== fullMessage) return null;
	return translation.split('\n')[0];
}
