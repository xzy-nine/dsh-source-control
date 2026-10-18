/**
 * 生成 AI 提交信息所需的 diff 收集。
 *
 * 只依赖 git 执行层与 node，因此可以被测试直接导入。
 * 分两条路径：普通提交取暂存（或工作区）的改动；修补上一次提交时取
 * `HEAD~1 → 工作区` 的合并 diff，把上一提交的改动一并纳入。
 * 两条路径都按文件块截断超长 diff，再按小改动优先填至总量上限。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { gitOrThrow } from './working-tree.js';

/** 单文件 diff 长度上限（字符）。 */
export const SINGLE_DIFF_MAX = 50_000;
/** diff 总长度上限（字符）。 */
export const DIFF_TOTAL_MAX = 500_000;
/** 单文件 diff 被截断时追加的标记。 */
export const TRUNCATED_NOTE = '\n... 差异过长，以下内容已截断 ...\n';

/** 文件块分隔行；统一差异的每个文件块以该行开头。 */
const BLOCK_HEADER = 'diff --git ';

/**
 * 把单文件 diff 收进长度上限。
 *
 * 超限时保留前段并追加截断标记：整段丢弃会让只有大文件改动的仓库
 * 落到「无 diff」分支。
 *
 * @param diff - diff 文本。
 * @param limit - 上限字符数。
 * @returns 不超过上限的文本；未超限时原样返回。
 */
export function fitSingleDiff(diff: string, limit: number): string {
	if (diff.length <= limit) return diff;
	return diff.slice(0, Math.max(0, limit - TRUNCATED_NOTE.length)) + TRUNCATED_NOTE;
}

/**
 * 按文件块切分统一差异。
 *
 * 差异正文的行以 `+`、`-` 或空格开头，因此行首的 `diff --git ` 只会出现在块首。
 *
 * @param diff - 整份统一差异。
 * @returns 各文件块；空输入返回空数组。
 */
export function splitDiffBlocks(diff: string): string[] {
	if (diff === '') return [];
	const blocks: string[] = [];
	let start = -1;
	let offset = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith(BLOCK_HEADER)) {
			if (start >= 0) blocks.push(diff.slice(start, offset));
			start = offset;
		}
		offset += line.length + 1;
	}
	if (start >= 0) blocks.push(diff.slice(start));
	return blocks;
}

/**
 * 按长度升序贪心填充至总上限，使小改动优先进入提示词。
 *
 * @param blocks - 各文件块。
 * @param budget - 上限字符数。
 * @returns 拼接后的文本。
 */
function fillBudget(blocks: readonly string[], budget: number): string {
	const sorted = [...blocks].sort((left, right) => left.length - right.length);
	const parts: string[] = [];
	let total = 0;
	for (const block of sorted) {
		if (total + block.length > budget) break;
		parts.push(block);
		total += block.length + 1;
	}
	return parts.join('\n');
}

/**
 * 取一份统一差异并按文件块截断。
 *
 * @param repo - 仓库路径。
 * @param args - 取 diff 的 git 参数，不含 `--no-color`。
 * @returns 各文件块；git 失败时返回空数组。
 */
async function diffBlocks(repo: string, args: readonly string[]): Promise<string[]> {
	try {
		const diff = await gitOrThrow([...args, '--no-color'], repo);
		return splitDiffBlocks(diff).map((block) => fitSingleDiff(block, SINGLE_DIFF_MAX));
	} catch {
		return [];
	}
}

/**
 * 为未跟踪文件手工构造 patch。
 *
 * `git diff` 不包含未跟踪文件，但它们同样属于提交内容，需要单独补上。
 *
 * @param repo - 仓库路径。
 * @param filePath - 文件相对路径。
 * @returns patch 文本；读失败时返回空串。
 */
export async function untrackedPatch(repo: string, filePath: string): Promise<string> {
	try {
		const abs = nodePath.resolve(repo, filePath);
		const content = await fs.readFile(abs, 'utf8');
		const lines = content.split('\n');
		if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
		const header = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
		const body = lines.map((l) => '+' + l).join('\n');
		return header + body + '\n';
	} catch {
		return '';
	}
}

/**
 * 取一组路径。
 *
 * 一律用 `-z`：NUL 分隔下 git 不做转义，非 ASCII 路径（如中文文件名）保持原样。
 *
 * @param repo - 仓库路径。
 * @param args - 取路径的 git 参数（不含 `-z`）。
 * @returns 路径数组；失败时返回空数组。
 */
async function listPaths(repo: string, args: readonly string[]): Promise<string[]> {
	try {
		const out = await gitOrThrow([...args, '-z'], repo);
		return out.split('\0').filter((path) => path.length > 0);
	} catch {
		return [];
	}
}

/**
 * 取仓库中全部未跟踪文件的 patch。
 *
 * @param repo - 仓库路径。
 * @param budget - 还可容纳的字符数。
 * @returns 各文件块。
 */
async function untrackedPatches(repo: string, budget: number): Promise<string[]> {
	const parts: string[] = [];
	let total = 0;
	for (const file of await listPaths(repo, ['ls-files', '--others', '--exclude-standard'])) {
		const patch = await untrackedPatch(repo, file);
		if (patch.length === 0) continue;
		const fitted = fitSingleDiff(patch, SINGLE_DIFF_MAX);
		if (total + fitted.length > budget) break;
		parts.push(fitted);
		total += fitted.length + 1;
	}
	return parts;
}

/**
 * 收集普通提交的 diff：暂存优先，否则工作区 + 未跟踪。
 *
 * 暂存区有改动即以暂存内容为准：即使全为二进制等无文本差异的文件，
 * 也不回退到工作区，否则会把未暂存的改动混进提交信息。
 *
 * @param repo - 仓库路径。
 * @returns diff 文本；无内容时返回空串。
 */
async function collectWorkingDiff(repo: string): Promise<string> {
	const stagedNames = await listPaths(repo, ['diff', '--cached', '--name-only']);
	if (stagedNames.length > 0) return fillBudget(await diffBlocks(repo, ['diff', '--cached']), DIFF_TOTAL_MAX);
	const working = await diffBlocks(repo, ['diff']);
	const untracked = await untrackedPatches(repo, DIFF_TOTAL_MAX);
	return fillBudget([...working, ...untracked], DIFF_TOTAL_MAX);
}

/**
 * 收集修补上一次提交时的 diff。
 *
 * 取 `HEAD~1 → 工作区` 的合并差异：既含上一次提交已有的改动，也含当前暂存与工作区的
 * 改动，与 `git commit --amend` 之后的最终内容一致。没有父提交（首次提交）时退回
 * `HEAD → 工作区`，此时上一次提交本身就是根提交。
 *
 * @param repo - 仓库路径。
 * @returns diff 文本；无内容时返回空串。
 */
async function collectAmendDiff(repo: string): Promise<string> {
	// 有父提交时对比 HEAD~1，否则（根提交）对比 HEAD 本身。
	let base = '';
	try {
		base = (await gitOrThrow(['rev-parse', '--verify', '--quiet', 'HEAD~1'], repo)).trim();
	} catch {
		base = '';
	}
	const tracked = await diffBlocks(repo, ['diff', base === '' ? 'HEAD' : base]);
	// `git diff` 不含未跟踪文件，单独补上。
	const untracked = await untrackedPatches(repo, DIFF_TOTAL_MAX);
	return fillBudget([...tracked, ...untracked], DIFF_TOTAL_MAX);
}

/**
 * 收集用于生成提交信息的 diff。
 *
 * @param repo - 仓库路径。
 * @param amend - 是否修补上一次提交；为真时把上一提交的改动一并纳入。
 * @returns diff 文本；无内容时返回空串。
 */
export async function collectDiff(repo: string, amend = false): Promise<string> {
	return amend ? collectAmendDiff(repo) : collectWorkingDiff(repo);
}
