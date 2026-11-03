/**
 * 生成 AI 提交信息所需的 diff 收集。
 *
 * 只依赖 git 执行层与 node，因此可以被测试直接导入。
 * 分两条路径：普通提交取暂存（或工作区）的改动；修补上一次提交时取
 * `HEAD~1 → 工作区` 的合并 diff，把上一提交的改动一并纳入。
 *
 * 进入提示词前分三层：二进制文件只留文件名；文档类改动排在代码之后；
 * 再按文件块截断超长 diff 并按总量上限填充。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { gitOrThrow } from './working-tree.js';
import { repoLayout } from './repo-facts.js';

/** 单文件 diff 长度上限（字符）。 */
export const SINGLE_DIFF_MAX = 50_000;
/** diff 总长度上限（字符）。 */
export const DIFF_TOTAL_MAX = 500_000;
/** 单文件 diff 被截断时追加的标记。 */
export const TRUNCATED_NOTE = '\n... 差异过长，以下内容已截断 ...\n';

/** 按文档处理、在有代码改动时排在代码之后的扩展名。 */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'org']);

/** 文件块分隔行；统一差异的每个文件块以该行开头。 */
const BLOCK_HEADER = 'diff --git ';

/** 判定二进制内容时扫描的字节数。 */
const BINARY_PROBE_BYTES = 8000;

/** 一个文件块及其分类。 */
export interface DiffFile {
	/** 文件路径，相对仓库根。 */
	readonly path: string;
	/** 已按单文件上限截断的补丁文本；二进制文件为空串。 */
	readonly block: string;
	/** 二进制文件：内容不进提示词，只列文件名。 */
	readonly binary: boolean;
	/** 文档类文件：排在代码之后填充。 */
	readonly doc: boolean;
}

/** 因长度上限未进入提示词的改动。 */
export interface DroppedFile {
	/** 文件路径。 */
	readonly path: string;
	/** 未进入提示词的原因：文档让位给代码，或超出总量上限。 */
	readonly reason: 'document' | 'budget';
}

/** 被合并入的提交。 */
export interface MergedCommit {
	/** 短哈希。 */
	readonly hash: string;
	/** 完整提交信息。 */
	readonly body: string;
}

/** 一次收集的结果。 */
export interface CollectedDiff {
	/** 进入提示词的差异文本；无文本改动时为空串。 */
	readonly diff: string;
	/** 二进制文件路径，按 git 的输出顺序。 */
	readonly binary: readonly string[];
	/** 被合并入的提交；非合并提交时为空。 */
	readonly merged: readonly MergedCommit[];
	/** 因长度上限未进入提示词的改动。 */
	readonly dropped: readonly DroppedFile[];
}

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
 * 判断路径是否为文档类文件。
 *
 * 只看文件名里的最后一个扩展名：目录名中的点不参与判定。
 *
 * @param path - 文件路径。
 * @returns 属于文档扩展名时为 true。
 */
export function isDocPath(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	if (dot < 0) return false;
	return DOC_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** numstat 记录的首字段形态；重命名记录后紧跟的旧路径不以此开头。 */
const NUMSTAT_RECORD = /^(\d+|-)\t(\d+|-)\t/;

/**
 * 解析 `--numstat -z` 的记录段。
 *
 * 二进制文件的增删列都是 `-`。重命名记录后跟一条旧路径，旧路径不构成独立记录：
 * 新路径已经代表了这次改动。
 *
 * @param parts - 按 NUL 切开的记录段。
 * @returns 记录列表。
 */
function numstatRecords(parts: readonly string[]): Array<{ path: string; binary: boolean }> {
	const records: Array<{ path: string; binary: boolean }> = [];
	for (const part of parts) {
		const match = NUMSTAT_RECORD.exec(part);
		if (match === null) continue;
		records.push({ path: part.slice(match[0].length), binary: match[1] === '-' && match[2] === '-' });
	}
	return records;
}

/**
 * 解析 `--numstat -z -p` 的合并输出。
 *
 * 前半段是 NUL 分隔的 numstat 记录，空记录之后是补丁正文；两段按 git 的输出顺序一一对应。
 * 路径取自 numstat 而不是补丁头：补丁头里的 `a/… b/…` 在含空格的路径上无法无歧义还原。
 *
 * @param stdout - git 的标准输出。
 * @returns 各文件块；记录数与补丁块数不一致时按两者较小值配对。
 */
function parseNumstatWithPatch(stdout: string): DiffFile[] {
	const parts = stdout.split('\0');
	const boundary = parts.indexOf('');
	if (boundary < 0) return [];
	const records = numstatRecords(parts.slice(0, boundary));
	const blocks = splitDiffBlocks(parts.slice(boundary + 1).join('\0'));
	const count = Math.min(records.length, blocks.length);
	const files: DiffFile[] = [];
	for (let at = 0; at < count; at += 1) {
		const record = records[at];
		files.push({
			path: record.path,
			block: fitSingleDiff(blocks[at], SINGLE_DIFF_MAX),
			binary: record.binary,
			doc: isDocPath(record.path),
		});
	}
	return files;
}

/**
 * 取一份统一差异及其文件元数据。
 *
 * 一次调用同时取 numstat 与补丁：分两次调用时两段输出可能读自不同的工作区状态。
 * `core.quotePath=false` 让非 ASCII 路径以原文出现在补丁头里。
 *
 * @param repo - 仓库路径。
 * @param args - 取 diff 的 git 参数，不含 `--no-color`。
 * @returns 各文件块；git 失败时返回空数组。
 */
async function diffFiles(repo: string, args: readonly string[]): Promise<DiffFile[]> {
	try {
		const stdout = await gitOrThrow(['-c', 'core.quotePath=false', ...args, '--numstat', '-z', '-p', '--no-color'], repo);
		return parseNumstatWithPatch(stdout);
	} catch {
		return [];
	}
}

/** 按长度升序比较两个文件块。 */
function byLength(left: DiffFile, right: DiffFile): number {
	return left.block.length - right.block.length;
}

/**
 * 按优先级填充到总上限。
 *
 * 代码块在前、文档块在后，各自按长度升序：小改动先进入提示词，预算不足时文档让位。
 *
 * @param files - 各文本文件块。
 * @param budget - 上限字符数。
 * @returns 进入提示词的文本与因预算未进入的文件。
 */
function fillBudget(files: readonly DiffFile[], budget: number): { text: string; dropped: DroppedFile[] } {
	const ordered = [
		...files.filter((file) => !file.doc).sort(byLength),
		...files.filter((file) => file.doc).sort(byLength),
	];
	const parts: string[] = [];
	const dropped: DroppedFile[] = [];
	let total = 0;
	for (const file of ordered) {
		if (total + file.block.length > budget) {
			dropped.push({ path: file.path, reason: file.doc ? 'document' : 'budget' });
			continue;
		}
		parts.push(file.block);
		total += file.block.length + 1;
	}
	return { text: parts.join('\n'), dropped };
}

/**
 * 判断一段内容是否为二进制。
 *
 * 以文件头部的 NUL 字节为判据：按 UTF-8 读出的二进制内容会变成替换字符，
 * 进入提示词既无信息量又占预算。
 *
 * @param buffer - 文件内容。
 * @returns 二进制时为 true。
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
	const end = Math.min(buffer.length, BINARY_PROBE_BYTES);
	for (let at = 0; at < end; at += 1) if (buffer[at] === 0) return true;
	return false;
}

/**
 * 为一段文本构造新增文件的 patch。
 *
 * @param filePath - 文件相对路径。
 * @param content - 文件正文。
 * @returns patch 文本。
 */
function patchOfText(filePath: string, content: string): string {
	const lines = content.split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	const header = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
	const body = lines.map((line) => '+' + line).join('\n');
	return header + body + '\n';
}

/**
 * 为未跟踪文件构造 patch。
 *
 * `git diff` 不包含未跟踪文件，但它们同样属于提交内容，需要单独补上。
 *
 * @param repo - 仓库路径。
 * @param filePath - 文件相对路径。
 * @returns patch 文本；读失败或内容为二进制时返回 null。
 */
export async function untrackedPatch(repo: string, filePath: string): Promise<string | null> {
	try {
		const buffer = await fs.readFile(nodePath.resolve(repo, filePath));
		return isBinaryBuffer(buffer) ? null : patchOfText(filePath, buffer.toString('utf8'));
	} catch {
		return null;
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
 * 取仓库中全部未跟踪文件的块。
 *
 * @param repo - 仓库路径。
 * @returns 各文件块；二进制文件只记路径。
 */
async function untrackedFiles(repo: string): Promise<DiffFile[]> {
	const files: DiffFile[] = [];
	for (const file of await listPaths(repo, ['ls-files', '--others', '--exclude-standard'])) {
		const patch = await untrackedPatch(repo, file);
		const doc = isDocPath(file);
		if (patch === null) {
			files.push({ path: file, block: '', binary: true, doc });
			continue;
		}
		files.push({ path: file, block: fitSingleDiff(patch, SINGLE_DIFF_MAX), binary: false, doc });
	}
	return files;
}

/**
 * 收集普通提交的文件块：暂存优先，否则工作区 + 未跟踪。
 *
 * 暂存区有改动即以暂存内容为准：即使全为二进制等无文本差异的文件，
 * 也不回退到工作区，否则会把未暂存的改动混进提交信息。
 *
 * @param repo - 仓库路径。
 * @returns 各文件块。
 */
async function workingFiles(repo: string): Promise<DiffFile[]> {
	const stagedNames = await listPaths(repo, ['diff', '--cached', '--name-only']);
	if (stagedNames.length > 0) return diffFiles(repo, ['diff', '--cached']);
	const working = await diffFiles(repo, ['diff']);
	return [...working, ...(await untrackedFiles(repo))];
}

/**
 * 收集修补上一次提交时的文件块。
 *
 * 取 `HEAD~1 → 工作区` 的合并差异：既含上一次提交已有的改动，也含当前暂存与工作区的
 * 改动，与 `git commit --amend` 之后的最终内容一致。没有父提交（首次提交）时退回
 * `HEAD → 工作区`，此时上一次提交本身就是根提交。
 *
 * @param repo - 仓库路径。
 * @returns 各文件块。
 */
async function amendFiles(repo: string): Promise<DiffFile[]> {
	// 有父提交时对比 HEAD~1，否则（根提交）对比 HEAD 本身。
	let base = '';
	try {
		base = (await gitOrThrow(['rev-parse', '--verify', '--quiet', 'HEAD~1'], repo)).trim();
	} catch {
		base = '';
	}
	const tracked = await diffFiles(repo, ['diff', base === '' ? 'HEAD' : base]);
	// `git diff` 不含未跟踪文件，单独补上。
	return [...tracked, ...(await untrackedFiles(repo))];
}

/**
 * 取进行中合并的被合并入提交。
 *
 * `MERGE_HEAD` 每行一个提交哈希，章鱼合并因此有多行；该文件只在合并尚未提交时存在。
 *
 * @param repo - 仓库路径。
 * @returns 提交哈希列表；不在合并中时为空数组。
 */
async function mergeHeadHashes(repo: string): Promise<string[]> {
	const layout = await repoLayout(repo);
	if (layout === null) return [];
	try {
		const text = await fs.readFile(nodePath.join(layout.gitDir, 'MERGE_HEAD'), 'utf8');
		return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
	} catch {
		return [];
	}
}

/**
 * 取被修补的合并提交的被合并入提交。
 *
 * 合并提交的第二父提交起即被合并入的分支；修补普通提交时为空数组。
 *
 * @param repo - 仓库路径。
 * @returns 提交哈希列表。
 */
async function amendMergeParents(repo: string): Promise<string[]> {
	try {
		const out = (await gitOrThrow(['rev-list', '--parents', '-n', '1', 'HEAD'], repo)).trim();
		// 首个字段是 HEAD 自身，其后是各父提交；第二个起才是被合并入的分支。
		return out.split(' ').filter((field) => field !== '').slice(2);
	} catch {
		return [];
	}
}

/**
 * 取被合并入的提交及其完整信息。
 *
 * 合并进行中取 `MERGE_HEAD` 指向的提交；修补合并提交时取它的第二父提交起。
 *
 * @param repo - 仓库路径。
 * @param amend - 是否修补上一次提交。
 * @returns 各提交的短哈希与完整信息；不是合并提交时为空数组。
 */
async function mergedCommits(repo: string, amend: boolean): Promise<MergedCommit[]> {
	const inProgress = await mergeHeadHashes(repo);
	const hashes = inProgress.length > 0 ? inProgress : (amend ? await amendMergeParents(repo) : []);
	if (hashes.length === 0) return [];
	try {
		// `-z` 让提交之间以 NUL 分隔，与 `%h%x00%B` 的两个字段对齐成固定的一对一。
		const out = await gitOrThrow(['log', '--no-walk=unsorted', '-z', '--format=%h%x00%B', ...hashes], repo);
		const fields = out.split('\0');
		const merged: MergedCommit[] = [];
		for (let at = 0; at + 1 < fields.length; at += 2) {
			const hash = fields[at].trim();
			if (hash === '') continue;
			merged.push({ hash, body: fields[at + 1].trim() });
		}
		return merged;
	} catch {
		return [];
	}
}

/**
 * 收集用于生成提交信息的改动。
 *
 * @param repo - 仓库路径。
 * @param amend - 是否修补上一次提交；为真时把上一提交的改动一并纳入。
 * @returns 差异文本、二进制文件、被合并入的提交与因上限未纳入的改动。
 */
export async function collectDiff(repo: string, amend = false): Promise<CollectedDiff> {
	const files = amend ? await amendFiles(repo) : await workingFiles(repo);
	const binary = files.filter((file) => file.binary).map((file) => file.path);
	const filled = fillBudget(files.filter((file) => !file.binary), DIFF_TOTAL_MAX);
	return {
		diff: filled.text,
		binary,
		merged: await mergedCommits(repo, amend),
		dropped: filled.dropped,
	};
}
