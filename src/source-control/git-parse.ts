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
			const annotated = peeled !== '';
			tags.push({
				hash: annotated ? peeled : objectname,
				name: refname.slice('refs/tags/'.length),
				annotated,
			});
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
 * 顺序与边界行为：先按 `maxCommits + 1` 判定是否还有更多并丢掉多取的一条；HEAD 在列表内
 * 且存在未提交变更时，在最前插入哈希为 `*` 的伪提交；随后插入不在列表中的贮藏；最后把
 * 分支、标签与远程分支标注到对应提交上。
 *
 * @param records - `git log` 的原始记录，已按 `maxCommits + 1` 取回。
 * @param refs - 引用集合。
 * @param stashes - 仓库中的贮藏。
 * @param remotes - 已知远程名，用于给远程分支标注所属远程。
 * @param uncommittedChanges - 未提交变更数；为 0 时不插入伪提交。
 * @param showTags - 是否标注标签。
 * @param maxCommits - 请求的提交数上限。
 * @param now - 伪提交的时间（秒）；默认取当前时间。
 * @returns 提交图。
 */
export function assembleCommits(
	records: readonly LogRecord[],
	refs: RefData,
	stashes: readonly StashEntry[],
	remotes: readonly string[],
	uncommittedChanges: number,
	showTags: boolean,
	maxCommits: number,
	now: number = Math.round(Date.now() / 1000),
): CommitGraph {
	const commits: LogRecord[] = [...records];
	const moreCommitsAvailable = commits.length === maxCommits + 1;
	if (moreCommitsAvailable) commits.pop();

	if (refs.head !== null && uncommittedChanges > 0) {
		const headIndex = commits.findIndex((commit) => commit.hash === refs.head);
		if (headIndex !== -1) {
			commits.unshift({
				hash: UNCOMMITTED, parents: [refs.head], author: '*', email: '', date: now,
				message: `Uncommitted Changes (${uncommittedChanges})`,
			});
		}
	}

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
