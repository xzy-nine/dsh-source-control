/**
 * 宿主侧 git 查询层：读取仓库信息、提交图、提交详情、标签详情与工作区状态。
 *
 * 只读仓库，不修改引用与文件；git 的失败一律写进返回值的 `error` 字段，不向调用方抛错。
 * 命令输出交给 `git-parse.ts` 的纯解析函数，执行与错误处理复用 `working-tree.ts`。
 */
import { gitOrThrow, parseStatus, runGit } from './working-tree.js';
import {
	assembleCommits, generateFileChanges, parseCommitDetails, parseConfigList, parseLog, parseNameStatus,
	parseNumStat, parseRefs, parseStashReflog, parseTagInfo, parseTagSignature,
	DETAILS_FORMAT, LOG_FORMAT, REF_FORMAT, STASH_FORMAT, TAG_FORMAT, UNCOMMITTED,
} from './git-parse.js';
import type { DiffNameStatusRecord, DiffNumStatRecord, LogRecord, RefData, StatusFiles } from './git-parse.js';
import type {
	CommitComparisonData, CommitData, CommitDetails, CommitDetailsData, CommitOrdering, CommitStash,
	RepoConfig, RepoConfigBranch, RepoConfigData, RepoInfo, SettingsRemote, Signature, StashEntry, TagDetails,
	TagDetailsData, TagDetailsView,
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
export async function getRepoInfo(repo: string, showRemoteBranches: boolean, showStashes: boolean, hideRemotes: readonly string[]): Promise<RepoInfo> {
	try {
		const [branchData, remoteNames, stashes] = await Promise.all([
			getBranches(repo, showRemoteBranches, hideRemotes),
			getRemoteNames(repo),
			showStashes ? getStashes(repo) : Promise.resolve([]),
		]);
		const configs = await readConfig(repo);
		return {
			branches: branchData.branches,
			head: branchData.head,
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
 * @param remotes - 已知远程名，用于标注远程分支所属远程。
 * @param hideRemotes - 要隐藏的远程名。
 * @param stashes - 仓库中的贮藏。
 * @param skip - 从起点跳过的提交数；双向分页都按绝对偏移取用。
 * @param skip - 从起点跳过的提交数；反向翻页按绝对偏移取用。
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
	remotes: readonly string[],
	hideRemotes: readonly string[],
	stashes: readonly StashEntry[],
	skip = 0,
): Promise<CommitData> {
	try {
		const [records, refsOrError] = await Promise.all([
			getLog(repo, branches, maxCommits + 1, showTags, showRemoteBranches, includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering, remotes, hideRemotes, stashes, skip),
			getRefs(repo, showRemoteBranches, false, hideRemotes).then((refs) => refs, (error: unknown) => errorText(error)),
		]);

		let refs: RefData;
		if (typeof refsOrError === 'string') {
			/* 仓库没有提交时引用读取必然失败，此时按空引用处理。 */
			if (records.length > 0) throw new Error(refsOrError);
			refs = { head: null, heads: [], tags: [], remotes: [] };
		} else {
			refs = refsOrError;
		}

		const uncommittedChanges = refs.head === null ? 0 : await getUncommittedChanges(repo);
		return { ...assembleCommits(records, refs, stashes, remotes, uncommittedChanges, showTags, maxCommits), error: null };
	} catch (error) {
		return { commits: [], head: null, tags: [], moreCommitsAvailable: false, error: errorText(error) };
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
 * 读取一个标签的详情。
 *
 * 轻量标签没有打标签者信息，返回 `tagDetails: null`；附注标签的签名由 `git verify-tag --raw`
 * 校验后解析。
 *
 * @param repo - 仓库路径。
 * @param tagName - 标签名。
 * @returns 标签详情；读取失败时 `tagDetails` 为 null 且 `error` 为错误文本。
 */
export async function getTagDetails(repo: string, tagName: string): Promise<TagDetailsData> {
	try {
		const ref = `refs/tags/${tagName}`;
		const info = parseTagInfo(await gitOrThrow(['for-each-ref', ref, `--format=${TAG_FORMAT}`], repo));
		if (info === null || info.taggerName === '') return { tagDetails: null, error: null };

		let signature: Signature | null = null;
		if (info.signed) {
			const verified = await runGit(['verify-tag', '--raw', ref], repo);
			signature = parseTagSignature(verified.stderr !== '' ? verified.stderr : verified.stdout);
		}
		const details: TagDetails = {
			hash: info.hash,
			taggerName: info.taggerName,
			taggerEmail: info.taggerEmail,
			taggerDate: info.taggerDate,
			message: info.message,
			signature,
		};
		return { tagDetails: tagDetailsView(details), error: null };
	} catch (error) {
		return { tagDetails: null, error: errorText(error) };
	}
}

/**
 * 读取仓库中的贮藏。
 *
 * @param repo - 仓库路径。
 * @returns 贮藏列表；`refs/stash` 不存在时为空列表。
 */
export async function getStashes(repo: string): Promise<StashEntry[]> {
	const result = await runGit(['reflog', '-z', `--format=${STASH_FORMAT}`, 'refs/stash', '--'], repo);
	/* 仓库没有贮藏时 git 以非零退出。 */
	if (result.code !== 0) return [];
	return parseStashReflog(result.stdout);
}

/**
 * 读取工作区中已删除与未跟踪的路径。
 *
 * @param repo - 仓库路径。
 * @returns 已删除与未跟踪的路径列表。
 */
export async function getStatus(repo: string): Promise<StatusFiles> {
	const stdout = await gitOrThrow(['status', '-s', '--untracked-files=all', '--porcelain', '-z'], repo);
	const fields = stdout.split('\0');
	const deleted: string[] = [];
	const untracked: string[] = [];
	let index = 0;
	while (index < fields.length) {
		const record = fields[index];
		index++;
		if (record === undefined || record.length < 4) break;
		const indexStatus = record.slice(0, 1);
		const worktreeStatus = record.slice(1, 2);
		const path = record.slice(3);
		if (indexStatus === 'D' || worktreeStatus === 'D') deleted.push(path);
		else if (indexStatus === '?' || worktreeStatus === '?') untracked.push(path);
		/* 重命名与复制的记录后紧跟一条原路径记录。 */
		if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') index++;
	}
	return { deleted, untracked };
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
 * 读取分支列表与当前分支。
 *
 * @param repo - 仓库路径。
 * @param showRemoteBranches - 是否列出远程分支。
 * @param hideRemotes - 要隐藏的远程名。
 * @returns 分支名列表（当前分支在首位）与当前分支名。
 */
async function getBranches(repo: string, showRemoteBranches: boolean, hideRemotes: readonly string[]): Promise<{ branches: string[]; head: string | null }> {
	const args = ['for-each-ref', '--format=%(HEAD)%00%(refname:short)%00%(symref)', 'refs/heads'];
	if (showRemoteBranches) args.push('refs/remotes');
	const stdout = await gitOrThrow(args, repo);

	const branches: string[] = [];
	let head: string | null = null;
	for (const line of stdout.split('\n')) {
		if (line === '') continue;
		const fields = line.split('\0');
		if (fields.length < 3) continue;
		const name = fields[1];
		/* 远程 HEAD 是指向分支的符号引用，不是可操作的分支。 */
		if (fields[2] !== '') continue;
		if (hideRemotes.some((remote) => name.startsWith(`${remote}/`))) continue;
		if (fields[0].trim() === '*') {
			head = name;
			branches.unshift(name);
		} else {
			branches.push(name);
		}
	}
	return { branches, head };
}

/**
 * 读取远程名列表。
 *
 * @param repo - 仓库路径。
 * @returns 远程名列表。
 */
async function getRemoteNames(repo: string): Promise<string[]> {
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
 * @param remotes - 已知远程名。
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
	remotes: readonly string[],
	hideRemotes: readonly string[],
	stashes: readonly StashEntry[],
	skip = 0,
): Promise<LogRecord[]> {
	const args = ['-c', 'log.showSignature=false', 'log', '-z', `--max-count=${num}`, `--format=${LOG_FORMAT}`, `--${order}-order`];
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
				args.push('--remotes');
			} else {
				remotes.filter((remote) => !hideRemotes.includes(remote)).forEach((remote) => args.push(`--glob=refs/remotes/${remote}`));
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
 * 读取引用集合。
 *
 * @param repo - 仓库路径。
 * @param showRemoteBranches - 是否包含远程分支。
 * @param showRemoteHeads - 是否包含远程 HEAD 符号引用。
 * @param hideRemotes - 要隐藏的远程名。
 * @returns 引用集合；`head` 为 HEAD 指向的提交哈希。
 */
async function getRefs(repo: string, showRemoteBranches: boolean, showRemoteHeads: boolean, hideRemotes: readonly string[]): Promise<RefData> {
	const args = ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/tags'];
	if (showRemoteBranches) args.push('refs/remotes');

	const [stdout, head] = await Promise.all([
		gitOrThrow(args, repo),
		runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repo),
	]);
	const refs = parseRefs(stdout, hideRemotes, showRemoteHeads);
	const headHash = head.code === 0 ? head.stdout.trim() : '';
	return { ...refs, head: headHash === '' ? null : headHash };
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

/**
 * 统计工作区中的未提交变更数。
 *
 * @param repo - 仓库路径。
 * @returns 变更条目数。
 */
async function getUncommittedChanges(repo: string): Promise<number> {
	// 与 working-tree.ts 的 loadWorkingTree 保持同一参数顺序：同一份 status 在并发时共用子进程。
	const stdout = await gitOrThrow(['status', '--porcelain', '-z', '--untracked-files=all'], repo);
	return parseStatus(stdout).length;
}

/**
 * 取标签详情的展示形状。
 *
 * @param details - 标签详情。
 * @returns 前端使用的标签详情。
 */
function tagDetailsView(details: TagDetails): TagDetailsView {
	return {
		message: details.message,
		tagger: `${details.taggerName} <${details.taggerEmail}>`,
		date: new Date(details.taggerDate * 1000).toLocaleString(),
	};
}
