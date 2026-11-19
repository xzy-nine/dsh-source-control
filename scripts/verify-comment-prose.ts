/**
 * 注释散文门禁：拦下 `src/` 里可机械识别的解释性注释。
 *
 * 规则见 `scripts/comment-prose.ts`，散文标准的正家在
 * `.agents/skills/source-control-prose-standard/SKILL.md`。命中不等于定论：确需保留的
 * 注释在行上写 `prose-ok: <理由>` 豁免，或由基线记录为存量。
 *
 * 存量记 `comment-prose-baseline.json`，按「文件 + 规则 + 注释原文」比对，不含行号：
 * 无关改动不会让基线失效，改写过的注释则算新命中。基线只允许调低。
 *
 * 用法：tsx scripts/verify-comment-prose.ts [--staged] [--update]
 *   --staged  只查本次暂存的 src 目录 TypeScript 文件，供 pre-commit 使用。
 *   --update  按当前扫描结果重写基线。
 *
 * @module scripts/verify-comment-prose
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gateHint } from './gate-hint.ts'
import { repoRoot } from './doc-system.config.ts'
import { uniqueRepoFiles } from './repo-files.ts'
import { PROSE_RULES, baselineEntryOf, newViolations, ruleSummary, scanSource, type BaselineEntry } from './comment-prose.ts'

/** 扫描范围：与 `pnpm lint` 的处理对象一致。 */
const PATTERNS = ['src/**/*.ts', 'src/**/*.tsx'] as const

/** 基线文件，相对仓库根。 */
const BASELINE = 'comment-prose-baseline.json'

/** 本次要扫描的绝对路径。 */
function targets(): string[] {
	if (!process.argv.includes('--staged')) {
		return uniqueRepoFiles(repoRoot, PATTERNS).map((file) => file.abs)
	}
	// 路径必须 NUL 分隔：仓库路径可以含空格与制表符，按行切分会拆错。
	const raw = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
		cwd: repoRoot,
		encoding: 'utf8',
	})
	return raw
		.split('\0')
		.filter((path) => /^src\/.*\.tsx?$/.test(path))
		.map((path) => join(repoRoot, path))
}

const files = targets()
const violations = files.flatMap((abs) => scanSource(relative(repoRoot, abs).split('\\').join('/'), readFileSync(abs, 'utf8')))
const baselinePath = join(repoRoot, BASELINE)

if (process.argv.includes('--update')) {
	// 不去重：核销按次数进行，同一处文字在文件里出现两次就要占两条基线记录，
	// 否则第二处会被当成新命中，而复制注释正是需要被拦下的情况。
	const entries = violations
		.map((violation) => JSON.stringify(baselineEntryOf(violation)))
		.sort()
		.map((key) => JSON.parse(key) as BaselineEntry)
	writeFileSync(baselinePath, `${JSON.stringify({
		note: '已接受的存量解释性注释；只允许调低。新增命中应改写散文或就地加 prose-ok 标记。',
		count: entries.length,
		entries,
	}, null, 2)}\n`)
	console.log(`verify-comment-prose: 基线已更新，${entries.length} 处`)
	process.exit(0)
}

const baseline: BaselineEntry[] = existsSync(baselinePath)
	? (JSON.parse(readFileSync(baselinePath, 'utf8')) as { entries?: BaselineEntry[] }).entries ?? []
	: []
const added = newViolations(violations, baseline)

if (added.length === 0) {
	const scope = process.argv.includes('--staged') ? 'staged file(s)' : 'file(s)'
	console.log(`verify-comment-prose: ${files.length} ${scope} checked, no new explanatory comments.`)
	process.exit(0)
}

console.error(`verify-comment-prose: 新增 ${added.length} 处解释性注释（基线 ${baseline.length} 处）：`)
for (const violation of added) {
	console.error(`  ${violation.file}:${violation.line}  [${violation.rule}] ${violation.text.slice(0, 90)}`)
}
const rules = [...new Set(added.map((violation) => violation.rule))]
console.error('')
for (const rule of rules) console.error(`  ${rule}: ${ruleSummary(rule)}`)
console.error(`  规则共 ${PROSE_RULES.length} 条；改写为说明当前行为的散文，或在整段注释上写 prose-ok: <理由>。`)
console.error(gateHint('verify-comment-prose'))
process.exit(1)
