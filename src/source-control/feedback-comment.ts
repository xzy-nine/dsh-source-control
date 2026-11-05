/**
 * 反馈日志与 issue 评论的对应关系（纯函数）：把若干份日志文本合并成若干条评论正文。
 *
 * 一条评论有 65536 字符上限，日志落盘已按 `LOG_FILE_CHAR_LIMIT` 约束单份文件，两者之间
 * 只做合并、不切分：一份日志永远整份落在某一条评论里，装不下就留给下一条。
 * 因此一条评论可以含多份日志，一份日志不会跨评论。
 *
 * 正文外层是 `<details>` 折叠段落，读者点开才展开日志。日志行本身以时间戳开头，
 * 不含会打断折叠结构的标记。
 */

/** 一条待发送的评论正文。 */
export interface LogComment {
	/** 正文；直接写进 `gh issue comment --body-file` 的文件。 */
	readonly body: string;
	/** 这份评论承载的日志文件名，按装入顺序排列。 */
	readonly files: readonly string[];
	/** 这份评论里的日志行数。 */
	readonly lines: number;
}

/** 一份待发送的日志。 */
export interface LogSource {
	/** 日志文件名。 */
	readonly name: string;
	/** 日志全文。 */
	readonly text: string;
}

/** 评论正文的固定文案。文案归此处，调用方与测试都按引用取用。 */
export const LOG_COMMENT_TEXT = {
	/** 单份日志的标题；`{name}` 为文件名。 */
	singleHeading: '### 日志：`{name}`',
	/** 多份日志的标题；`{names}` 为以顿号分隔的文件名。 */
	multiHeading: '### 日志：`{names}`',
	/** 单份日志的摘要；`{name}` 为文件名，`{n}` 为行数。 */
	singleSummary: '展开 {name}（{n} 行）',
	/** 多份日志的摘要；`{n}` 为文件数，`{m}` 为行数。 */
	multiSummary: '展开 {n} 份日志（{m} 行）',
	/** 折叠段落的开头。 */
	detailsOpen: '<details>',
	/** 折叠段落标签的开头与结尾：撑起右侧那个可点的标签。 */
	summaryOpen: '<summary>',
	summaryClose: '</summary>',
	/** 折叠段落的结尾。 */
	detailsClose: '</details>',
	/** 日志正文的围栏。 */
	fence: '```',
	/** 一份日志被截断时的说明；`{name}` 为文件名，`{path}` 为本地路径。 */
	truncated: '> `{name}` 超出单条评论上限，已截断；完整文件在本地 {path}。',
} as const;

/**
 * 渲染一条评论的正文。
 *
 * @param sources - 装入这条评论的日志，按顺序排列。
 * @param truncated - 因超限被截断的日志文件名与本地路径；没有时为 null。
 * @returns 正文。
 */
function renderComment(sources: readonly LogSource[], truncated: { readonly name: string; readonly path: string } | null): string {
	const names = sources.map((source) => source.name);
	const lines = sources.reduce((sum, source) => sum + countLines(source.text), 0);
	const heading = sources.length === 1
		? LOG_COMMENT_TEXT.singleHeading.replace('{name}', names[0])
		: LOG_COMMENT_TEXT.multiHeading.replace('{names}', names.join('、'));
	const summary = sources.length === 1
		? LOG_COMMENT_TEXT.singleSummary.replace('{name}', names[0]).replace('{n}', String(lines))
		: LOG_COMMENT_TEXT.multiSummary.replace('{n}', String(sources.length)).replace('{m}', String(lines));
	const parts = [
		heading, '',
		LOG_COMMENT_TEXT.detailsOpen,
		`${LOG_COMMENT_TEXT.summaryOpen}${summary}${LOG_COMMENT_TEXT.summaryClose}`,
		'',
	];
	if (truncated !== null) {
		parts.push(LOG_COMMENT_TEXT.truncated.replace('{name}', truncated.name).replace('{path}', truncated.path), '');
	}
	parts.push(LOG_COMMENT_TEXT.fence);
	for (const source of sources) parts.push(source.text.trimEnd());
	parts.push(LOG_COMMENT_TEXT.fence, '', LOG_COMMENT_TEXT.detailsClose);
	return parts.join('\n');
}

/**
 * 一份日志的行数。
 *
 * @param text - 日志全文。
 * @returns 行数；空文本为 0。
 */
function countLines(text: string): number {
	const trimmed = text.trimEnd();
	return trimmed === '' ? 0 : trimmed.split('\n').length;
}

/**
 * 把日志合并成评论正文。
 *
 * 按顺序逐个装入：当前评论再装一份会超过 `budget` 时闭合它、另起一条。单份日志本身
 * 超过 `budget` 时独占一条并截断到 `budget` 以内——落盘侧已保证不出现这种情况，
 * 只有早于该上限的历史文件会走到这里。
 *
 * @param sources - 日志，按启动先后排列。
 * @param budget - 单条评论正文的字符上限。
 * @param truncationPaths - 截断说明里使用的本地路径，按文件名索引；缺省不给路径。
 * @returns 评论正文列表；`sources` 为空时为空数组。
 */
export function groupLogComments(
	sources: readonly LogSource[], budget: number, truncationPaths: Readonly<Record<string, string>> = {},
): LogComment[] {
	const comments: LogComment[] = [];
	let current: LogSource[] = [];
	let currentTruncated: { readonly name: string; readonly path: string } | null = null;
	/** 闭合当前评论。 */
	const close = (): void => {
		if (current.length === 0) return;
		const body = renderComment(current, currentTruncated);
		comments.push({
			body,
			files: current.map((source) => source.name),
			lines: current.reduce((sum, source) => sum + countLines(source.text), 0),
		});
		current = [];
		currentTruncated = null;
	};
	for (const source of sources) {
		if (renderComment([source], null).length > budget) {
			// 单份即超限：独占一条并截断，截断只发生在早于落盘上限的历史文件上。
			close();
			const path = truncationPaths[source.name] ?? '';
			const truncatedSource: LogSource = { name: source.name, text: truncateToBudget(source, budget, path) };
			comments.push({
				body: renderComment([truncatedSource], { name: source.name, path }),
				files: [source.name],
				lines: countLines(truncatedSource.text),
			});
			continue;
		}
		const next = [...current, source];
		if (current.length > 0 && renderComment(next, null).length > budget) {
			close();
			current = [source];
			continue;
		}
		current = next;
	}
	close();
	return comments;
}

/**
 * 把一份日志截到给定预算以内。
 *
 * 按行边界截断，保证留下的仍是完整记录；路径未知时正文里不给路径。
 *
 * @param source - 日志。
 * @param budget - 正文上限。
 * @param path - 本地路径；空串表示不给。
 * @returns 截断后的正文。
 */
function truncateToBudget(source: LogSource, budget: number, path: string): string {
	// 先按整份算出包装占用的长度，再从可用余量里按行取。
	const overhead = renderComment([{ name: source.name, text: '' }], { name: source.name, path }).length;
	const room = Math.max(0, budget - overhead);
	const rows = source.text.trimEnd().split('\n');
	const kept: string[] = [];
	let used = 0;
	for (const row of rows) {
		if (used + row.length + 1 > room) break;
		kept.push(row);
		used += row.length + 1;
	}
	return kept.join('\n');
}
