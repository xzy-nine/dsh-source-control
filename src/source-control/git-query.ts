/**
 * 宿主侧 git 查询层：读取仓库信息、提交图、提交详情、标签详情与工作区状态。
 *
 * 只读仓库，不修改引用与文件；git 的失败一律写进返回值的 `error` 字段，不向调用方抛错。
 * 命令输出交给 `git-parse.ts` 的纯解析函数，执行与错误处理复用 `working-tree.ts`。
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { forEachStatusRecord, gitOrThrow, parseStatusSnapshot, runGit } from './working-tree.js';
import type { WorkingTreeSnapshot } from './working-tree.js';
import { readHeadRef } from './worktree-branches.js';
import { repoHead, repoLayout } from './repo-facts.js';
import type { HeadRef } from './worktree-branches.js';
import {
	assembleCommits, generateFileChanges, parseCommitDetails, parseConfigList, parseLog, parseNameStatus,
	parseNumStat, parseRefsAndBranches, parseStashReflog, refsFromDecorations,
	DETAILS_FORMAT, LOG_FORMAT, REF_BRANCH_FORMAT, STASH_FORMAT, UNCOMMITTED,
} from './git-parse.js';
import type { DiffNameStatusRecord, DiffNumStatRecord, LogRecord, RefData, RefsAndBranches, StatusFiles } from './git-parse.js';
import type {
	BranchBase, CommitComparisonData, CommitData, CommitDetails, CommitDetailsData, CommitOrdering, CommitStash, ErrorInfo,
	RefSummary, RepoConfig, RepoConfigBranch, RepoConfigData, RepoInfo, SettingsRemote, StashEntry,
} from './git-types.js';

/** 提交详情中除改动列表以外的字段。 */
type CommitDetailsBase = Omit<CommitDetails, 'fileChanges'>;

/** 差异记录的类型过滤集。 */
const DIFF_FILTER = 'AMDR';

/**
 * 读取仓库的分支、远程与贮藏概览。
 *
 * @param repo - 仓库路径。
 * @param showRemoteBranches - 是否列出远程分支。
 * @param showStashes - 是否列出贮藏。
 * @param hideRemotes - 要隐藏的远程名。
 * @returns 仓库信息；任一读取失败时各列表为空且 `error` 为错误文本。
 */
export async function getRepoInfo(
	repo: string, showRemoteBranches: boolean, showStashes: boolean, hideRemotes: readonly string[],
): Promise<RepoInfo> {
	try {
		/* 三路互不依赖，同批取：串行要等三个子进程依次结束，并行只等最慢的一个。 */
		const [branchData, configs, stashes] = await Promise.all([
			getRefsAndBranches(repo, showRemoteBranches, hideRemotes),
			readConfig(repo),
			showStashes ? getStashes(repo) : Promise.resolve<StashEntry[]>([]),
		]);
		/* 远程名多数可从配置派生；配置里没有任何远程时才回退读取。 */
		const configured = remoteNamesFromConfig(configs);
		const remoteNames = configured ?? await getRemoteNames(repo);
		return {
			branches: branchData.branches,
			head: branchData.branch,
			remotes: remoteNames.map((name): SettingsRemote => ({
				name,
				url: configs[`remote.${name}.url`] ?? null,
				pushUrl: configs[`remote.${name}.pushurl`] ?? null,
			})),
			stashes,
			error: null,
		};
	} catch (error) {
		return { branches: [], head: null, remotes: [], stashes: [], error: errorText(error) };
	}
}

/**
 * 从配置键值对派生远程名。
 *
 * 键形如 `remote.<name>.<子键>`，子键可以是 `url`、`pushurl`、`fetch` 等任意一种；名称取最后一个
 * 点之前的部分，因此名称本身含点时同样解析正确。只要某个远程在配置里出现过任意一个子键就计入，
 * 不因别的远程有 `url` 而漏掉只有 `fetch` 的远程。
 *
 * @param configs - `git config --list` 的键值对。
 * @returns 升序去重的远程名；配置里没有任何 `remote.<name>.<子键>` 时为 null。
 */
function remoteNamesFromConfig(configs: Record<string, string>): string[] | null {
	const names = new Set<string>();
	for (const key of Object.keys(configs)) {
		const match = /^remote\.(.+)\./.exec(key);
		if (match === null) continue;
		const name = match[1];
		if (name !== '') names.add(name);
	}
	return names.size === 0 ? null : [...names].sort();
}

/**
 * 读取提交图。
 *
 * 提交取 `maxCommits + 1` 条以判定是否还有更多；未提交变更以哈希为 `*` 的伪提交排在最前；
 * 贮藏插入到其基提交之前。
 *
 * @param repo - 仓库路径。
 * @param branches - 要显示的提交起点；null 表示全部（`--branches` 等）。
 * @param maxCommits - 返回的提交数上限。
 * @param showTags - 是否标注标签。
 * @param showRemoteBranches - 是否包含并标注远程分支。
 * @param includeCommitsMentionedByReflogs - 是否包含仅被 reflog 提及的提交。
 * @param onlyFollowFirstParent - 是否只沿第一父提交回溯。
 * @param commitOrdering - 提交排序方式。
 * @param remotes - 已知远程名，用于标注远程分支所属远程；可直接给出，也可给一个待定的取值。
 * @param hideRemotes - 要隐藏的远程名。
 * @param stashes - 仓库中的贮藏。
 * @param skip - 从起点跳过的提交数；双向分页都按绝对偏移取用。
 * @param head - 当前 HEAD 指向的提交哈希；`HEAD` 文件由调用方读取，本函数不重复读。
 * @returns 提交图；读取失败时为空图且 `error` 为错误文本。
 */
export async function getCommits(
	repo: string,
	branches: readonly string[] | null,
	maxCommits: number,
	showTags: boolean,
	showRemoteBranches: boolean,
	includeCommitsMentionedByReflogs: boolean,
	onlyFollowFirstParent: boolean,
	commitOrdering: CommitOrdering,
	remotes: readonly string[] | Promise<readonly string[]>,
	hideRemotes: readonly string[],
	stashes: readonly StashEntry[],
	skip = 0,
	head: string | null = null,
): Promise<CommitData> {
	try {
		/*
		 * 引用标记来自 `git log` 的装饰（`--decorate=full` 的 `%D`），不再单独枚举引用：
		 * 同一次日志已经带出窗口内提交上的全部分支、标签与远程分支。
		 *
		 * 远程名可能与仓库信息同批取，标注要用它，因此这里才等它落地；日志与它并行。
		 */
		const logSource = getLog(repo, branches, maxCommits + 1, showTags, showRemoteBranches, includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering, remotes, hideRemotes, stashes, skip);
		const [records, remoteNames] = await Promise.all([logSource, remotes]);
		const refs: RefData = { ...refsFromDecorations(records, hideRemotes, showRemoteBranches), head };
		return { ...assembleCommits(records, refs, stashes, remoteNames, showTags, maxCommits, skip), error: null };
	} catch (error) {
		return { commits: [], head: null, tags: [], moreCommitsAvailable: false, nextSkip: skip, error: errorText(error) };
	}
}

/**
 * 读取设置面板使用的仓库配置。
 *
 * @param repo - 仓库路径。
 * @param remotes - 已知远程名。
 * @returns 仓库配置；读取失败时 `config` 为 null 且 `error` 为错误文本。
 */
export async function getConfig(repo: string, remotes: readonly string[]): Promise<RepoConfigData> {
	try {
		const [consolidated, local, global] = await Promise.all([
			readConfig(repo),
			readConfig(repo, 'local'),
			readConfig(repo, 'global'),
		]);

		const branches: Record<string, RepoConfigBranch> = {};
		for (const key of Object.keys(local)) {
			if (!key.startsWith('branch.')) continue;
			if (key.endsWith('.remote')) {
				const branchName = key.slice('branch.'.length, -'.remote'.length);
				branches[branchName] = { pushRemote: branches[branchName]?.pushRemote ?? null, remote: local[key] };
			} else if (key.endsWith('.pushremote')) {
				const branchName = key.slice('branch.'.length, -'.pushremote'.length);
				branches[branchName] = { pushRemote: local[key], remote: branches[branchName]?.remote ?? null };
			}
		}

		const config: RepoConfig = {
			branches,
			diffTool: consolidated['diff.tool'] ?? null,
			guiDiffTool: consolidated['diff.guitool'] ?? null,
			pushDefault: consolidated['remote.pushdefault'] ?? null,
			remotes: remotes.map((name): SettingsRemote => ({
				name,
				url: local[`remote.${name}.url`] ?? null,
				pushUrl: local[`remote.${name}.pushurl`] ?? null,
			})),
			user: {
				name: { local: local['user.name'] ?? null, global: global['user.name'] ?? null },
				email: { local: local['user.email'] ?? null, global: global['user.email'] ?? null },
			},
		};
		return { config, error: null };
	} catch (error) {
		return { config: null, error: errorText(error) };
	}
}

/**
 * 读取一次提交的详情。
 *
 * 差异以第一个父提交为基准，因此合并提交也按单侧差异列出改动文件；根提交没有父提交，
 * 差异基准取提交自身。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 提交哈希。
 * @param hasParents - 该提交是否有父提交。
 * @returns 提交详情；读取失败时 `commitDetails` 为 null 且 `error` 为错误文本。
 */
export async function getCommitDetails(repo: string, commitHash: string, hasParents: boolean): Promise<CommitDetailsData> {
	try {
		const fromCommit = hasParents ? `${commitHash}^` : commitHash;
		const [base, nameStatus, numStat] = await Promise.all([
			getCommitDetailsBase(repo, commitHash),
			getDiffNameStatus(repo, fromCommit, commitHash),
			getDiffNumStat(repo, fromCommit, commitHash),
		]);
		if (base === null) throw new Error('无法解析提交详情');
		return { commitDetails: { ...base, fileChanges: generateFileChanges(nameStatus, numStat, null) }, error: null };
	} catch (error) {
		return { commitDetails: null, error: errorText(error) };
	}
}

/**
 * 读取一次贮藏的详情。
 *
 * 差异以贮藏的基提交为基准；贮藏的未跟踪文件提交以 `diff-tree --root` 单独取新增文件，
 * 并标记为 `U`。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 贮藏提交哈希。
 * @param stash - 贮藏的标记信息。
 * @returns 提交详情；读取失败时 `commitDetails` 为 null 且 `error` 为错误文本。
 */
export async function getStashDetails(repo: string, commitHash: string, stash: CommitStash): Promise<CommitDetailsData> {
	try {
		const untracked = stash.untrackedFilesHash;
		const [base, nameStatus, numStat, untrackedNameStatus, untrackedNumStat] = await Promise.all([
			getCommitDetailsBase(repo, commitHash),
			getDiffNameStatus(repo, stash.baseHash, commitHash),
			getDiffNumStat(repo, stash.baseHash, commitHash),
			untracked === null ? Promise.resolve<DiffNameStatusRecord[]>([]) : getDiffNameStatus(repo, untracked, untracked),
			untracked === null ? Promise.resolve<DiffNumStatRecord[]>([]) : getDiffNumStat(repo, untracked, untracked),
		]);
		if (base === null) throw new Error('无法解析提交详情');

		const fileChanges = generateFileChanges(nameStatus, numStat, null);
		if (untracked !== null) {
			for (const change of generateFileChanges(untrackedNameStatus, untrackedNumStat, null)) {
				if (change.type === 'A') fileChanges.push({ ...change, type: 'U' });
			}
		}
		return { commitDetails: { ...base, fileChanges }, error: null };
	} catch (error) {
		return { commitDetails: null, error: errorText(error) };
	}
}

/**
 * 读取工作区未提交变更的详情。
 *
 * 差异以 HEAD 为基准、终到工作区，并叠加未跟踪与已删除的路径；提交字段取伪提交的占位值。
 *
 * @param repo - 仓库路径。
 * @returns 提交详情；读取失败时 `commitDetails` 为 null 且 `error` 为错误文本。
 */
export async function getUncommittedDetails(repo: string): Promise<CommitDetailsData> {
	try {
		const [nameStatus, numStat, status] = await Promise.all([
			getDiffNameStatus(repo, 'HEAD', ''),
			getDiffNumStat(repo, 'HEAD', ''),
			getStatus(repo),
		]);
		return {
			commitDetails: {
				hash: UNCOMMITTED, parents: [],
				author: '', authorEmail: '', authorDate: 0,
				committer: '', committerEmail: '', committerDate: 0, signature: null,
				body: '', fileChanges: generateFileChanges(nameStatus, numStat, status),
			},
			error: null,
		};
	} catch (error) {
		return { commitDetails: null, error: errorText(error) };
	}
}

/**
 * 读取两个修订之间的改动。
 *
 * @param repo - 仓库路径。
 * @param fromHash - 基准修订。
 * @param toHash - 目标修订；`*` 表示工作区。
 * @returns 改动列表；读取失败时为空列表且 `error` 为错误文本。
 */
export async function getCommitComparison(repo: string, fromHash: string, toHash: string): Promise<CommitComparisonData> {
	try {
		const target = toHash === UNCOMMITTED ? '' : toHash;
		const [nameStatus, numStat, status] = await Promise.all([
			getDiffNameStatus(repo, fromHash, target),
			getDiffNumStat(repo, fromHash, target),
			toHash === UNCOMMITTED ? getStatus(repo) : Promise.resolve(null),
		]);
		return { fileChanges: generateFileChanges(nameStatus, numStat, status), error: null };
	} catch (error) {
		return { fileChanges: [], error: errorText(error) };
	}
}


/**
 * 读取仓库中的贮藏。
 *
 * 先按文件系统判定 `logs/refs/stash` 是否存在：不存在时仓库必然没有贮藏，直接返回空列表，
 * 不起子进程。存在时才按 reflog 枚举。
 *
 * @param repo - 仓库路径。
 * @returns 贮藏列表；`refs/stash` 不存在时为空列表。
 */
export async function getStashes(repo: string): Promise<StashEntry[]> {
	const layout = await repoLayout(repo);
	if (layout === null || !(await stashLogExists(layout.commonDir))) return [];
	const result = await runGit(['reflog', '-z', `--format=${STASH_FORMAT}`, 'refs/stash', '--'], repo);
	/* 仓库没有贮藏时 git 以非零退出。 */
	if (result.code !== 0) return [];
	return parseStashReflog(result.stdout);
}

/**
 * 判定 git 公共目录下是否存在贮藏的 reflog 文件。
 *
 * @param commonDir - git 公共目录的绝对路径。
 * @returns `logs/refs/stash` 是否为常规文件。
 */
async function stashLogExists(commonDir: string): Promise<boolean> {
	try {
		return (await stat(join(commonDir, 'logs', 'refs', 'stash'))).isFile();
	} catch {
		return false;
	}
}

/**
 * 读取工作区中已删除与未跟踪的路径。
 *
 * @param repo - 仓库路径。
 * @returns 已删除与未跟踪的路径列表。
 */
export async function getStatus(repo: string): Promise<StatusFiles> {
	const stdout = await gitOrThrow(['status', '-s', '--untracked-files=all', '--porcelain', '-z'], repo);
	const deleted: string[] = [];
	const untracked: string[] = [];
	// 这里两列都要看 R/C：与 `parseStatus` 的判据不同，故显式打开工作区列。
	forEachStatusRecord(stdout, Number.POSITIVE_INFINITY, (record) => {
		if (record.index === 'D' || record.worktree === 'D') deleted.push(record.path);
		else if (record.index === '?' || record.worktree === '?') untracked.push(record.path);
	}, true);
	return { deleted, untracked };
}

/** 工作区快照的读取结果：条目、分支与上游关系，或错误文本。 */
export interface WorkingTreeSnapshotData extends WorkingTreeSnapshot {
	readonly error: ErrorInfo;
}

/**
 * 判定是否处于未完成的合并。
 *
 * `MERGE_HEAD` 只在合并进行中且尚未提交时存在，因此它同时覆盖「有冲突待解决」与
 * 「无冲突但用了 `--no-commit`」两种情形；`git status` 的 unmerged 记录只覆盖前者。
 *
 * 判定读 git 目录下的 `MERGE_HEAD` 文件，不起子进程：该文件的位置由仓库事实层
 * （`repo-facts.ts`）给出，链接工作树与子模块各自的 git 目录因此同样正确。
 *
 * @param repo - 仓库路径。
 * @returns 合并进行中时为 true。
 */
async function mergeInProgress(repo: string): Promise<boolean> {
	const layout = await repoLayout(repo);
	if (layout === null) return false;
	try {
		return (await stat(join(layout.gitDir, 'MERGE_HEAD'))).isFile();
	} catch {
		return false;
	}
}

/**
 * 读取工作区快照：变更条目与当前分支的上游关系。
 *
 * 两条信息来自同一次 `git status --porcelain=v2 --branch -z -uall`：面板进入仓库与写操作后的
 * 对账都同时需要它们，分两次读会各起一个子进程，且两次输出之间工作区可能已经变化。
 *
 * 合并状态另起一次 `rev-parse --verify MERGE_HEAD`：它不在 status 输出里，且无法由 unmerged
 * 记录完整判定（`--no-commit` 的无冲突合并没有 unmerged 记录）。
 *
 * @param repo - 仓库路径。
 * @returns 快照；读取失败时条目为空、分支为 null 且 `error` 为错误文本。
 */
export async function getWorkingTreeSnapshot(repo: string): Promise<WorkingTreeSnapshotData> {
	try {
		const [stdout, merging] = await Promise.all([
			gitOrThrow(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], repo),
			mergeInProgress(repo),
		]);
		const snapshot = parseStatusSnapshot(stdout);
		return {
			entries: snapshot.entries.sort((left, right) => left.path.localeCompare(right.path)),
			head: snapshot.head,
			branch: snapshot.branch,
			upstream: snapshot.upstream,
			ahead: snapshot.ahead,
			behind: snapshot.behind,
			merging,
			error: null,
		};
	} catch (error) {
		return {
			entries: [], head: null, branch: null, upstream: null, ahead: 0, behind: 0, merging: false,
			error: errorText(error),
		};
	}
}

/**
 * 读取包含指定路径的仓库根目录。
 *
 * 路径不存在或不在仓库内时返回 null；子进程本身无法启动（如路径不存在）同样返回 null。
 *
 * @param pathOfPotentialRepo - 可能是仓库或仓库内子目录的路径。
 * @returns 仓库根目录的绝对路径；该路径不在仓库内时为 null。
 */
export async function repoRoot(pathOfPotentialRepo: string): Promise<string | null> {
	try {
		const result = await runGit(['rev-parse', '--show-toplevel'], pathOfPotentialRepo);
		if (result.code !== 0) return null;
		const root = result.stdout.trim();
		return root === '' ? null : root;
	} catch {
		return null;
	}
}

/**
 * 把捕获到的错误转成错误文本。
 *
 * @param error - 捕获到的值。
 * @returns 错误文本。
 */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 读取仓库配置的键值对。
 *
 * @param repo - 仓库路径。
 * @param location - 配置位置；省略时读取合并后的配置。
 * @returns 键值对；配置文件不存在时为空对象。
 */
async function readConfig(repo: string, location?: 'local' | 'global'): Promise<Record<string, string>> {
	const args = ['config', '--list', '-z', '--includes'];
	if (location !== undefined) args.push(`--${location}`);
	const result = await runGit(args, repo);
	if (result.code !== 0) {
		/* 配置文件缺失时 git 报 `unable to read config file`。 */
		if (result.stderr.includes('unable to read config file')) return {};
		throw new Error(result.stderr.trim() || result.stdout.trim() || 'git config 执行失败');
	}
	return parseConfigList(result.stdout);
}

/**
 * 构造引用枚举的公共参数。
 *
 * 引用集合与分支列表读的是同一批引用，起点固定为 `refs/heads` 与 `refs/tags`，远程分支按开关追加。
 *
 * @param format - `--format` 的格式串。
 * @param showRemoteBranches - 是否包含远程分支。
 * @returns git 参数数组。
 */
function forEachRefArgs(format: string, showRemoteBranches: boolean): string[] {
	const args = ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/tags'];
	if (showRemoteBranches) args.push('refs/remotes');
	return args;
}

/**
 * 一次枚举取回引用原始输出与 `HEAD` 文件内容。
 *
 * 两者互不依赖，同批发出；`head` 由 `HEAD` 文件解析得到，不起 `git rev-parse`。
 *
 * @param args - git 参数数组。
 * @param repo - 仓库路径。
 * @returns 引用枚举的标准输出与 `HEAD` 的解析结果。
 */
async function readRefsRaw(args: readonly string[], repo: string): Promise<{ stdout: string; headRef: HeadRef | null }> {
	const [stdout, headRef] = await Promise.all([
		gitOrThrow(args, repo),
		readHeadRef(repo),
	]);
	return { stdout, headRef };
}

/**
 * 一次枚举读取引用集合与分支列表。
 *
 * 提交图与仓库信息读的是同一批引用，只是取值不同；一次 `for-each-ref` 同时得到两者，首屏因此
 * 少起一个子进程。`head` 不在本次输出里，由 `HEAD` 文件补入，不起 `git rev-parse`。
 *
 * @param repo - 仓库路径。
 * @param showRemoteBranches - 是否包含远程分支。
 * @param hideRemotes - 要隐藏的远程名。
 * @returns 引用集合（`head` 已补入）、分支名列表与当前分支名。
 */
export async function getRefsAndBranches(repo: string, showRemoteBranches: boolean, hideRemotes: readonly string[]): Promise<RefsAndBranches> {
	const { stdout, headRef } = await readRefsRaw(forEachRefArgs(REF_BRANCH_FORMAT, showRemoteBranches), repo);
	const parsed = parseRefsAndBranches(stdout, hideRemotes);
	return { ...parsed, refs: { ...parsed.refs, head: resolveHeadHash(parsed.refs, headRef) } };
}

/**
 * 读取远程名列表。
 *
 * @param repo - 仓库路径。
 * @returns 远程名列表。
 */
export async function getRemoteNames(repo: string): Promise<string[]> {
	const stdout = await gitOrThrow(['remote'], repo);
	return stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * 读取原始提交记录。
 *
 * @param repo - 仓库路径。
 * @param branches - 提交起点；null 表示全部。
 * @param num - 取回的提交数。
 * @param includeTags - 是否包含仅被标签引用的提交。
 * @param includeRemotes - 是否包含远程分支。
 * @param includeCommitsMentionedByReflogs - 是否包含仅被 reflog 提及的提交。
 * @param onlyFollowFirstParent - 是否只沿第一父提交回溯。
 * @param order - 提交排序方式。
 * @param remotes - 已知远程名；可直接给出，也可给一个待定的取值（仅在需要隐藏远程时使用）。
 * @param hideRemotes - 要隐藏的远程名。
 * @param stashes - 仓库中的贮藏。
 * @returns 提交记录。
 */
async function getLog(
	repo: string,
	branches: readonly string[] | null,
	num: number,
	includeTags: boolean,
	includeRemotes: boolean,
	includeCommitsMentionedByReflogs: boolean,
	onlyFollowFirstParent: boolean,
	order: CommitOrdering,
	remotes: readonly string[] | Promise<readonly string[]>,
	hideRemotes: readonly string[],
	stashes: readonly StashEntry[],
	skip = 0,
): Promise<LogRecord[]> {
	// `--decorate=full` 让 `%D` 给出完整引用名；提交图的引用标记据此装配，不再单独枚举引用。
	const args = ['-c', 'log.showSignature=false', 'log', '-z', '--decorate=full', `--max-count=${num}`, `--format=${LOG_FORMAT}`, `--${order}-order`];
	if (onlyFollowFirstParent) args.push('--first-parent');
	// 偏移分页：跳过前 skip 条再输出本页；正反向都用它，因此上下滚动都能取。
	if (skip > 0) args.push(`--skip=${skip}`);

	if (branches !== null) {
		args.push(...branches);
	} else {
		args.push('--branches');
		if (includeTags) args.push('--tags');
		if (includeCommitsMentionedByReflogs) args.push('--reflog');
		if (includeRemotes) {
			if (hideRemotes.length === 0) {
				// 不隐藏任何远程时不需要远程名，日志因此不必等仓库信息。
				args.push('--remotes');
			} else {
				const names = await remotes;
				names.filter((remote) => !hideRemotes.includes(remote)).forEach((remote) => args.push(`--glob=refs/remotes/${remote}`));
			}
		}
		/* 仅被贮藏引用的提交也要出现在图中，因此把贮藏基提交作为起点。 */
		const baseHashes = [...new Set(stashes.map((stash) => stash.baseHash))];
		args.push(...baseHashes);
		args.push('HEAD');
	}
	args.push('--');

	return parseLog(await gitOrThrow(args, repo));
}

/**
 * 由引用集合与 `HEAD` 文件内容得出 HEAD 指向的提交哈希。
 *
 * `HEAD` 指向分支时该分支必然出现在本次引用集合里；取不到时返回 null，与读不到 HEAD 同一处理。
 *
 * @param refs - 本次读到的引用集合。
 * @param headRef - `HEAD` 文件的解析结果；读不到时为 null。
 * @returns 提交哈希；无法确定时为 null。
 */
function resolveHeadHash(refs: RefData, headRef: HeadRef | null): string | null {
	if (headRef === null) return null;
	if (headRef.hash !== null) return headRef.hash;
	if (headRef.branch === null) return null;
	return refs.heads.find((head) => head.name === headRef.branch)?.hash ?? null;
}

/**
 * 读取提交详情的基础字段。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 提交哈希。
 * @returns 基础字段；输出无法解析时为 null。
 */
async function getCommitDetailsBase(repo: string, commitHash: string): Promise<CommitDetailsBase | null> {
	const stdout = await gitOrThrow(['show', '-z', '--quiet', `--format=${DETAILS_FORMAT}`, commitHash], repo);
	/* `-z` 在记录末尾补一个 NUL，解析前去掉。 */
	const parsed = parseCommitDetails(stdout.endsWith('\0') ? stdout.slice(0, -1) : stdout);
	return parsed === null ? null : { ...parsed };
}

/**
 * 读取差异的 `--name-status` 记录。
 *
 * @param repo - 仓库路径。
 * @param fromHash - 基准修订。
 * @param toHash - 目标修订；空串表示工作区。
 * @returns 改动记录。
 */
async function getDiffNameStatus(repo: string, fromHash: string, toHash: string): Promise<DiffNameStatusRecord[]> {
	return parseNameStatus(await execDiff(repo, fromHash, toHash, '--name-status'));
}

/**
 * 读取差异的 `--numstat` 记录。
 *
 * @param repo - 仓库路径。
 * @param fromHash - 基准修订。
 * @param toHash - 目标修订；空串表示工作区。
 * @returns 增删统计记录。
 */
async function getDiffNumStat(repo: string, fromHash: string, toHash: string): Promise<DiffNumStatRecord[]> {
	return parseNumStat(await execDiff(repo, fromHash, toHash, '--numstat'));
}

/**
 * 执行一次差异命令。
 *
 * 两端相同时用 `diff-tree --root` 取该提交自身的改动，否则用 `diff`；输出交给
 * `parseNameStatus` 或 `parseNumStat` 解析。
 *
 * @param repo - 仓库路径。
 * @param fromHash - 基准修订。
 * @param toHash - 目标修订；空串表示工作区。
 * @param arg - `--name-status` 或 `--numstat`。
 * @returns 去掉记录分隔首字段后的输出。
 */
async function execDiff(repo: string, fromHash: string, toHash: string, arg: '--name-status' | '--numstat'): Promise<string> {
	let args: string[];
	if (fromHash === toHash) {
		args = ['diff-tree', arg, '-r', '--root', '--find-renames', `--diff-filter=${DIFF_FILTER}`, '-z', fromHash];
	} else {
		args = ['diff', arg, '--find-renames', `--diff-filter=${DIFF_FILTER}`, '-z', fromHash];
		if (toHash !== '') args.push(toHash);
	}

	const stdout = await gitOrThrow(args, repo);
	if (fromHash !== toHash) return stdout;
	/* diff-tree 的输出以提交哈希作为首个字段。 */
	const separator = stdout.indexOf('\0');
	return separator === -1 ? '' : stdout.slice(separator + 1);
}

/** 分叉来源解析用的引用格式：全名、短名、上游短名、上游跟踪状态。 */
const BASE_REF_FORMAT = ['%(refname)', '%(refname:short)', '%(upstream:short)', '%(upstream:track,nobracket)'].join('%00');

/**
 * 读取仓库的全部引用，供引用筛选列表与手选校验使用。
 *
 * 与提交图取数分离：只有打开筛选弹窗或需要校验手选引用时才读，刷新路径不起这次 `for-each-ref`。
 *
 * @param repo - 仓库路径。
 * @param showRemoteBranches - 是否包含远程分支。
 * @returns 分支、远程分支与标签；读取失败时抛错，由路由回投错误文本。
 */
export async function getRefSummaries(repo: string, showRemoteBranches: boolean): Promise<RefSummary[]> {
	const parsed = await getRefsAndBranches(repo, showRemoteBranches, []);
	const refs: RefSummary[] = [];
	for (const head of parsed.refs.heads) refs.push({ id: `refs/heads/${head.name}`, name: head.name, hash: head.hash, type: 'branch' });
	for (const tag of parsed.refs.tags) refs.push({ id: `refs/tags/${tag.name}`, name: tag.name, hash: tag.hash, type: 'tag' });
	for (const remote of parsed.refs.remotes) refs.push({ id: `refs/remotes/${remote.name}`, name: remote.name, hash: remote.hash, type: 'remote' });
	return refs;
}

/**
 * 转义正则元字符，供 `--grep-reflog` 拼接分支名。
 *
 * @param value - 原文。
 * @returns 转义后的文本。
 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 读某个 reflog 里匹配条件条目的主题。
 *
 * @param repo - 仓库路径。
 * @param ref - reflog 的引用名，如 `refs/heads/main` 或 `HEAD`。
 * @param pattern - `--grep-reflog` 的正则。
 * @returns 匹配条目的主题，按 reflog 顺序；读取失败时为空数组。
 */
async function reflogSubjects(repo: string, ref: string, pattern: string): Promise<string[]> {
	const result = await runGit(['reflog', ref, '--format=%gs', `--grep-reflog=${pattern}`], repo);
	if (result.code !== 0) return [];
	return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * 从 reflog 推断分支的创建来源。
 *
 * 分支 reflog 记录 `branch: Created from <来源>`；来源为 `HEAD` 时再查 `HEAD` 的 reflog，
 * 取检出到该分支前所在的分支。与 VS Code 的 `getBranchBaseFromReflog` 同一判据。
 *
 * @param repo - 仓库路径。
 * @param branch - 当前分支短名。
 * @returns 来源引用短名；无法确定时为 null。
 */
async function reflogCreatedFrom(repo: string, branch: string): Promise<string | null> {
	const created = await reflogSubjects(repo, `refs/heads/${branch}`, 'branch: Created from *.')
		.then((subjects) => subjects, () => []);
	if (created.length !== 1) return null;
	const from = /^branch: Created from (.*)$/.exec(created[0])?.[1]?.trim() ?? '';
	if (from === '') return null;
	if (from !== 'HEAD') return from;
	const moved = await reflogSubjects(repo, 'HEAD', `checkout: moving from .* to ${escapeRegExp(branch)}`);
	const last = moved.at(-1);
	if (last === undefined) return null;
	return /^checkout: moving from (\S+) /.exec(last)?.[1] ?? null;
}

/**
 * 把一个候选引用名解析成可用于 `git log` 起点的短名。
 *
 * 候选既可以是 `refs/heads/x`、`refs/remotes/origin/x` 这样的全名，也可以是 `main`、
 * `origin/main` 这样的短名。远程分支优先；本地分支取它的上游（上游已消失时退回本地分支名）。
 *
 * @param repo - 仓库路径。
 * @param candidate - 候选引用名。
 * @returns 引用短名；候选解析不到时为 null。
 */
async function resolveRefName(repo: string, candidate: string): Promise<string | null> {
	const name = candidate.trim();
	if (name === '') return null;
	const patterns = name.startsWith('refs/') ? [name] : [`refs/heads/${name}`, `refs/remotes/${name}`];
	const result = await runGit(['for-each-ref', `--format=${BASE_REF_FORMAT}`, ...patterns], repo);
	if (result.code !== 0) return null;
	let local: string | null = null;
	let upstream = '';
	let track = '';
	let remote: string | null = null;
	for (const line of result.stdout.split('\n')) {
		if (line === '') continue;
		const [refname, short, upstreamName, upstreamTrack] = line.split('\0');
		if (refname.startsWith('refs/heads/')) {
			local = short;
			upstream = upstreamName;
			track = upstreamTrack;
		} else if (refname.startsWith('refs/remotes/') && !short.endsWith('/HEAD')) {
			remote = short;
		}
	}
	if (remote !== null) return remote;
	if (local === null) return null;
	if (upstream !== '' && track !== 'gone') return upstream;
	return local;
}

/**
 * 读默认远程的默认分支。
 *
 * 取第一个远程，按 `refs/remotes/<远程>/HEAD` 解析；该符号引用多数仓库未建立，读不到即可。
 *
 * @param repo - 仓库路径。
 * @returns 引用短名；无法确定时为 null。
 */
async function defaultRemoteBranch(repo: string): Promise<string | null> {
	let remotes: string[];
	try {
		remotes = await getRemoteNames(repo);
	} catch {
		return null;
	}
	if (remotes.length === 0) return null;
	const result = await runGit(['symbolic-ref', '--short', `refs/remotes/${remotes[0]}/HEAD`], repo);
	if (result.code !== 0) return null;
	const name = result.stdout.trim();
	return name === '' ? null : await resolveRefName(repo, name);
}

/**
 * 读取当前分支的分叉来源分支（VS Code 图形视图的 base 引用）。
 *
 * 取值顺序：`branch.<name>.vscode-merge-base` 配置、分支 reflog 的创建来源、默认远程的默认分支。
 * 只读，不把推断结果写回仓库配置。
 *
 * @param repo - 仓库路径。
 * @returns 当前分支与分叉来源的引用短名；分离头指针时两者皆为 null。
 */
export async function getBranchBase(repo: string): Promise<BranchBase> {
	const head = await repoHead(repo);
	const branch = head?.branch ?? null;
	if (branch === null) return { branch: null, base: null };

	const configured = await runGit(['config', '--get', `branch.${branch}.vscode-merge-base`], repo);
	const configuredName = configured.code === 0 ? configured.stdout.trim() : '';
	if (configuredName !== '') {
		const resolved = await resolveRefName(repo, configuredName);
		if (resolved !== null) return { branch, base: resolved };
	}

	const fromReflog = await reflogCreatedFrom(repo, branch);
	if (fromReflog !== null) {
		const resolved = await resolveRefName(repo, fromReflog);
		if (resolved !== null) return { branch, base: resolved };
	}

	return { branch, base: await defaultRemoteBranch(repo) };
}
