/**
 * git 输出的纯解析层：输入 git 的原始输出字符串，输出数据结构，不做任何 git 调用。
 *
 * 全部函数不依赖 node 内置模块之外的任何模块，可被测试直接导入。
 * 分隔约定：多记录命令用 `-z` 让 git 以 NUL 终止每条记录，记录内的字段另用 `%x00` 分隔，
 * 因此字段数固定，按固定字段数切分即可；路径与提交信息里的换行不再需要转义。
 */
import type {
	CommitGraph, CommitNode, CommitStash, FileChange, FileStatus, Signature, SignatureStatus, StashEntry,
} from './git-types.js';

/** 日志类命令的字段分隔符（即 `--format` 中的 `%x00`）。 */
const FIELD = '\0';

/** `git log` 每条的字段数：hash、parents、author、email、date、subject。 */
export const LOG_FIELD_COUNT = 6;
/** `git log` 的格式串。 */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x00');

/** `git reflog refs/stash` 每条的字段数：hash、parents、selector、author、email、date、subject。 */
export const STASH_FIELD_COUNT = 7;
/** 贮藏 reflog 的格式串。 */
export const STASH_FORMAT = ['%H', '%P', '%gD', '%an', '%ae', '%at', '%s'].join('%x00');

/** 提交详情的字段数：hash、parents、作者三项、提交者三项、签名三项、正文。 */
export const DETAILS_FIELD_COUNT = 12;
/** 提交详情的格式串。 */
export const DETAILS_FORMAT = [
	'%H', '%P',
	'%an', '%ae', '%at',
	'%cn', '%ce', '%ct',
	'%G?', '%GS', '%GK',
	'%B',
].join('%x00');

/** 引用列表的字段数：全名、对象名、解引用对象名、对象类型。 */
export const REF_FIELD_COUNT = 4;
/** 引用列表的格式串。 */
export const REF_FORMAT = ['%(refname)', '%(objectname)', '%(*objectname)', '%(objecttype)'].join('%00');

/** 分支同步的格式串；`%(HEAD)` 标出当前分支。 */
export const BRANCH_SYNC_FORMAT = ['%(HEAD)', '%(refname:short)', '%(upstream:short)', '%(upstream:track,nobracket)'].join('%00');

/**
 * 引用与分支合并读取的字段数：HEAD 标记、全名、短名、对象名、解引用对象名、对象类型、符号引用目标。
 */
export const REF_BRANCH_FIELD_COUNT = 7;

/**
 * 引用与分支合并读取的格式串。
 *
 * 引用集合与分支列表读的是同一批引用，只是取值不同；一次枚举即可同时得到两者，避免同一次
 * 首屏为此起两个子进程。
 */
export const REF_BRANCH_FORMAT = [
	'%(HEAD)', '%(refname)', '%(refname:short)', '%(objectname)', '%(*objectname)', '%(objecttype)', '%(symref)',
].join('%00');

/** 一次引用枚举同时得到的引用集合与分支列表。 */
export interface RefsAndBranches {
	/** 引用集合；`head` 由调用方按 `HEAD` 文件补入。 */
	readonly refs: RefData;
	/** 分支名列表，当前分支在首位。 */
	readonly branches: string[];
	/** 当前分支名；分离头指针为 null。 */
	readonly branch: string | null;
}

/** 一个仓库的分支同步状态。 */
export interface BranchSync {
	readonly branch: string | null;
	readonly upstream: string | null;
	readonly ahead: number;
	readonly behind: number;
}

/** 未提交伪提交的哈希。 */
export const UNCOMMITTED = '*';

/** `git log` 的一条原始记录。 */
export interface LogRecord {
	readonly hash: string;
	readonly parents: string[];
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}

/** 一条引用。 */
export interface RefEntry {
	readonly hash: string;
	readonly name: string;
}

/** 一条标签引用。 */
export interface RefTag extends RefEntry {
	readonly annotated: boolean;
}

/** 引用集合。 */
export interface RefData {
	readonly head: string | null;
	readonly heads: RefEntry[];
	readonly tags: RefTag[];
	readonly remotes: RefEntry[];
}

/** `--name-status` 的一条记录。 */
export interface DiffNameStatusRecord {
	readonly type: FileStatus;
	readonly oldFilePath: string;
	readonly newFilePath: string;
}

/** `--numstat` 的一条记录。 */
export interface DiffNumStatRecord {
	readonly filePath: string;
	readonly additions: number | null;
	readonly deletions: number | null;
}

/** 工作区中未提交且未跟踪的路径。 */
export interface StatusFiles {
	readonly deleted: string[];
	readonly untracked: string[];
}

/** 索引条目：`git ls-files -s` 的一条记录。 */
export interface IndexEntry {
	/** 文件模式；子模块为 `160000`。 */
	readonly mode: string;
	/** 索引记录的提交或 blob 哈希。 */
	readonly sha: string;
	/** 冲突阶段；正常条目为 0。 */
	readonly stage: number;
	/** 路径，相对仓库根，`/` 分隔。 */
	readonly path: string;
}

/** 子模块在索引里的文件模式。 */
export const GITLINK_MODE = '160000';

/**
 * 解析 `git ls-files -s -z` 的输出。
 *
 * 每条记录形如 `<mode> <sha> <stage>\t<path>`：路径在第一个制表符之后，因此路径本身可以含
 * 空格与制表符。字段不足或阶段非数字的记录丢弃。
 *
 * @param stdout - git 的标准输出。
 * @returns 索引条目，保持输出顺序。
 */
export function parseIndexEntries(stdout: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	for (const record of stdout.split(FIELD)) {
		if (record === '') continue;
		const tab = record.indexOf('\t');
		if (tab === -1) continue;
		const header = record.slice(0, tab).split(' ');
		const path = record.slice(tab + 1);
		const stage = Number.parseInt(header[2], 10);
		if (path === '' || header.length < 3 || !Number.isFinite(stage)) continue;
		entries.push({ mode: header[0], sha: header[1], stage, path });
	}
	return entries;
}

/**
 * 按固定字段数把 `-z` 输出切成记录。
 *
 * `-z` 会在每条记录后补一个 NUL，因此先去掉末尾空串，再按字段数分组；
 * 字段数不整除的尾部残片丢弃。
 *
 * @param stdout - git 的标准输出。
 * @param fieldCount - 每条记录的字段数。
 * @returns 每条记录的字段数组。
 */
export function splitRecords(stdout: string, fieldCount: number): string[][] {
	if (stdout === '') return [];
	const parts = stdout.split(FIELD);
	if (parts[parts.length - 1] === '') parts.pop();
	const records: string[][] = [];
	for (let i = 0; i + fieldCount <= parts.length; i += fieldCount) {
		records.push(parts.slice(i, i + fieldCount));
	}
	return records;
}

/**
 * 去掉数组末尾的空行。
 *
 * @param lines - 行数组。
 * @returns 同一个数组。
 */
export function removeTrailingBlankLines(lines: string[]): string[] {
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * 取字符串数组去重后的结果。
 *
 * @param items - 可能有重复的字符串。
 * @returns 去重后的数组，保持首次出现顺序。
 */
export function unique(items: readonly string[]): string[] {
	return [...new Set(items)];
}

/**
 * 解析 `git log -z --format=<LOG_FORMAT>` 的输出。
 *
 * @param stdout - git 的标准输出。
 * @returns 提交记录。
 */
export function parseLog(stdout: string): LogRecord[] {
	return splitRecords(stdout, LOG_FIELD_COUNT).map((fields) => ({
		hash: fields[0],
		parents: fields[1] === '' ? [] : fields[1].split(' '),
		author: fields[2],
		email: fields[3],
		date: Number.parseInt(fields[4], 10),
		message: fields[5],
	}));
}

/**
 * 解析 `git reflog -z --format=<STASH_FORMAT> refs/stash --` 的输出。
 *
 * 缺父提交或父提交只有一个（无未跟踪文件提交）的记录按贮藏处理：
 * 第二个父提交存在时即未跟踪文件所在的提交。
 *
 * @param stdout - git 的标准输出。
 * @returns 贮藏条目。
 */
export function parseStashReflog(stdout: string): StashEntry[] {
	const stashes: StashEntry[] = [];
	for (const fields of splitRecords(stdout, STASH_FIELD_COUNT)) {
		const parents = fields[1] === '' ? [] : fields[1].split(' ');
		if (parents.length === 0) continue;
		stashes.push({
			hash: fields[0],
			baseHash: parents[0],
			untrackedFilesHash: parents.length === 3 ? parents[2] : null,
			selector: fields[2],
			author: fields[3],
			email: fields[4],
			date: Number.parseInt(fields[5], 10),
			message: fields[6],
		});
	}
	return stashes;
}

/**
 * 由引用的对象名与解引用对象名构造一条标签记录。
 *
 * 附注标签的 `%(objectname)` 是标签对象本身，其解引用对象才是被标注的提交，因此附注标签以解
 * 引用哈希标注到提交上。
 *
 * @param refname - 引用的全名。
 * @param objectname - `%(objectname)`。
 * @param peeled - `%(*objectname)`；空串表示轻量标签。
 * @returns 标签记录。
 */
function tagOf(refname: string, objectname: string, peeled: string): RefTag {
	const annotated = peeled !== '';
	return {
		hash: annotated ? peeled : objectname,
		name: refname.slice('refs/tags/'.length),
		annotated,
	};
}

/**
 * 解析 `git for-each-ref --format=<REF_FORMAT>` 的输出。
 *
 * 记录以换行分隔、字段以 NUL 分隔。附注标签的 `%(objectname)` 是标签对象本身，
 * 其解引用对象才是被标注的提交，因此附注标签以解引用哈希标注到提交上。
 *
 * @param stdout - git 的标准输出。
 * @param hideRemotes - 要隐藏的远程名。
 * @param showRemoteHeads - 是否显示远程 HEAD 符号引用。
 * @returns 引用集合。
 */
export function parseRefs(stdout: string, hideRemotes: readonly string[] = [], showRemoteHeads = false): RefData {
	const heads: RefEntry[] = [];
	const tags: RefTag[] = [];
	const remotes: RefEntry[] = [];
	const hidePrefixes = hideRemotes.map((remote) => `refs/remotes/${remote}/`);

	for (const line of stdout.split('\n')) {
		if (line === '') continue;
		const fields = line.split(FIELD);
		if (fields.length < REF_FIELD_COUNT) continue;
		const refname = fields[0];
		const objectname = fields[1];
		const peeled = fields[2];
		if (refname.startsWith('refs/heads/')) {
			heads.push({ hash: objectname, name: refname.slice('refs/heads/'.length) });
		} else if (refname.startsWith('refs/tags/')) {
			tags.push(tagOf(refname, objectname, peeled));
		} else if (refname.startsWith('refs/remotes/')) {
			const short = refname.slice('refs/remotes/'.length);
			// 远程 HEAD 是指向分支的符号引用，不是可操作的分支。
			if (!showRemoteHeads && short.endsWith('/HEAD')) continue;
			if (hidePrefixes.some((prefix) => refname.startsWith(prefix))) continue;
			remotes.push({ hash: objectname, name: short });
		}
	}
	return { head: null, heads, tags, remotes };
}

/**
 * 一次枚举同时解析引用集合与分支列表。
 *
 * 与 {@link parseRefs} 同一套记录解析，另按 `%(HEAD)` 标出当前分支、按 `%(refname:short)` 给出
 * 分支名。远程 HEAD 是指向分支的符号引用，不作为可操作的分支。
 *
 * @param stdout - `git for-each-ref --format=<REF_BRANCH_FORMAT>` 的输出。
 * @param hideRemotes - 要隐藏的远程名。
 * @returns 引用集合、分支名列表与当前分支名。
 */
export function parseRefsAndBranches(stdout: string, hideRemotes: readonly string[] = []): RefsAndBranches {
	const heads: RefEntry[] = [];
	const tags: RefTag[] = [];
	const remotes: RefEntry[] = [];
	const branches: string[] = [];
	const hidePrefixes = hideRemotes.map((remote) => `refs/remotes/${remote}/`);
	let branch: string | null = null;

	for (const line of stdout.split('\n')) {
		if (line === '') continue;
		const fields = line.split(FIELD);
		if (fields.length < REF_BRANCH_FIELD_COUNT) continue;
		const isHead = fields[0].trim() === '*';
		const refname = fields[1];
		const short = fields[2];
		const objectname = fields[3];
		const peeled = fields[4];
		const symref = fields[6];

		if (refname.startsWith('refs/heads/')) {
			const name = refname.slice('refs/heads/'.length);
			heads.push({ hash: objectname, name });
			if (isHead) {
				branch = name;
				branches.unshift(name);
			} else {
				branches.push(name);
			}
			continue;
		}
		if (refname.startsWith('refs/tags/')) {
			tags.push(tagOf(refname, objectname, peeled));
			continue;
		}
		if (!refname.startsWith('refs/remotes/')) continue;
		const name = refname.slice('refs/remotes/'.length);
		/* 远程 HEAD 是指向分支的符号引用，不是可操作的分支。 */
		if (symref !== '') continue;
		if (hidePrefixes.some((prefix) => refname.startsWith(prefix))) continue;
		remotes.push({ hash: objectname, name });
		if (showRemoteBranch(short)) branches.push(short);
	}

	return { refs: { head: null, heads, tags, remotes }, branches, branch };
}

/**
 * 远程分支是否计入分支列表。
 *
 * 远程 HEAD（`<远程>/HEAD`）是符号引用，不出现在列表里。
 *
 * @param short - 引用的短名。
 * @returns 计入时为 true。
 */
function showRemoteBranch(short: string): boolean {
	return short !== '' && !short.endsWith('/HEAD');
}

/**
 * 解析 `git config --list -z --includes` 的输出。
 *
 * 每条记录以 NUL 终止，键与值之间用换行分隔；键重复时后者覆盖前者。
 *
 * @param stdout - git 的标准输出。
 * @returns 键值对。
 */
export function parseConfigList(stdout: string): Record<string, string> {
	const configs: Record<string, string> = {};
	for (const record of stdout.split(FIELD)) {
		if (record === '') continue;
		const newline = record.indexOf('\n');
		if (newline === -1) configs[record] = '';
		else configs[record.slice(0, newline)] = record.slice(newline + 1);
	}
	return configs;
}

/** `--name-status` / `--numstat` 的解析选项。 */
export interface DiffParseOptions {
	/**
	 * 是否跳过首个字段的对象名。
	 *
	 * `git diff-tree` 的 `-z` 输出以被查询的提交对象名开头，`git diff` 两个修订的形式没有；
	 * 前者须置为 true。
	 */
	readonly skipLeadingObjectName?: boolean;
}

/**
 * 解析 `git diff --name-status -z` 的输出。
 *
 * 记录首字段是状态字符：新增/修改/删除各带一个路径，重命名/复制各带新旧两个路径。
 *
 * @param stdout - git 的标准输出。
 * @param options - 见 {@link DiffParseOptions}。
 * @returns 改动记录。
 */
export function parseNameStatus(stdout: string, options: DiffParseOptions = {}): DiffNameStatusRecord[] {
	const parts = stdout.split(FIELD);
	if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
	if (options.skipLeadingObjectName === true) parts.shift();
	const records: DiffNameStatusRecord[] = [];
	let i = 0;
	while (i < parts.length) {
		const status = parts[i];
		if (status === '') break;
		// 复制（C）在改动列表里按重命名处理，因此这里按字符判断而不收窄成 FileStatus。
		const code = status.slice(0, 1);
		if (code === 'R' || code === 'C') {
			if (i + 2 >= parts.length) break;
			records.push({ type: 'R', oldFilePath: parts[i + 1], newFilePath: parts[i + 2] });
			i += 3;
		} else if (code === 'A' || code === 'M' || code === 'D') {
			if (i + 1 >= parts.length) break;
			records.push({ type: code, oldFilePath: parts[i + 1], newFilePath: parts[i + 1] });
			i += 2;
		} else {
			// 过滤集之外的记录（类型变更等）不参与改动列表。
			i += 1;
		}
	}
	return records;
}

/**
 * 解析 `git diff --numstat -z` 的输出。
 *
 * 每条的第三个制表符字段为空表示重命名/复制，紧随其后是新旧两个路径。
 * 二进制文件的增删数为 `-`，解析为 null。
 *
 * @param stdout - git 的标准输出。
 * @param options - 见 {@link DiffParseOptions}。
 * @returns 增删统计。
 */
export function parseNumStat(stdout: string, options: DiffParseOptions = {}): DiffNumStatRecord[] {
	const parts = stdout.split(FIELD);
	if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
	if (options.skipLeadingObjectName === true) parts.shift();
	const records: DiffNumStatRecord[] = [];
	let i = 0;
	while (i < parts.length) {
		const fields = parts[i].split('\t');
		if (fields.length !== 3) break;
		const additions = parseCount(fields[0]);
		const deletions = parseCount(fields[1]);
		if (fields[2] !== '') {
			records.push({ filePath: fields[2], additions, deletions });
			i += 1;
		} else {
			if (i + 2 >= parts.length) break;
			records.push({ filePath: parts[i + 2], additions, deletions });
			i += 3;
		}
	}
	return records;
}

/**
 * 把 `--numstat` 的计数解析为数字；二进制文件的 `-` 解析为 null。
 *
 * @param text - 计数字段。
 * @returns 计数；无法解析时为 null。
 */
function parseCount(text: string): number | null {
	const value = Number.parseInt(text, 10);
	return Number.isFinite(value) ? value : null;
}

/**
 * 由差异记录与工作区状态生成改动列表。
 *
 * 状态信息补上未跟踪与已删除的文件，并覆盖同名记录的删除标记；增删数按路径回填。
 *
 * @param nameStatusRecords - `--name-status` 记录。
 * @param numStatRecords - `--numstat` 记录。
 * @param status - 工作区中未提交且未跟踪的路径；不需要时为 null。
 * @returns 改动列表。
 */
export function generateFileChanges(
	nameStatusRecords: readonly DiffNameStatusRecord[],
	numStatRecords: readonly DiffNumStatRecord[],
	status: StatusFiles | null,
): FileChange[] {
	const fileChanges: FileChange[] = [];
	const fileLookup = new Map<string, number>();

	for (const record of nameStatusRecords) {
		fileLookup.set(record.newFilePath, fileChanges.length);
		fileChanges.push({
			oldFilePath: record.oldFilePath, newFilePath: record.newFilePath, type: record.type,
			additions: null, deletions: null,
		});
	}

	if (status !== null) {
		for (const filePath of status.deleted) {
			const at = fileLookup.get(filePath);
			if (at === undefined) {
				fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: 'D', additions: null, deletions: null });
			} else {
				fileChanges[at] = { ...fileChanges[at], type: 'D' };
			}
		}
		for (const filePath of status.untracked) {
			fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: 'U', additions: null, deletions: null });
		}
	}

	for (const record of numStatRecords) {
		const at = fileLookup.get(record.filePath);
		if (at !== undefined) {
			fileChanges[at] = { ...fileChanges[at], additions: record.additions, deletions: record.deletions };
		}
	}
	return fileChanges;
}

/**
 * 解析提交详情的公共字段。
 *
 * 正文取最后一个字段并去掉末尾空行；签名状态码不在已知集合内时 `signature` 为 null。
 *
 * @param stdout - `git show --quiet --format=<DETAILS_FORMAT>` 的输出。
 * @returns 详情字段；字段数不足时为 null。
 */
export function parseCommitDetails(stdout: string): {
	hash: string; parents: string[]; author: string; authorEmail: string; authorDate: number;
	committer: string; committerEmail: string; committerDate: number; signature: Signature | null; body: string;
} | null {
	const fields = stdout.split(FIELD);
	// 带 `-z` 时末尾会多一个空字段（记录终止符），正文只取到正文为止。
	while (fields.length > DETAILS_FIELD_COUNT && fields[fields.length - 1] === '') fields.pop();
	if (fields.length < DETAILS_FIELD_COUNT) return null;
	// 正文是最后一个字段，本身可能含 NUL 以外的任意字符与换行。
	const body = removeTrailingBlankLines(fields.slice(DETAILS_FIELD_COUNT - 1).join(FIELD).split(/\r\n|\r|\n/)).join('\n');
	const status = parseSignatureStatus(fields[8]);
	return {
		hash: fields[0],
		parents: fields[1] === '' ? [] : fields[1].split(' '),
		author: fields[2],
		authorEmail: fields[3],
		authorDate: Number.parseInt(fields[4], 10),
		committer: fields[5],
		committerEmail: fields[6],
		committerDate: Number.parseInt(fields[7], 10),
		signature: status === null ? null : { status, signer: fields[9].trim(), key: fields[10].trim() },
		body,
	};
}

/**
 * 判断 `%G?` 的状态码是否表示存在签名。
 *
 * @param code - `%G?` 的取值；`N` 表示无签名。
 * @returns 状态码；无签名时为 null。
 */
export function parseSignatureStatus(code: string): SignatureStatus | null {
	return ['G', 'U', 'X', 'Y', 'R', 'E', 'B'].includes(code) ? code as SignatureStatus : null;
}

/**
 * 解析 `git for-each-ref --format=BRANCH_SYNC_FORMAT refs/heads` 的输出。
 *
 * 每行一条记录，字段以 NUL 分隔；第一字段为 `*` 的记录是当前分支。当前分支没有上游、
 * 上游引用已被删除（track 为 `gone`）或计数缺失时，上游为 null、领先与落后为 0。
 *
 * @param stdout - git 的标准输出。
 * @returns 当前分支的同步状态；无当前分支记录时分支与上游为 null、计数为 0。
 */
export function parseBranchSync(stdout: string): BranchSync {
	const empty: BranchSync = { branch: null, upstream: null, ahead: 0, behind: 0 };
	for (const line of stdout.split('\n')) {
		if (line === '') continue;
		const fields = line.split(FIELD);
		if (fields[0] !== '*') continue;
		const branch = fields[1] ?? '';
		if (branch === '') return empty;
		const upstreamName = fields[2] ?? '';
		const track = fields[3] ?? '';
		if (upstreamName === '' || track === 'gone') return { branch, upstream: null, ahead: 0, behind: 0 };
		const ahead = /ahead (\d+)/.exec(track);
		const behind = /behind (\d+)/.exec(track);
		return {
			branch,
			upstream: upstreamName,
			ahead: ahead === null ? 0 : Number.parseInt(ahead[1], 10),
			behind: behind === null ? 0 : Number.parseInt(behind[1], 10),
		};
	}
	return empty;
}

/**
 * 把原始提交记录、引用与贮藏组装成提交图。
 *
 * 顺序与边界行为：先按 `maxCommits + 1` 判定是否还有更多并丢掉多取的一条；随后插入不在
 * 列表中的贮藏；最后把分支、标签与远程分支标注到对应提交上。
 *
 * 哈希为 `*` 的未提交伪提交不在这里插入：它需要工作区条目数，而读取工作区要起一次
 * `git status`，提交图的返回时刻会因此取决于工作区读取。该行由客户端按同一轮的工作区
 * 快照补出，见 `client/panel/commit-diff.ts` 的 `withUncommittedCount`。
 *
 * @param records - `git log` 的原始记录，已按 `maxCommits + 1` 取回。
 * @param refs - 引用集合。
 * @param stashes - 仓库中的贮藏。
 * @param remotes - 已知远程名，用于给远程分支标注所属远程。
 * @param showTags - 是否标注标签。
 * @param maxCommits - 请求的提交数上限。
 * @param skip - 本窗口在 `git log` 中的起始偏移。
 * @returns 提交图。
 */
export function assembleCommits(
	records: readonly LogRecord[],
	refs: RefData,
	stashes: readonly StashEntry[],
	remotes: readonly string[],
	showTags: boolean,
	maxCommits: number,
	skip = 0,
): CommitGraph {
	const commits: LogRecord[] = [...records];
	const moreCommitsAvailable = commits.length === maxCommits + 1;
	if (moreCommitsAvailable) commits.pop();
	/*
	 * 下一窗口的偏移按本页实际消费的日志记录数累加。
	 *
	 * 不能用本页 `commits` 长度：下面会插入贮藏行，它们是引用而不是 `git log` 记录，
	 * 计入偏移会让下一页跳过真实提交。
	 */
	const nextSkip = skip + commits.length;

	const nodes: CommitNode[] = commits.map((commit) => ({
		...commit, heads: [], tags: [], remotes: [], stash: null,
	}));
	const lookup = new Map<string, number>();
	nodes.forEach((node, index) => lookup.set(node.hash, index));

	/* 插入贮藏：已在列表中的直接标记；只在基提交上出现的插入到基提交之前。 */
	const toAdd: Array<{ index: number; data: StashEntry }> = [];
	for (const stash of stashes) {
		const own = lookup.get(stash.hash);
		if (own !== undefined) {
			nodes[own] = { ...nodes[own], stash: stashMark(stash) };
			continue;
		}
		const base = lookup.get(stash.baseHash);
		if (base !== undefined) toAdd.push({ index: base, data: stash });
	}
	toAdd.sort((left, right) => (left.index !== right.index ? left.index - right.index : right.data.date - left.data.date));
	for (let i = toAdd.length - 1; i >= 0; i--) {
		const stash = toAdd[i].data;
		nodes.splice(toAdd[i].index, 0, {
			hash: stash.hash, parents: [stash.baseHash], author: stash.author, email: stash.email,
			date: stash.date, message: stash.message, heads: [], tags: [], remotes: [],
			stash: stashMark(stash),
		});
	}
	// 插入后下标整体右移，重建查表。
	lookup.clear();
	nodes.forEach((node, index) => lookup.set(node.hash, index));

	for (const head of refs.heads) {
		const at = lookup.get(head.hash);
		if (at !== undefined) nodes[at] = { ...nodes[at], heads: [...nodes[at].heads, head.name] };
	}
	if (showTags) {
		for (const tag of refs.tags) {
			const at = lookup.get(tag.hash);
			if (at !== undefined) nodes[at] = { ...nodes[at], tags: [...nodes[at].tags, { name: tag.name, annotated: tag.annotated }] };
		}
	}
	for (const remote of refs.remotes) {
		const at = lookup.get(remote.hash);
		if (at === undefined) continue;
		const owner = remotes.find((name) => remote.name.startsWith(`${name}/`)) ?? null;
		nodes[at] = { ...nodes[at], remotes: [...nodes[at].remotes, { name: remote.name, remote: owner }] };
	}

	return {
		commits: nodes,
		head: refs.head,
		tags: unique(refs.tags.map((tag) => tag.name)),
		moreCommitsAvailable,
		nextSkip,
	};
}

/**
 * 取贮藏的标记形状。
 *
 * @param stash - 贮藏条目。
 * @returns 提交上的贮藏标记。
 */
function stashMark(stash: StashEntry): CommitStash {
	return { selector: stash.selector, baseHash: stash.baseHash, untrackedFilesHash: stash.untrackedFilesHash };
}
