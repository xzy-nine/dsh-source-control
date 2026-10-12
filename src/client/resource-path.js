/**
 * 差异文件地址的构造：把 git 给出的仓库相对路径拼成 `dsh-resource://file/…` 地址。
 *
 * git 的 `status` / `diff --name-status` 返回的路径相对**仓库根**，而地址里的
 * `session/<id>/<path>` 由宿主相对**会话工作区根**解析（`workspaceRoot` 取会话
 * header 的 `cwd`）。选中的仓库与工作区不是同一个时基准不同，因此先用仓库根拼出
 * 绝对路径：在工作区内就给相对路径，区外直接给绝对路径（该 scope 同样接受）。
 */

/** 地址前缀（scope 为 session）。 */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/';

/** 统一分隔符并去掉尾斜杠。 */
const normalize = (path) => String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/** 盘符路径按 Windows 规则忽略大小写比较。 */
const comparable = (path) => (/^[a-zA-Z]:\//.test(path) ? path.toLowerCase() : path);

/**
 * 取绝对路径相对工作区根的部分。
 *
 * @param workspaceRoot - 会话工作区根。
 * @param absolute - 目标绝对路径。
 * @returns 相对路径（工作区根本身为空串）；不在工作区内时返回 null。
 */
function relativeTo(workspaceRoot, absolute) {
	const root = normalize(workspaceRoot);
	if (root === '') return null;
	if (comparable(absolute) === comparable(root)) return '';
	return comparable(absolute).startsWith(`${comparable(root)}/`) ? absolute.slice(root.length + 1) : null;
}

/**
 * 构造某个差异文件的资源地址。
 *
 * @param sessionId - 会话 id。
 * @param workspaceRoot - 会话工作区根；未知时传 null。
 * @param repoRoot - 仓库根的绝对路径，来自 diff 描述。
 * @param filePath - git 给出的文件路径，相对仓库根。
 * @returns `dsh-resource://file/session/<sessionId>/<path>` 地址。
 */
export function diffFileAddress(sessionId, workspaceRoot, repoRoot, filePath) {
	const file = normalize(filePath);
	if (file === '') return null;
	const root = normalize(repoRoot);
	const absolute = /^[a-zA-Z]:\//.test(file) || file.startsWith('/') || root === '' ? file : `${root}/${file}`;
	// 相对路径更短也更稳；区外保留绝对形式——POSIX 靠前导空段表达，盘符自带前缀。
	const relative = workspaceRoot === null || workspaceRoot === undefined ? null : relativeTo(workspaceRoot, absolute);
	const path = relative === null || relative === '' ? absolute : relative;
	const encoded = path.split('/').map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/');
	return `${FILE_ADDRESS_PREFIX}${encodeURIComponent(sessionId)}/${encoded}`;
}