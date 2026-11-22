/**
 * 分段暂存与取消暂存：按补丁块只动索引里的这一块。
 *
 * 整文件的 `git add` / `git restore --staged` 改不了「同一文件里只暂存一半」这类诉求。
 * 这里把该文件的补丁按块切开，只把选中的块交回 `git apply --cached`：正向是暂存，
 * `-R` 是取消暂存。补丁必须基于当前索引生成，否则块与索引对不上。
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOrThrow, runGitAttempt } from './git-exec.js';
import { parsePatch, patchOf } from '../shared/patch-hunks.js';

/** 一次分段操作的结果。 */
export interface HunkApplyOutcome {
	/** 实际处理的文件路径。 */
	readonly path: string;
	/** 处理的块下标。 */
	readonly hunks: readonly number[];
	/** 失败原因；成功为 null。 */
	readonly error: string | null;
}

/** 补丁临时文件的前缀。 */
const PATCH_PREFIX = 'dsh-sc-hunk-';

/**
 * 生成某个文件的当前补丁。
 *
 * 用零上下文（`-U0`）取块：块里只有红绿本身，不含未改动的上下文行。上下文只为了让
 * 人看懂位置，对「暂存这一处改动」没有作用；带上它会让相邻改动被并成一块、也让每一块
 * 在视图里看起来比实际改动更宽。重放时配 `--unidiff-zero`，git 才接受没有上下文的补丁。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @returns 补丁文本；工作区与索引都没有差异时为空串。
 */
export async function filePatchOf(repo: string, path: string): Promise<string> {
	return await gitOrThrow(['diff', '--no-color', '--no-ext-diff', '--unified=0', '--', path], repo);
}

/**
 * 把一个补丁交给 `git apply` 处理。
 *
 * 补丁经临时文件传入：`git apply` 从标准输入读补丁时，空补丁与参数错误的表现一致，
 * 而临时文件让失败信息里能带出具体行号。
 *
 * @param repo - 仓库路径。
 * @param patchText - 补丁文本。
 * 补丁按零上下文切出，因此重放要带 `--unidiff-zero`：git 默认拒绝没有上下文的块。
 *
 * @param args - 额外的 git apply 参数（`--cached`、`-R` 等）。
 * @returns 失败原因；成功为 null。
 */
async function applyPatch(repo: string, patchText: string, args: readonly string[]): Promise<string | null> {
	if (patchText === '') return null;
	const dir = mkdtempSync(join(tmpdir(), PATCH_PREFIX));
	const file = join(dir, 'patch.diff');
	try {
		writeFileSync(file, patchText, 'utf8');
		return await runGitAttempt(['apply', '--unidiff-zero', ...args, '--whitespace=nowarn', '--', file], repo);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * 暂存或取消暂存若干补丁块。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @param indexes - 块下标；空数组表示整份补丁。
 * @param direction - `stage` 把工作区改动写进索引，`unstage` 把索引里这一块退回工作区。
 * @returns 处理结局。
 */
export async function applyHunks(
	repo: string, path: string, indexes: readonly number[], direction: 'stage' | 'unstage',
): Promise<HunkApplyOutcome> {
	/*
	 * 暂存基于「工作区相对索引」的补丁，取消暂存基于「索引相对 HEAD」的补丁：
	 * 两处的块号是各自补丁里的下标，因此必须用对应那份补丁来切。
	 */
	const patchText = direction === 'stage'
		? await filePatchOf(repo, path)
		: await gitOrThrow(['diff', '--cached', '--no-color', '--no-ext-diff', '--unified=0', '--', path], repo);
	const parsed = parsePatch(patchText);
	if (parsed.hunks.length === 0) {
		return { path, hunks: [], error: '该文件没有可分段处理的改动' };
	}
	const wanted = indexes.length === 0 ? parsed.hunks.map((hunk) => hunk.index) : [...indexes];
	const missing = wanted.filter((index) => !parsed.hunks.some((hunk) => hunk.index === index));
	if (missing.length > 0) {
		return { path, hunks: [], error: `补丁里没有这些块：${missing.join('、')}` };
	}
	const patch = patchOf(parsed, wanted);
	const args = direction === 'stage' ? ['--cached'] : ['--cached', '-R'];
	const error = await applyPatch(repo, patch, args);
	return { path, hunks: error === null ? wanted : [], error };
}

/**
 * 取一个文件在索引与工作区两侧的补丁块范围。
 *
 * 供差异页把「当前显示的第几个 hunk」对回补丁块：两侧的块顺序一致，但行号来自各自那份补丁。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @param staged - true 取索引相对 HEAD 的补丁，false 取工作区相对索引的补丁。
 * @returns 各块的块头与下标；无改动时为空数组。
 */
export async function hunkListOf(repo: string, path: string, staged: boolean): Promise<Array<{ index: number; header: string; oldStart: number; oldLines: number; newStart: number; newLines: number }>> {
	const patchText = staged
		? await gitOrThrow(['diff', '--cached', '--no-color', '--no-ext-diff', '--unified=0', '--', path], repo)
		: await filePatchOf(repo, path);
	return parsePatch(patchText).hunks.map((hunk) => ({
		index: hunk.index, header: hunk.header.trimEnd(),
		oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines,
	}));
}
