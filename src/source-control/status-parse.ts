/**
 * `git status` 输出的解析层：输入 git 原始输出，输出工作区条目与分支上游关系。
 *
 * 纯解析，不调用 git、不读写文件系统，可直接单测。
 */
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

/**
 * 逐条遍历 `git status --porcelain -z` 的输出。
 *
 * `-z` 以 NUL 分隔记录，路径不做转义；重命名与复制的记录后紧跟一条原路径记录。
 *
 * @param stdout - git 的标准输出。
 * @param limit - 最多解析的记录数；超出即截断。
 * @param visit - 每条记录的回调。
 * @param renameInWorktree - 工作区列出现 `R`/`C` 时是否也算重命名记录。
 * @returns 无。
 */
export function forEachStatusRecord(
	stdout: string,
	limit: number,
	visit: (record: StatusRecord) => void,
	renameInWorktree = false,
): void {
	const fields: (string | undefined)[] = stdout.split('\0');
	let index = 0;
	let count = 0;
	while (index < fields.length && count < limit) {
		const record = fields[index];
		index++;
		if (record === undefined || record.length < 4) break;
		const indexStatus = record.slice(0, 1);
		const worktreeStatus = record.slice(1, 2);
		const path = record.slice(3);
		const renamed = indexStatus === 'R' || indexStatus === 'C'
			|| (renameInWorktree && (worktreeStatus === 'R' || worktreeStatus === 'C'));
		let origPath: string | null = null;
		let consumed = 1;
		if (renamed) {
			origPath = fields[index] ?? null;
			index++;
			consumed = 2;
		}
		count++;
		visit({ index: indexStatus, worktree: worktreeStatus, path, origPath, consumed });
	}
}

/**
 * 解析 `git status --porcelain -z` 的输出。
 *
 * 记录格式为 `XY PATH`，重命名/复制时追加 `ORIG` 记录；`-z` 以 NUL 分隔，路径不做转义。
 *
 * @param stdout - git 的标准输出。
 * @param limit - 最多解析的记录数；超出即截断，避免超大仓库解析出巨量条目。
 * @returns 工作区变更列表。
 */
export function parseStatus(stdout: string, limit = STATUS_LIMIT): WorkingTreeEntry[] {
	const entries: WorkingTreeEntry[] = [];
	forEachStatusRecord(stdout, limit, (record) => {
		entries.push({ path: record.path, origPath: record.origPath, index: record.index, worktree: record.worktree });
	});
	return entries;
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
 * @param stdout - git 的标准输出。
 * @param limit - 最多解析的记录数；超出即截断。
 * @returns 变更条目与分支的上游关系。
 */
export function parseStatusSnapshot(stdout: string, limit = STATUS_LIMIT): WorkingTreeSnapshot {
	const tokens = stdout.split('\0');
	const entries: WorkingTreeEntry[] = [];
	let head: string | null = null;
	let branch: string | null = null;
	let upstream = '';
	let ab: { ahead: number; behind: number } | null = null;
	let index = 0;
	while (index < tokens.length && entries.length < limit) {
		const token = tokens[index];
		index++;
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
			entries.push({ path: token.slice(2), origPath: null, index: '?', worktree: '?' });
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
			origPath = tokens[index] ?? null;
			index++;
		}
		/* v2 用 `.` 表示该侧无改动，统一按空列输出，与 v1 的两列语义一致。 */
		entries.push({ path, origPath, index: column(xy.slice(0, 1)), worktree: column(xy.slice(1, 2)) });
	}
	return {
		entries, head, branch, upstream: upstream !== '' && ab !== null ? upstream : null,
		ahead: ab?.ahead ?? 0, behind: ab?.behind ?? 0, merging: false,
	};
}
