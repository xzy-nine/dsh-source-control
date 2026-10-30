/**
 * 反馈日志的脱敏（纯函数）：只在提交反馈时使用，磁盘上的日志文件保持原样。
 *
 * 本地路径不处理——排查问题需要看清文件位置。其余敏感内容替换为可分辨用途的占位符：
 * `<url-credential>`（URL 里的账号口令）、`<token>`（令牌串）、`<user>`（系统用户名）。
 * 用户可在反馈页为指定字符串登记豁免，登记的字符串原样保留。
 */

/** 占位符：URL 里的账号口令。 */
export const PLACEHOLDER_CREDENTIAL = '<url-credential>';

/** 占位符：令牌。 */
export const PLACEHOLDER_TOKEN = '<token>';

/** 占位符：系统用户名。 */
export const PLACEHOLDER_USER = '<user>';

/** 令牌前缀：GitHub CLI、GitHub PAT、通用 API key、Slack 与 Bearer 头。 */
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g;

/** URL 里的账号口令：`scheme://user:secret@host`，只屏蔽账号口令部分。 */
const CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/g;

/** 脱敏选项。 */
export interface RedactOptions {
	/** 需要脱敏的系统用户名；空串表示不处理。 */
	readonly username?: string;
	/** 豁免保留的字符串，按字面匹配。 */
	readonly exemptions?: readonly string[];
}

/** 一次脱敏的替换次数。 */
export interface RedactCounts {
	readonly credential: number;
	readonly token: number;
	readonly user: number;
}

/** 一次脱敏的结果。 */
export interface RedactResult {
	/** 脱敏后的文本。 */
	readonly text: string;
	/** 各类替换的次数。 */
	readonly counts: RedactCounts;
}

/** 正则转义。 */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 用位置标记替换命中，最后统一换回占位符。
 *
 * 直接写入占位符会让后续规则再次命中已替换的内容（占位符自身也可能被用户名规则命中），
 * 因此每处命中先换成 `\u0000<序号>`，全部规则跑完后再换回。
 *
 * @param text - 原文。
 * @param pattern - 匹配规则。
 * @param place - 由命中内容给出占位符文本。
 * @param slots - 占位符池。
 * @returns 替换后的文本与命中次数。
 */
function shield(text: string, pattern: RegExp, place: (...match: string[]) => string, slots: string[]): { text: string; hits: number } {
	let hits = 0;
	const next = text.replace(pattern, (...match: string[]) => {
		hits += 1;
		slots.push(place(...match));
		return `\u0000${String(slots.length - 1)}\u0000`;
	});
	return { text: next, hits };
}

/**
 * 对一段文本套用全部脱敏规则。
 *
 * 顺序固定：先 URL 账号口令，再令牌串，最后系统用户名。
 *
 * @param chunk - 已排除豁免片段的文本。
 * @param options - 见 {@link RedactOptions}。
 * @param slots - 占位符池。
 * @returns 替换后的文本与替换次数。
 */
function applyRules(chunk: string, options: RedactOptions, slots: string[]): { text: string; counts: RedactCounts } {
	let current = chunk;
	const credential = shield(current, CREDENTIAL_PATTERN, (...match) => `${match[1] ?? ''}${PLACEHOLDER_CREDENTIAL}`, slots);
	current = credential.text;
	const token = shield(current, TOKEN_PATTERN, () => PLACEHOLDER_TOKEN, slots);
	current = token.text;
	const username = (options.username ?? '').trim();
	let userHits = 0;
	if (username !== '') {
		// 与路径分隔符或标识符字符相邻的出现属于路径或名字片段，不处理，因此路径保持原样。
		const pattern = new RegExp(`(?<![\\w/\\\\-])${escapeRegExp(username)}(?![\\w/\\\\-])`, 'g');
		const applied = shield(current, pattern, () => PLACEHOLDER_USER, slots);
		current = applied.text;
		userHits = applied.hits;
	}
	return { text: current, counts: { credential: credential.hits, token: token.hits, user: userHits } };
}

/**
 * 对一段文本脱敏。
 *
 * 登记的豁免字符串原样保留，其余片段逐条套用规则。
 *
 * @param text - 原文。
 * @param options - 见 {@link RedactOptions}。
 * @returns 脱敏结果。
 */
export function redactText(text: string, options: RedactOptions = {}): RedactResult {
	const slots: string[] = [];
	const counts = { credential: 0, token: 0, user: 0 };
	const tokens = (options.exemptions ?? []).filter((token) => token !== '');
	const apply = (chunk: string): string => {
		const applied = applyRules(chunk, options, slots);
		counts.credential += applied.counts.credential;
		counts.token += applied.counts.token;
		counts.user += applied.counts.user;
		return applied.text;
	};
	let masked: string;
	if (tokens.length === 0) {
		masked = apply(text);
	} else {
		// 最长优先的单个正则切分：命中段落在奇数下标，整段豁免。
		const escaped = [...tokens].sort((left, right) => right.length - left.length).map(escapeRegExp);
		const pieces = text.split(new RegExp(`(${escaped.join('|')})`, 'g'));
		masked = pieces.map((piece, index) => (index % 2 === 1 ? piece : apply(piece))).join('');
	}
	const restored = masked.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => slots[Number(index)] ?? '');
	return { text: restored, counts };
}

/**
 * 脱敏摘要，写进反馈正文，告知收件方本次屏蔽了什么。
 *
 * @param counts - 替换次数。
 * @returns 摘要文本；没有任何替换时为空串。
 */
export function redactSummary(counts: RedactCounts): string {
	const parts: string[] = [];
	if (counts.credential > 0) parts.push(`URL 凭据 ×${String(counts.credential)}`);
	if (counts.token > 0) parts.push(`令牌 ×${String(counts.token)}`);
	if (counts.user > 0) parts.push(`用户名 ×${String(counts.user)}`);
	return parts.join('、');
}
