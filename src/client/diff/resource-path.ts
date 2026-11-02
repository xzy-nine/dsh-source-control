/**
 * 差异文件地址的构造：把 git 给出的仓库相对路径拼成 `dsh-resource://file/…` 地址。
 *
 * git 的 `status` / `diff --name-status` 返回的路径相对**仓库根**，因此先用仓库根拼成
 * 绝对路径。地址里的路径保持绝对形式：`session/<id>/<path>` 由宿主按其会话工作区根解析，
 * 相对路径会被再拼一次，而插件持有的工作区根未必与宿主一致。
 */

/** 地址前缀（scope 为 session）。 */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/';

/** 统一分隔符并去掉尾斜杠。 */
const normalize = (path: string | null | undefined): string => (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * 是否已是绝对路径。
 *
 * @param path - 统一分隔符后的路径。
 * @returns 盘符路径、POSIX 绝对路径或 UNC 路径时为 true。
 */
const isAbsolutePath = (path: string): boolean => /^[a-zA-Z]:\//.test(path) || path.startsWith('/') || /^\/\//.test(path);

/**
 * 构造某个差异文件的资源地址。
 *
 * 地址里的路径一律用绝对路径。`session/<id>/<path>` 由宿主按该会话的工作区根解析，
 * 而插件持有的工作区根来自会话快照，与宿主实际使用的未必一致（选中链接工作树、
 * 或在检出外的工作树里操作时），按它换算相对路径会被宿主再拼一次，得到重复路径。
 *
 * @param sessionId - 会话 id。
 * @param repoRoot - 仓库根的绝对路径，来自 diff 描述。
 * @param filePath - git 给出的文件路径，相对仓库根或已是绝对路径。
 * @returns `dsh-resource://file/session/<sessionId>/<path>` 地址。
 */
export function diffFileAddress(sessionId: string, repoRoot: string, filePath: string): string | null {
	const file = normalize(filePath);
	if (file === '') return null;
	const root = normalize(repoRoot);
	const absolute = isAbsolutePath(file) || root === '' ? file : `${root}/${file}`;
	const encoded = absolute.split('/').map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/');
	return `${FILE_ADDRESS_PREFIX}${encodeURIComponent(sessionId)}/${encoded}`;
}

/** git-diff 地址前缀。 */
const GIT_DIFF_PREFIX = 'dsh-resource://git-diff/session/';

/** 暂存区的作用域标记：与工作区的 `*` 分开，标题据此区分两者。 */
const INDEX_TOKEN = 'index';

/** 一次差异比较的作用域：比哪一侧到哪一侧。 */
export type GitDiffScope =
	| { readonly kind: 'worktree'; readonly staged: boolean }
	| { readonly kind: 'commit'; readonly hash: string }
	| { readonly kind: 'compare'; readonly baseHash: string; readonly hash: string };

/** 解析后的 git-diff 地址。 */
export interface GitDiffAddress {
	readonly sessionId: string;
	readonly scope: GitDiffScope;
	/** 旧格式地址里的路径；新格式把路径放在导航参数里，此处为空串。 */
	readonly legacyPath: string;
}

/**
 * 作用域在地址里的写法。
 *
 * 地址即页身份：同一作用域下的不同文件共用一个页，文件由导航参数切换。
 *
 * @param scope - 比较作用域。
 * @returns 地址里的作用域段。
 */
export function gitDiffScopeToken(scope: GitDiffScope): string {
	if (scope.kind === 'worktree') return scope.staged ? INDEX_TOKEN : '*';
	if (scope.kind === 'commit') return scope.hash;
	return `${scope.baseHash}..${scope.hash}`;
}

/** 后端 `fileDiffContent` 的取数坐标。 */
export interface GitDiffRequest {
	/** `commitHash` 参数：工作区为 `*`，提交为哈希。 */
	readonly commitHash: string;
	/** 是否比较暂存区；仅工作区作用域有意义。 */
	readonly staged: boolean;
	/** 两提交对比的旧侧哈希；无此项时按单提交处理。 */
	readonly baseHash: string;
}

/**
 * 把比较作用域换算成后端命令的参数。
 *
 * 地址里的作用域写法与命令参数不是一回事：暂存区在地址里写作 `index`，
 * 而命令用 `commitHash: '*'` 加 `staged: true` 表示。
 *
 * @param scope - 比较作用域。
 * @returns 取数坐标。
 */
export function gitDiffRequest(scope: GitDiffScope): GitDiffRequest {
	if (scope.kind === 'worktree') return { commitHash: '*', staged: scope.staged, baseHash: '' };
	if (scope.kind === 'commit') return { commitHash: scope.hash, staged: false, baseHash: '' };
	return { commitHash: scope.hash, staged: false, baseHash: scope.baseHash };
}

/**
 * 构造一个差异作用域的页地址。
 *
 * @param sessionId - 会话 id。
 * @param scope - 比较作用域。
 * @returns `dsh-resource://git-diff/session/<sessionId>/<作用域>` 地址。
 */
export function gitDiffAddress(sessionId: string, scope: GitDiffScope): string {
	return `${GIT_DIFF_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(gitDiffScopeToken(scope))}`;
}

/**
 * 由作用域段还原比较作用域。
 *
 * @param token - 地址里的作用域段。
 * @returns 比较作用域；无法识别时返回 null。
 */
function scopeOfToken(token: string): GitDiffScope | null {
	if (token === '*') return { kind: 'worktree', staged: false };
	if (token === INDEX_TOKEN) return { kind: 'worktree', staged: true };
	const range = token.indexOf('..');
	if (range !== -1) {
		const baseHash = token.slice(0, range);
		const hash = token.slice(range + 2);
		return baseHash !== '' && hash !== '' ? { kind: 'compare', baseHash, hash } : null;
	}
	return token !== '' ? { kind: 'commit', hash: token } : null;
}

/**
 * 解析 git-diff 资源地址。
 *
 * 兼容旧格式 `session/<id>/<hash>/<path>`：多出的路径段原样带回 `legacyPath`。
 *
 * @param address - `dsh-resource://git-diff/session/<sessionId>/<作用域>[/<旧路径>]` 地址。
 * @returns 解析结果；地址不合法时返回 null。
 */
export function parseGitDiffAddress(address: unknown): GitDiffAddress | null {
	if (typeof address !== 'string' || !address.startsWith(GIT_DIFF_PREFIX)) return null;
	const rest = address.slice(GIT_DIFF_PREFIX.length);
	const slash = rest.indexOf('/');
	if (slash === -1) return null;
	const sessionId = decodeURIComponent(rest.slice(0, slash));
	const tail = rest.slice(slash + 1);
	const next = tail.indexOf('/');
	const token = decodeURIComponent(next === -1 ? tail : tail.slice(0, next));
	const scope = scopeOfToken(token);
	if (scope === null) return null;
	const legacyPath = next === -1 ? '' : tail.slice(next + 1).split('/').map((segment) => decodeURIComponent(segment)).join('/');
	return { sessionId, scope, legacyPath };
}

/**
 * 差异页的页标题：比较作用域，而不是文件名。
 *
 * @param scope - 比较作用域。
 * @returns 侧栏页签上的标题。
 */
export function gitDiffTitle(scope: GitDiffScope): string {
	const short = (hash: string): string => (hash === '*' ? '工作区' : hash.slice(0, 7));
	if (scope.kind === 'worktree') return scope.staged ? '暂存的更改' : '更改';
	if (scope.kind === 'commit') return `提交 ${short(scope.hash)}`;
	return `对比 ${short(scope.baseHash)} → ${short(scope.hash)}`;
}