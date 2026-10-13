/**
 * 生成 AI 提交信息所需的 diff 收集。
 *
 * 只依赖 git 执行层与 node，因此可以被测试直接导入。
 * 分两条路径：普通提交取暂存（或工作区）的改动；修补上一次提交时取
 * `HEAD~1 → 工作区` 的合并 diff，把上一提交的改动一并纳入。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { gitOrThrow } from './working-tree.js';

/** 单文件 diff 长度上限（字符）。 */
export const SINGLE_DIFF_MAX = 50_000;
/** diff 总长度上限（字符）。 */
export const DIFF_TOTAL_MAX = 500_000;

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
 * 一律用 `-z`：NUL 分隔下 git 不做转义，非 ASCII 路径（如中文文件名）保持原样，
 * 可直接作为 pathspec 使用。默认 `core.quotepath=true` 时，`--name-only` 会把非 ASCII
 * 路径写成加引号的八进制转义，拿它当 pathspec 匹配不到任何文件。
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
 * @returns patch 文本与各自长度之和。
 */
async function untrackedPatches(repo: string, budget: number): Promise<{ parts: string[]; total: number }> {
	const parts: string[] = [];
	let total = 0;
	for (const file of await listPaths(repo, ['ls-files', '--others', '--exclude-standard'])) {
		const patch = await untrackedPatch(repo, file);
		if (patch.length === 0 || patch.length >= SINGLE_DIFF_MAX) continue;
		if (total + patch.length > budget) break;
		parts.push(patch);
		total += patch.length + 1;
	}
	return { parts, total };
}

/**
 * 收集普通提交的 diff：暂存优先，否则工作区 + 未跟踪。
 *
 * 逐文件取 diff，超 SINGLE_DIFF_MAX 丢弃，按长度升序贪心填至 DIFF_TOTAL_MAX。
 *
 * @param repo - 仓库路径。
 * @returns diff 文本；无内容时返回空串。
 */
async function collectWorkingDiff(repo: string): Promise<string> {
	const diffs: string[] = [];
	try {
		const stagedFiles = await listPaths(repo, ['diff', '--cached', '--name-only']);
		if (stagedFiles.length > 0) {
			for (const f of stagedFiles) {
				try {
					const d = await gitOrThrow(['diff', '--cached', '--no-color', '--', f], repo);
					if (d.length > 0 && d.length < SINGLE_DIFF_MAX) diffs.push(d);
				} catch { /* 单个文件失败不影响其余 */ }
			}
		} else {
			const workingFiles = await listPaths(repo, ['diff', '--name-only']);
			for (const f of workingFiles) {
				try {
					const d = await gitOrThrow(['diff', '--no-color', '--', f], repo);
					if (d.length > 0 && d.length < SINGLE_DIFF_MAX) diffs.push(d);
				} catch { /* 单个文件失败不影响其余 */ }
			}
			const untracked = await untrackedPatches(repo, DIFF_TOTAL_MAX);
			for (const patch of untracked.parts) {
				if (patch.length > 0 && patch.length < SINGLE_DIFF_MAX) diffs.push(patch);
			}
		}
	} catch {
		return '';
	}
	diffs.sort((a, b) => a.length - b.length);
	let total = 0;
	const parts: string[] = [];
	for (const d of diffs) {
		if (total + d.length > DIFF_TOTAL_MAX) break;
		parts.push(d);
		total += d.length + 1;
	}
	return parts.join('\n');
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
	const parts: string[] = [];
	let total = 0;
	try {
		const diff = await gitOrThrow(['diff', '--no-color', base === '' ? 'HEAD' : base], repo);
		if (diff.length > 0 && diff.length < DIFF_TOTAL_MAX) {
			parts.push(diff);
			total += diff.length;
		}
	} catch {
		/* 没有可比较的提交时只算未跟踪文件 */
	}
	// `git diff` 不含未跟踪文件，单独补上。
	const untracked = await untrackedPatches(repo, Math.max(0, DIFF_TOTAL_MAX - total));
	parts.push(...untracked.parts);
	return parts.join('\n');
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
