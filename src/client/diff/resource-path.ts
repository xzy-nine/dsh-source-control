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

/** 解析后的 git-diff 地址。 */
export interface GitDiffAddress {
	readonly sessionId: string;
	readonly hash: string;
	readonly path: string;
}

/**
 * 构造 git 提交差异的资源地址。
 *
 * @param sessionId - 会话 id。
 * @param hash - 提交哈希；'*' 表示工作区。
 * @param filePath - 文件路径（相对仓库根）。
 * @returns `dsh-resource://git-diff/session/<sessionId>/<hash>/<path>` 地址。
 */
export function gitDiffAddress(sessionId: string, hash: string, filePath: string): string {
	const encoded = filePath.split('/').map((s) => encodeURIComponent(s)).join('/');
	return `${GIT_DIFF_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(hash)}/${encoded}`;
}

/**
 * 解析 git-diff 资源地址。
 *
 * @param address - `dsh-resource://git-diff/session/<sessionId>/<hash>/<path>` 地址。
 * @returns 解析结果；地址不合法时返回 null。
 */
export function parseGitDiffAddress(address: unknown): GitDiffAddress | null {
	if (typeof address !== 'string' || !address.startsWith(GIT_DIFF_PREFIX)) return null;
	const rest = address.slice(GIT_DIFF_PREFIX.length);
	const slash1 = rest.indexOf('/');
	if (slash1 === -1) return null;
	const slash2 = rest.indexOf('/', slash1 + 1);
	if (slash2 === -1) return null;
	const sessionId = decodeURIComponent(rest.slice(0, slash1));
	const hash = decodeURIComponent(rest.slice(slash1 + 1, slash2));
	const path = rest.slice(slash2 + 1).split('/').map((s) => decodeURIComponent(s)).join('/');
	return { sessionId, hash, path };
}
