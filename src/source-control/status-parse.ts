/**
 * `git status` 输出的解析层：输入 git 原始输出，输出工作区条目与分支上游关系。
 *
 * 纯解析，不调用 git、不读写文件系统，可直接单测。
 */
import { pickByDepth } from './depth-limit.js';
/**
 * 工作区变更的解析上限。
 *
 * 超大仓库（几十万未跟踪文件）的 status 输出会让解析本身成为负担，截断即可 —— 面板本就
 * 无法展示这么多条目。取值与 VSCode 的 `git.statusLimit` 一致。
 */
export const STATUS_LIMIT = 10000;

/** 一条工作区变更：索引与工作区各自的状态码。 */
export interface WorkingTreeEntry {
	/** 当前路径，相对仓库根，使用 `/` 分隔。 */
	readonly path: string;
	/** 重命名/复制前的路径；其余情况为 null。 */
	readonly origPath: string | null;
	/** 索引状态码（`git status --porcelain` 的第一列）。 */
	readonly index: string;
	/** 工作区状态码（第二列）。 */
	readonly worktree: string;
}

/**
 * 一条 `git status --porcelain -z` 记录的字段。
 *
 * 记录格式为 `XY PATH`；重命名/复制的记录后紧跟一条原路径记录。
 */
export interface StatusRecord {
	/** 索引状态码（第一列）。 */
	readonly index: string;
	/** 工作区状态码（第二列）。 */
	readonly worktree: string;
	/** 当前路径。 */
	readonly path: string;
	/** 重命名/复制前的路径；其余为 null。 */
	readonly origPath: string | null;
	/** 本记录消耗的记录数：重命名/复制为 2，其余为 1。 */
	readonly consumed: number;
}

/** NUL 分隔记录的游标：逐条切片，不预先切出全部记录。 */
interface NulCursor {
	/** 取下一条记录；没有更多时为 null。 */
	next(): string | null;
	/** 是否还有未读的字符。 */
	hasMore(): boolean;
}

/**
 * 建立 NUL 分隔记录的游标。
 *
 * 逐条扫描而不把整段输出切成数组：几十万条记录的仓库上，整段切分会一次性造出同等数量的
 * 临时字符串，解析本身因此成为内存负担。
 *
 * @param text - git 的标准输出。
 * @returns 游标。
 */
function nulRecords(text: string): NulCursor {
	let at = 0;
	return {
		next(): string | null {
			if (at >= text.length) return null;
			const end = text.indexOf('\0', at);
			if (end === -1) {
				const value = text.slice(at);
				at = text.length;
				return value;
			}
			const value = text.slice(at, end);
			at = end + 1;
			return value;
		},
		hasMore(): boolean {
			return at < text.length;
		},
	};
}

/**
 * 逐条遍历 `git status --porcelain -z` 的输出。
 *
 * `-z` 以 NUL 分隔记录，路径不做转义；重命名与复制的记录后紧跟一条原路径记录。
 *
 * @param stdout - git 的标准输出。
 * @param limit - 最多解析的记录数；超出即截断。
 * @param visit - 每条记录的回调。
 * @param renameInWorktree - 工作区列出现 `R`/`C` 时是否也算重命名记录。
 * @returns 实际遍历的记录数；等于 `limit` 表示可能还有未遍历的记录。
 */
export function forEachStatusRecord(
	stdout: string,
	limit: number,
	visit: (record: StatusRecord) => void,
	renameInWorktree = false,
): number {
	const cursor = nulRecords(stdout);
	let count = 0;
	while (count < limit) {
		const record = cursor.next();
		if (record === null || record.length < 4) break;
		const indexStatus = record.slice(0, 1);
		const worktreeStatus = record.slice(1, 2);
		const path = record.slice(3);
		const renamed = indexStatus === 'R' || indexStatus === 'C'
			|| (renameInWorktree && (worktreeStatus === 'R' || worktreeStatus === 'C'));
		let origPath: string | null = null;
		let consumed = 1;
		if (renamed) {
			origPath = cursor.next();
			consumed = 2;
		}
		count++;
		visit({ index: indexStatus, worktree: worktreeStatus, path, origPath, consumed });
	}
	return count;
}

/**
 * 解析 `git status --porcelain -z` 的输出。
 *
 * 记录格式为 `XY PATH`，重命名/复制时追加 `ORIG` 记录；`-z` 以 NUL 分隔，路径不做转义。
 *
 * 条目超过上限时按完整深度截断，规则与 {@link parseStatusSnapshot} 相同。
 *
 * @param stdout - git 的标准输出。
 * @param limit - 最多保留的条目数。
 * @returns 工作区变更列表。
 */
export function parseStatus(stdout: string, limit = STATUS_LIMIT): WorkingTreeEntry[] {
	const entries: WorkingTreeEntry[] = [];
	forEachStatusRecord(stdout, Number.POSITIVE_INFINITY, (record) => {
		entries.push({ path: record.path, origPath: record.origPath, index: record.index, worktree: record.worktree });
	});
	return entries.length > limit ? pickByDepth(entries, limit, (entry) => entry.path) : entries;
}

/** 工作区快照：变更条目与当前分支的上游关系。 */
export interface WorkingTreeSnapshot {
	/** 工作区变更条目，按路径升序。 */
	readonly entries: WorkingTreeEntry[];
	/** 本次读取时的 HEAD 提交哈希；尚无提交时为 null。 */
	readonly head: string | null;
	/** 当前分支短名；分离头指针时为 null。 */
	readonly branch: string | null;
	/** 上游短名；无上游或上游引用不存在时为 null。 */
	readonly upstream: string | null;
	/** 相对上游的领先提交数。 */
	readonly ahead: number;
	/** 相对上游的落后提交数。 */
	readonly behind: number;
	/** 是否处于未完成的合并：`MERGE_HEAD` 存在即为 true。 */
	readonly merging: boolean;
	/** 是否因条目上限而截断：为 true 时 entries 只是前一部分。 */
	readonly truncated: boolean;
}

/** v2 的 XY 列取值：`.` 表示该侧无改动，按空列输出。 */
function column(value: string): string {
	return value === '.' ? ' ' : value;
}

/**
 * 解析 `git status --porcelain=v2 --branch -z` 的输出。
 *
 * 分支信息取自 `# branch.*` 头：`branch.head` 为 `(detached)` 时分支为 null；
 * `branch.oid` 为 `(initial)` 时表示尚无提交；`branch.ab` 缺失表示上游引用不存在，
 * 此时上游同样按无上游处理。
 * 记录以 NUL 分隔，重命名记录的新路径与旧路径分列相邻两条；路径不做转义。
 *
 * 条目超过上限时按完整深度截断：深度更浅的路径优先保留，更深的整层丢弃，保留下来的是
 * 一棵在每个深度上都尽量完整的树。
 *
 * @param stdout - git 的标准输出。
 * @param limit - 最多保留的条目数。
 * @returns 变更条目与分支的上游关系。
 */
export function parseStatusSnapshot(stdout: string, limit = STATUS_LIMIT): WorkingTreeSnapshot {
	const cursor = nulRecords(stdout);
	const entries: WorkingTreeEntry[] = [];
	let head: string | null = null;
	let branch: string | null = null;
	let upstream = '';
	let ab: { ahead: number; behind: number } | null = null;
	/*
	 * 记录先全部收下、解析完再按深度取：上限要按完整深度决定保留哪一层，
	 * 边读边截会在某一层中途停下，得到的是一棵被切开的树。
	 */
	const collect = (entry: WorkingTreeEntry): void => { entries.push(entry); };
	for (;;) {
		const token = cursor.next();
		if (token === null) break;
		if (token === '') continue;
		if (token.startsWith('# ')) {
			const space = token.indexOf(' ', 2);
			const key = space === -1 ? token.slice(2) : token.slice(2, space);
			const value = space === -1 ? '' : token.slice(space + 1);
			if (key === 'branch.oid') head = value === '' || value === '(initial)' ? null : value;
			else if (key === 'branch.head') branch = value === '' || value === '(detached)' ? null : value;
			else if (key === 'branch.upstream') upstream = value;
			else if (key === 'branch.ab') {
				/* 取值形如 `+1 -2`：加号为领先、减号为落后。 */
				const [aheadRaw, behindRaw] = value.split(' ');
				const ahead = Number.parseInt(aheadRaw.replace('+', ''), 10);
				const behind = Number.parseInt(behindRaw.replace('-', ''), 10);
				ab = { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
			}
			continue;
		}
		const kind = token.slice(0, 1);
		if (kind === '?') {
			collect({ path: token.slice(2), origPath: null, index: '?', worktree: '?' });
			continue;
		}
		if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
		const parts = token.split(' ');
		/* 固定字段数：普通记录 8、重命名记录 9、未合并记录 10，其后整段为路径。 */
		const fieldCount = kind === 'u' ? 10 : kind === '2' ? 9 : 8;
		const path = parts.slice(fieldCount).join(' ');
		if (path === '') continue;
		const xy = parts[1] ?? '';
		let origPath: string | null = null;
		if (kind === '2') {
			origPath = cursor.next();
		}
		/* v2 用 `.` 表示该侧无改动，统一按空列输出，与 v1 的两列语义一致。 */
		collect({ path, origPath, index: column(xy.slice(0, 1)), worktree: column(xy.slice(1, 2)) });
	}
	const truncated = entries.length > limit;
	return {
		entries: truncated ? pickByDepth(entries, limit, (entry) => entry.path) : entries,
		head, branch, upstream: upstream !== '' && ab !== null ? upstream : null,
		ahead: ab?.ahead ?? 0, behind: ab?.behind ?? 0, merging: false, truncated,
	};
}
