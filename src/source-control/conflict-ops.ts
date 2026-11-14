/**
 * 冲突条目的解决：阶段取源、冲突差异与各解决动作的 git 命令。
 *
 * 未合并条目在索引里没有 stage 0，`git show :<路径>` 与 `git restore` 一律失败，
 * 因此取内容只能指到具体阶段（`:1:` 基线、`:2:` 我方、`:3:` 对方），解决动作也要
 * 按冲突种类分别落到 `checkout-index` / `add` / `rm` 上。种类判定与文案在
 * `shared/conflict-kind.ts`，客户端与宿主共用同一份。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { gitOrThrow } from './git-exec.js';
import { parseIndexEntries } from './git-parse.js';
import { conflictKindOfPair, type ConflictKind } from '../shared/conflict-kind.js';

/** 索引里某个路径的三个阶段是否存在。 */
export interface ConflictStages {
	/** 基线（共同祖先）是否存在。 */
	readonly base: boolean;
	/** 我方（当前分支）是否存在。 */
	readonly ours: boolean;
	/** 对方（被合并的一侧）是否存在。 */
	readonly theirs: boolean;
}

/** 一次冲突解决的结局。 */
export interface ResolveOutcome {
	/** 已处置的路径。 */
	readonly resolved: string[];
	/** 未能处置的路径与原因，按 git 原文；为空表示全部成功。 */
	readonly errors: string[];
}

/** 可执行的冲突解决动作。 */
export type ConflictAction = 'ours' | 'theirs' | 'delete' | 'markResolved' | 'restoreMarkers';

/** 全部解决动作；用于校验命令参数。 */
export const CONFLICT_ACTIONS: ReadonlySet<string> = new Set([
	'ours', 'theirs', 'delete', 'markResolved', 'restoreMarkers',
]);

/**
 * 读取一个未合并路径的阶段。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @returns 三个阶段是否存在；不是未合并条目时三者全为 false。
 */
export async function conflictStagesOf(repo: string, path: string): Promise<ConflictStages> {
	const stdout = await gitOrThrow(['ls-files', '-u', '-z', '--', path], repo);
	const stages = new Set(parseIndexEntries(stdout).map((entry) => entry.stage));
	return { base: stages.has(1), ours: stages.has(2), theirs: stages.has(3) };
}

/** 差异的一侧：取哪个引用、或直接取工作区文件。 */
export interface ConflictSide {
	/** 取内容的 git 引用前缀，形如 `HEAD:` 或 `:1:`；取工作区时为 null。 */
	readonly ref: string | null;
}

/** 一次冲突差异的两侧取源。 */
export interface ConflictSources {
	readonly old: ConflictSide;
	readonly next: ConflictSide;
}

/**
 * 按冲突种类给出差异两侧的取源。
 *
 * 与代码托管平台的评审视图同一口径：双方都留下内容时拿工作区（含冲突标记）比 HEAD；
 * 我方删除时比阶段 1 与对方内容，对方删除时比阶段 1 与我方内容。
 *
 * @param kind - 冲突种类。
 * @param stages - 该路径的阶段。
 * @returns 两侧取源。
 */
export function conflictSourcesOf(kind: ConflictKind, stages: ConflictStages): ConflictSources {
	const base = stages.base ? ':1:' : 'HEAD:';
	switch (kind) {
		case 'both-modified':
		case 'both-added':
			return { old: { ref: 'HEAD:' }, next: { ref: null } };
		case 'added-by-us':
		case 'deleted-by-them':
			return { old: { ref: base }, next: { ref: stages.ours ? ':2:' : 'HEAD:' } };
		case 'added-by-them':
		case 'deleted-by-us':
			return { old: { ref: base }, next: { ref: stages.theirs ? ':3:' : 'HEAD:' } };
		case 'both-deleted':
			return { old: { ref: base }, next: { ref: 'HEAD:' } };
		default:
			return { old: { ref: base }, next: { ref: null } };
	}
}

/** 一份冲突差异：补丁文本与是否为二进制。 */
export interface ConflictDiff {
	/** `git diff --no-color --unified=3` 的输出。 */
	readonly diffText: string;
	/** 两侧都是二进制内容。 */
	readonly binary: boolean;
}

/** git 对二进制文件给出的差异标记。 */
const BINARY_DIFF_MARKERS = ['Binary files ', 'GIT binary patch'];

/**
 * 取一个冲突文件的差异。
 *
 * 两侧都是引用时按 blob 之间比较（不经工作区，冲突未解决时也成立）；新侧取工作区时
 * 直接比较引用与工作区文件。失败按空差异返回：差异只是展示，不阻断条目本身。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @param sources - 两侧取源。
 * @returns 差异文本与二进制标记。
 */
export async function conflictDiffOf(repo: string, path: string, sources: ConflictSources): Promise<ConflictDiff> {
	const oldArg = sources.old.ref === null ? null : `${sources.old.ref}${path}`;
	const newArg = sources.next.ref === null ? null : `${sources.next.ref}${path}`;
	const args = oldArg !== null && newArg !== null
		? ['diff', '--no-color', '--unified=3', '--no-ext-diff', oldArg, newArg, '--', path]
		: oldArg !== null
			? ['diff', '--no-color', '--unified=3', '--no-ext-diff', oldArg, '--', path]
			: null;
	if (args === null) return { diffText: '', binary: false };
	try {
		const diffText = await gitOrThrow(args, repo);
		return { diffText, binary: BINARY_DIFF_MARKERS.some((marker) => diffText.includes(marker)) };
	} catch {
		return { diffText: '', binary: false };
	}
}

/**
 * 取一个未合并路径的一侧内容。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @param ref - 引用前缀，形如 `HEAD:` 或 `:2:`。
 * @returns 内容；该侧不存在时返回 null。
 */
async function contentAt(repo: string, path: string, ref: string): Promise<string | null> {
	try {
		return await gitOrThrow(['show', `${ref}${path}`], repo);
	} catch {
		return null;
	}
}

/**
 * 取冲突文件的新旧正文。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @param sources - 两侧取源。
 * @returns 旧侧与新侧正文；取不到的一侧为 null。
 */
export async function conflictTextsOf(repo: string, path: string, sources: ConflictSources): Promise<{ oldText: string | null; newText: string | null }> {
	const oldText = sources.old.ref === null ? null : await contentAt(repo, path, sources.old.ref);
	const newText = sources.next.ref === null
		? await worktreeText(repo, path)
		: await contentAt(repo, path, sources.next.ref);
	return { oldText, newText };
}

/**
 * 读工作区文件内容。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @returns 文件内容；不存在或读不了时为 null。
 */
async function worktreeText(repo: string, path: string): Promise<string | null> {
	try {
		return await fs.readFile(nodePath.join(repo, ...path.split('/')), 'utf8');
	} catch {
		return null;
	}
}

/**
 * 判断一个路径当前是否仍是未合并条目。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @returns 索引里仍有非 0 阶段时为 true。
 */
async function stillUnmerged(repo: string, path: string): Promise<boolean> {
	const stdout = await gitOrThrow(['ls-files', '-u', '-z', '--', path], repo);
	return parseIndexEntries(stdout).length > 0;
}

/**
 * 取某一侧的提交或 blob 内容落到工作区。
 *
 * `git checkout --ours/--theirs` 在该侧不存在时整条命令失败且报错随种类变化，因此这里
 * 直接用 `checkout-index` 指定阶段：成功与失败的判据都落在同一条命令上。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @param stage - 阶段号（2 为我方，3 为对方）。
 * @returns 失败原因；成功为 null。
 */
async function checkoutStage(repo: string, path: string, stage: 2 | 3): Promise<string | null> {
	try {
		await gitOrThrow(['checkout-index', '-f', '-u', `--stage=${String(stage)}`, '--', path], repo);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	/*
	 * `checkout-index` 只把该阶段的内容写进工作区，条目仍是未合并状态；要让冲突真正结束
	 * 还得把它写进索引，即再 `add` 一次。
	 */
	try {
		await gitOrThrow(['add', '-A', '--', path], repo);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * 删除工作区文件并把删除写进索引。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @returns 失败原因；成功为 null。
 */
async function removePath(repo: string, path: string): Promise<string | null> {
	try {
		await gitOrThrow(['rm', '-f', '--', path], repo);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * 把一个路径标记为已解决。
 *
 * 工作区有内容时落成该内容，文件已被删除时落成删除：两种结局都要解除未合并状态，
 * 因此先按 `add -A` 下发，失败再由 `rm -f` 兜住「双方都删」这类索引里没有工作区文件的情形。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @returns 失败原因；成功为 null。
 */
async function markResolved(repo: string, path: string): Promise<string | null> {
	try {
		await gitOrThrow(['add', '-A', '--', path], repo);
		return null;
	} catch (addError) {
		const removeError = await removePath(repo, path);
		if (removeError === null) return null;
		return addError instanceof Error ? addError.message : String(addError);
	}
}

/**
 * 重新生成工作区里的冲突标记。
 *
 * `checkout -m` 需要三个阶段齐备；缺少某一侧时 git 以 `does not have all necessary versions`
 * 拒绝，这条原因直接回给调用方。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @returns 失败原因；成功为 null。
 */
async function restoreMarkers(repo: string, path: string): Promise<string | null> {
	try {
		await gitOrThrow(['checkout', '-m', '--', path], repo);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * 逐个路径执行一个解决动作。
 *
 * 单条失败只记进 `errors`，其余路径照常处置：一批冲突里存在一个种类不适用的条目时，
 * 不该让整批作废。
 *
 * @param repo - 仓库路径。
 * @param paths - 文件路径，相对仓库根。
 * @param action - 解决动作。
 * @returns 已处置的路径与失败原因。
 */
export async function resolveConflicts(repo: string, paths: readonly string[], action: ConflictAction): Promise<ResolveOutcome> {
	const resolved: string[] = [];
	const errors: string[] = [];
	for (const path of paths) {
		if (!(await stillUnmerged(repo, path))) {
			errors.push(`${path}：未找到未合并条目，可能已在别处解决`);
			continue;
		}
		const stdout = await gitOrThrow(['status', '--porcelain', '-z', '--', path], repo);
		const code = stdout.slice(0, 2);
		const kind = conflictKindOfPair(code.slice(0, 1), code.slice(1, 2));
		if (kind === null) {
			errors.push(`${path}：条目已不再是冲突`);
			continue;
		}
		const stages = await conflictStagesOf(repo, path);
		const reason = await applyAction(repo, path, stages, action);
		if (reason === null) resolved.push(path);
		else errors.push(`${path}：${reason}`);
	}
	return { resolved, errors };
}

/**
 * 对单个冲突路径执行动作。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径。
 * @param stages - 该路径的阶段。
 * @param action - 解决动作。
 * @returns 失败原因；成功为 null。
 */
async function applyAction(repo: string, path: string, stages: ConflictStages, action: ConflictAction): Promise<string | null> {
	switch (action) {
		case 'ours':
			if (stages.ours) return await checkoutStage(repo, path, 2);
			// 我方删除：留下对方内容并标记已解决，等价于「保留对方」。
			if (stages.theirs) return await markResolved(repo, path);
			return '该文件没有我方版本';
		case 'theirs':
			if (stages.theirs) return await checkoutStage(repo, path, 3);
			if (stages.ours) return await markResolved(repo, path);
			return '该文件没有对方版本';
		case 'delete':
			return await removePath(repo, path);
		case 'markResolved':
			return await markResolved(repo, path);
		case 'restoreMarkers':
			if (!(stages.base && stages.ours && stages.theirs)) return '该冲突类型没有可重新生成的冲突标记';
			return await restoreMarkers(repo, path);
		default:
			return '未知的冲突解决方式';
	}
}
