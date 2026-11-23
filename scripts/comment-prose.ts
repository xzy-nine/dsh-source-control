/**
 * 注释散文规则与扫描：把解释性写法的可识别词形判为违规。
 *
 * 注释由 TypeScript 编译器抽取：AST 上的前后注释范围天然跳过字符串、模板字面量、
 * 正则与 JSX 属性，只有 JSX 文本节点需要额外剔除。规则只匹配词形，不判断语义：
 * 某处命中是解释性描述还是合法用法，由豁免标记与基线裁定。散文标准的正家是
 * `.agents/skills/source-control-prose-standard/SKILL.md`，推理记录泄漏的分类见
 * `.agents/skills/source-control-trim-cot-leakage/SKILL.md`。
 *
 * @module scripts/comment-prose
 */

import ts from 'typescript'

/** 一行注释：1 基行号与该行的注释文本，已去掉注释定界符。 */
export interface CommentLine {
	readonly line: number
	readonly text: string
}

/** 一段注释：相邻的 `//` 行或一个块注释。 */
export interface CommentBlock {
	/** 段内各行按源顺序排列。 */
	readonly lines: readonly CommentLine[]
	/** 段内豁免标记所在的行与理由；没有标记时为 null。 */
	readonly marker: { readonly line: number; readonly reason: string } | null
}

/** 一条判定规则。 */
export interface ProseRule {
	/** 报告与基线使用的稳定标识。 */
	readonly id: string
	/** 该规则拦下的写法类型。 */
	readonly summary: string
	/** 逐行匹配。 */
	readonly pattern: RegExp
}

/** 一处命中。 */
export interface Violation {
	/** 相对仓库的斜杠路径。 */
	readonly file: string
	/** 1 基行号。 */
	readonly line: number
	/** 命中的规则标识。 */
	readonly rule: string
	/** 命中处所在注释行的文本。 */
	readonly text: string
}

/**
 * 豁免标记：`prose-ok: <理由>`。标记作用于它所在的整段注释，理由必填。
 *
 * 理由为空时该标记本身成为 `marker-without-reason` 违规：不带理由的豁免与
 * 删掉规则等价。
 */
const EXEMPTION = /prose-ok\s*[:：]\s*(.*)$/

/**
 * 判为解释性写法的词形。
 *
 * 每条规则对应一种泄漏或赘余类型。词形取宽：漏过一处解释性注释比误伤一处合法
 * 注释代价更大，误伤由基线或 `prose-ok` 标记逐条消化，漏过则无人发现。
 *
 * 词形取只有解释性读法的形式。指代输入值与普通位置的词（`原有顺序`、`之前`、`换成`）
 * 不收入规则。
 *
 * 标准 JSDoc 取值标签所在行（见 {@link JSDOC_VALUE_TAG}）不做散文判定。
 */
export const PROSE_RULES: readonly ProseRule[] = [
	{
		id: 'change-narration',
		summary: '变更叙述：陈述旧状态或新旧对照，而非当前行为',
		pattern: /(?:旧版本?|旧实现|旧写法|旧格式|旧逻辑|旧行为|旧键|老版本|早期版本|曾经|此前|以前|原先|原来|原实现|原方案|原逻辑|不再|改成|改为|迁移前|迁移后|升级前|升级后|\bused to\b|\bno longer\b|\bpreviously\b|\bformerly\b|\bold (?:behaviou?r|version|implementation|format)\b)/i,
	},
	{
		id: 'session-scope',
		summary: '会话与栈范围：只有编写会话能看到的范围限定',
		pattern: /(?:本次|这次|本轮|这轮|这一版|本版|下一版|后续版本|本 ?PR|本分支|后续 ?PR|\bthis (?:PR|change|commit|cut|patch|branch|stack)\b|\ba later PR\b|\bthe previous commit\b|\bin this branch\b)/i,
	},
	{
		id: 'review-audience',
		summary: '评审视角：面向评审者而不是维护者的论证',
		pattern: /(?:评审|审阅|\breviewer\b|\breviewed\b|\brejected in review\b|\bin review\b)/i,
	},
	{
		id: 'dead-session-ref',
		summary: '已死的草稿引用：决策、审计、阶段或轮次编号',
		pattern: /(?:\(decision \d+\)|decision \d+|§\s*\d|第\s*\d+\s*轮|审计 ?[A-Z]?\d|阶段\s*[A-Z]?\d|\b(?:T|W|P)-[A-Z]?\d{1,2}\b|方案\s*[A-Z]?\d|选项\s*[A-Z]?\d)/i,
	},
	{
		id: 'step-narration',
		summary: '控制流复述：按步骤叙述代码做了什么',
		pattern: /(?:第一步|第二步|第三步|首先|然后|接着|先.{0,8}再|\bfirst we\b|\bthen we\b|\bnext we\b)/i,
	},
	{
		id: 'planning-residue',
		summary: '规划残留：没有归属标记的待办、推迟或含糊措辞',
		pattern: /(?:\bTODO\b(?!\s*[(:：])|\bFIXME\b(?!\s*[(:：])|\bHACK\b(?!\s*[(:：])|\bXXX\b|待实现|待补|待定|先这样|暂且这样|暂时|临时|后续再|以后再|将来|未来|\bfor now\b|\blater\b|\bmaybe\b|\bprobably\b|\bshould be\b)/i,
	},
	{
		id: 'author-voice',
		summary: '作者口吻与推测：写作过程的判断而非可验证的事实',
		pattern: /(?:我认为|个人认为|我觉得|似乎|大概|也许|或许|显然|当然|其实|实际上|严格来说|\bI think\b|\bwe think\b|\bobviously\b|\bof course\b|\bactually\b)/i,
	},
	{
		id: 'decorative-metaphor',
		summary: '隐喻词：用比喻指代已有确切名称的对象',
		pattern: /(?:\bseam\b|\bvocabulary\b|词汇表|桥梁|胶水|魔法|管道)/i,
	},
]

/**
 * 标准 JSDoc 取值标签所在的行：`@param`、`@returns`、`@return`、`@yields`、`@yield`、
 * `@throws`、`@exception`。
 *
 * 这些标签的参数名与说明属于公开签名文档，其中指代当前调用点的词形照常放行。
 * 其余标签与标签外的注释照常扫描。
 */
const JSDOC_VALUE_TAG = /^\s*\*?\s*@(?:param|arg|argument|returns?|yields?|throws?|exception)(?:\s|\{|$)/i

/** 扫描状态以外的一条抽取结果：注释在原文件中的起止偏移与种类。 */
interface CommentRange {
	readonly start: number
	readonly end: number
	readonly block: boolean
}

/**
 * 豁免标记是否出现在一行注释文本里，成立时给出理由原文。
 *
 * @param text - 一行注释文本，已去掉注释定界符。
 * @returns 标记存在时的理由（可能为空串）；不存在时为 null。
 */
export function markerReason(text: string): string | null {
	const matched = EXEMPTION.exec(text)
	return matched === null ? null : (matched[1] ?? '').trim()
}

/**
 * 用 TypeScript 解析器取出一份源文件里的全部注释。
 *
 * 注释范围取自每个节点的前后注释 trivia，再剔除落在 JSX 文本节点里的部分：
 * `<div>// 文本</div>` 里的 `//` 是文本，不是注释，而 trivia 扫描按原文匹配
 * 会把它当成行注释。其余位置无需过滤——字符串、模板字面量、正则与 JSX 属性
 * 都不产生注释 trivia。
 *
 * @param fileName - 决定 TS 还是 TSX 解析；只看扩展名。
 * @param source - 源文件全文。
 * @returns 按起止偏移排序的注释范围。
 */
function collectCommentRanges(fileName: string, source: string): CommentRange[] {
	const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
	const jsxText: Array<readonly [number, number]> = []
	const ranges: CommentRange[] = []
	const seen = new Set<number>()

	const push = (start: number, end: number, block: boolean): void => {
		if (seen.has(start)) return
		seen.add(start)
		ranges.push({ start, end, block })
	}

	const visit = (node: ts.Node): void => {
		if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end])
		const tokenStart = node.getStart(file)
		// 只取落在首个 token 之前的 leading trivia：范围一旦越过 token 起点，命中的
		// 就是段落内的文本（JSX 文本里的 `//` 即如此），不是注释。
		for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
			if (range.end <= tokenStart) push(range.pos, range.end, range.kind === ts.SyntaxKind.MultiLineCommentTrivia)
		}
		for (const range of ts.getTrailingCommentRanges(source, node.end) ?? []) {
			if (range.pos >= node.end) push(range.pos, range.end, range.kind === ts.SyntaxKind.MultiLineCommentTrivia)
		}
		// 必须走 getChildren 而不是 forEachChild：JSX 表达式里的注释只挂在子 token 上，
		// forEachChild 会把整段 JSX 子节点当文本跳过。
		for (const child of node.getChildren(file)) visit(child)
	}
	visit(file)

	return ranges
		.filter((range) => !jsxText.some(([start, end]) => range.start >= start && range.start < end))
		.sort((left, right) => left.start - right.start)
}

/** 计算每个偏移所在行的 1 基行号。 */
function lineLocator(source: string): (offset: number) => number {
	const starts = [0]
	for (let index = 0; index < source.length; index++) {
		if (source[index] === '\n') starts.push(index + 1)
	}
	return (offset: number): number => {
		let low = 0
		let high = starts.length - 1
		while (low < high) {
			const middle = Math.ceil((low + high) / 2)
			if ((starts[middle] ?? 0) <= offset) low = middle
			else high = middle - 1
		}
		return low + 1
	}
}

/** 把一条注释范围拆成逐行文本，去掉定界符。 */
function splitComment(range: CommentRange, source: string, lineAt: (offset: number) => number): CommentLine[] {
	const body = range.block
		? source.slice(range.start + 2, Math.max(range.start + 2, range.end - 2))
		: source.slice(range.start + 2, range.end)
	const first = lineAt(range.start)
	return body.split('\n').map((text, index) => ({ line: first + index, text }))
}

/**
 * 抽取一个源文件里的注释段。
 *
 * 相邻的 `//` 行合成一段，块注释独立成段；豁免标记作用于它所在的整段。
 *
 * @param fileName - 决定 TS 还是 TSX 解析。
 * @param source - 源文件全文。
 * @returns 按出现顺序排列的注释段。
 */
export function extractCommentBlocks(fileName: string, source: string): CommentBlock[] {
	const lineAt = lineLocator(source)
	const blocks: CommentBlock[] = []
	let previous: { block: boolean; lines: CommentLine[] } | null = null
	const flush = (): void => {
		if (previous !== null) blocks.push({ lines: previous.lines, marker: firstMarker(previous.lines) })
		previous = null
	}
	for (const range of collectCommentRanges(fileName, source)) {
		const lines = splitComment(range, source, lineAt)
		const tail = previous?.lines[previous.lines.length - 1]
		const head = lines[0]
		const merged = previous !== null
			&& !previous.block
			&& !range.block
			&& tail !== undefined
			&& head !== undefined
			&& head.line === tail.line + 1
		if (merged && previous !== null) previous.lines.push(...lines)
		else {
			flush()
			previous = { block: range.block, lines }
		}
	}
	flush()
	return blocks
}

/**
 * 取一段注释里的第一条豁免标记。
 *
 * @param lines - 该段的各行。
 * @returns 标记所在行与理由；没有标记时为 null。
 */
function firstMarker(lines: readonly CommentLine[]): { line: number; reason: string } | null {
	for (const entry of lines) {
		const reason = markerReason(entry.text)
		if (reason !== null) return { line: entry.line, reason }
	}
	return null
}

/** 豁免标记没有写理由时的规则标识。 */
export const MARKER_WITHOUT_REASON = 'marker-without-reason'

/**
 * 扫描一个源文件的注释，返回全部命中。
 *
 * 一行注释只报一条：命中多条规则时按规则表顺序取第一条，避免同一处写法被
 * 重复计数。
 *
 * 带理由的豁免标记让整段跳过散文规则；标记理由为空时该段不做豁免，另加一条
 * `marker-without-reason`。
 *
 * @param file - 相对仓库的斜杠路径，用于报告，同时决定 TS 还是 TSX 解析。
 * @param source - 源文件全文。
 * @returns 按行号排列的命中。
 */
export function scanSource(file: string, source: string): Violation[] {
	const out: Violation[] = []
	for (const block of extractCommentBlocks(file, source)) {
		if (block.marker !== null && block.marker.reason !== '') continue
		if (block.marker !== null) {
			const text = block.lines.find((entry) => entry.line === block.marker?.line)?.text ?? ''
			out.push({ file, line: block.marker.line, rule: MARKER_WITHOUT_REASON, text: text.trim() })
		}
		for (const entry of block.lines) {
			if (JSDOC_VALUE_TAG.test(entry.text)) continue
			const rule = PROSE_RULES.find((candidate) => candidate.pattern.test(entry.text))
			if (rule !== undefined) out.push({ file, line: entry.line, rule: rule.id, text: entry.text.trim() })
		}
	}
	return out.sort((left, right) => left.line - right.line)
}

/**
 * 某条规则的说明。
 *
 * @param id - 规则标识。
 * @returns 该规则拦下的写法类型；未知标识原样返回。
 */
export function ruleSummary(id: string): string {
	if (id === MARKER_WITHOUT_REASON) return '豁免标记缺少理由'
	return PROSE_RULES.find((rule) => rule.id === id)?.summary ?? id
}

/** 基线中的一条存量记录：文件、规则与注释原文三元组。 */
export type BaselineEntry = readonly [file: string, rule: string, text: string]

/** 把一处命中折成基线记录。 */
export function baselineEntryOf(violation: Violation): BaselineEntry {
	return [violation.file, violation.rule, violation.text]
}

/**
 * 逐条核销基线，返回基线未覆盖的命中。
 *
 * 同一条记录在基线与当前扫描结果中各出现 N 次时按次数核销：注释被复制到别处会产生
 * 第二次命中，只比对记录是否存在会让基线随单处命中的份数失效。
 *
 * @param violations - 本次扫描的全部命中。
 * @param baseline - 基线里的存量记录，可含重复项。
 * @returns 基线之外的命中，顺序与输入一致。
 */
export function newViolations(violations: readonly Violation[], baseline: readonly BaselineEntry[]): Violation[] {
	const remaining = new Map<string, number>()
	for (const entry of baseline) {
		const key = JSON.stringify(entry)
		remaining.set(key, (remaining.get(key) ?? 0) + 1)
	}
	const added: Violation[] = []
	for (const violation of violations) {
		const key = JSON.stringify(baselineEntryOf(violation))
		const left = remaining.get(key) ?? 0
		if (left > 0) remaining.set(key, left - 1)
		else added.push(violation)
	}
	return added
}
