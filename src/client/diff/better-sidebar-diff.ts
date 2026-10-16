/**
 * 复用 dsh-better-sidebar 差异页的接入层：能力探测、种子换算与打开。
 *
 * better-sidebar 以 `ctx.betterSidebar.openTab({ type: 'diff', diff })` 打开它的差异页，
 * `diff` 只支持两种引用：工作区单文件差异（`worktree`）与整提交补丁（`commit`）。
 * 该类型未注册、被设置页关闭，或本插件的差异描述无法换算成这两种引用时，本模块返回失败，
 * 调用方回退到本插件自己的差异页。
 *
 * 仓库根的层级也是一条回退判据：better-sidebar 只认识会话工作区自身所在的仓库与它的
 * 直接子目录仓库，更深的仓库交给它会把命令跑在别的仓库上（见 {@link betterSidebarKnowsRepo}）。
 *
 * 本模块不依赖 React 与其它客户端模块，可直接单测。
 */

/** 本插件的差异描述（`tab.diff`）。字段按需读取，非法值一律按缺失处理。 */
export interface DiffTarget {
	/** `'file'` 是普通文件打开，不是差异；`'worktree'` / `'commit'` 是差异。 */
	readonly kind?: unknown;
	/** 文件路径，相对仓库根。 */
	readonly path?: unknown;
	/** 所选仓库根的绝对路径。 */
	readonly repoRoot?: unknown;
	/** 工作区差异是否取暂存区一侧。 */
	readonly staged?: unknown;
	/** 工作区差异的目标是否为未跟踪文件。 */
	readonly untracked?: unknown;
	/** 短提交哈希。 */
	readonly hash?: unknown;
	/** 完整提交哈希。 */
	readonly hashFull?: unknown;
	/** 提交标题。 */
	readonly subject?: unknown;
	/** 两提交对比的旧侧哈希；非空时该对比无法换算。 */
	readonly baseHash?: unknown;
}

/** better-sidebar 的差异引用。 */
export type SidebarDiffRef =
	| {
		readonly kind: 'worktree';
		readonly path: string;
		readonly staged: boolean;
		readonly untracked?: boolean;
		readonly repoRoot?: string;
	}
	| {
		readonly kind: 'commit';
		readonly hash: string;
		readonly hashFull: string;
		readonly subject: string;
		readonly repoRoot?: string;
	};

/** better-sidebar 服务的结构切片（只取本模块用到的部分）。 */
export interface BetterSidebarDiffService {
	/** 按 id 查已注册的页类型；`diff` 未注册时返回 undefined。 */
	getTab(id: string): unknown;
	/** 某个页类型是否在侧栏设置中启用；缺省视为启用。 */
	isTabEnabled?(id: string): boolean;
	/** 打开一个页。类型被禁用时该调用是静默 no-op。 */
	openTab(seed: { type: string; title?: string; diff?: SidebarDiffRef }, scope?: { sessionId: string; cwd?: string }): void;
}

/** 会话作用域。 */
export interface DiffOpenScope {
	readonly sessionId: string;
	readonly cwd?: string;
}

/** 非空字符串，否则 undefined。 */
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** 统一分隔符、去掉尾斜杠与冗余段，便于按路径层级比较。 */
const normalizePath = (path: string): string => {
	const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
	const drive = /^[a-zA-Z]:/.test(unified);
	const segments: string[] = [];
	for (const segment of unified.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') { segments.pop(); continue; }
		segments.push(segment);
	}
	return `${drive ? '' : '/'}${segments.join('/')}`;
};

/** 路径比较用的标识；盘符路径按 Windows 规则忽略大小写。 */
const pathKey = (path: string): string => (/^[a-zA-Z]:/.test(normalizePath(path)) ? normalizePath(path).toLowerCase() : normalizePath(path));

/**
 * better-sidebar 能否把 git 命令定位到该仓库。
 *
 * 它按「会话工作区根所在的仓库 + 工作区根的直接子目录仓库」发现仓库；选中仓库不在这个
 * 集合里时，它会**静默回退到发现列表的第一项**，于是差异落到别的仓库上：工作区差异显示
 * 为「没有文本差异」，提交差异报 `bad object <哈希>`（该哈希只存在于真正选中的仓库）。
 *
 * 因此只在仓库就是工作区根本身或它的直接子目录时交给它；更深的层级回退到本插件自己的
 * 差异页，那里的仓库根由本插件解析，不受此限。
 *
 * @param workspaceRoot - 会话工作区根；未知时传 undefined。
 * @param repoRoot - 选中仓库的绝对路径。
 * @returns 可以交给 better-sidebar 时为 true。
 */
export function betterSidebarKnowsRepo(workspaceRoot: string | undefined, repoRoot: string | undefined): boolean {
	if (workspaceRoot === undefined || repoRoot === undefined) return false;
	const root = pathKey(workspaceRoot);
	const target = pathKey(repoRoot);
	if (root === '' || target === '') return false;
	if (target === root) return true;
	if (!target.startsWith(`${root}/`)) return false;
	// 直接子目录：根之后只剩一段。
	return !target.slice(root.length + 1).includes('/');
}

/** 路径末段，用作页标题。 */
const baseName = (path: string): string => {
	const segments = path.replace(/\\/g, '/').split('/');
	return segments[segments.length - 1] ?? path;
};

/**
 * 探测可用的 better-sidebar 差异能力。
 *
 * `openTab` 对未注册或已禁用的类型是静默 no-op，因此这里要求能确认 `diff` 类型已注册：
 * 缺 `getTab`、查不到描述符或该类型被关闭都返回 null，由调用方回退。
 *
 * @param service - `ctx.get('betterSidebar')` 的结果，可能未装载。
 * @returns 可用的服务切片；不可用时为 null。
 */
export function resolveBetterSidebarDiff(service: unknown): BetterSidebarDiffService | null {
	if (service === null || service === undefined || typeof service !== 'object') return null;
	const candidate = service as Partial<BetterSidebarDiffService>;
	if (typeof candidate.openTab !== 'function') return null;
	if (typeof candidate.getTab !== 'function') return null;
	let descriptor: unknown;
	try {
		descriptor = candidate.getTab('diff');
	} catch {
		return null;
	}
	if (descriptor === undefined || descriptor === null) return null;
	if (typeof candidate.isTabEnabled === 'function') {
		try {
			if (candidate.isTabEnabled('diff') === false) return null;
		} catch {
			return null;
		}
	}
	return candidate as BetterSidebarDiffService;
}

/**
 * 把本插件的差异描述换算成 better-sidebar 的差异引用。
 *
 * 无法换算的情况返回 null：普通文件打开（不是差异）、提交缺少哈希，以及两提交区间对比——
 * better-sidebar 的引用没有旧侧哈希字段，任何近似都会显示成另一段差异。
 *
 * @param target - 本插件的差异描述。
 * @returns 差异引用；无法换算时为 null。
 */
export function toSidebarDiffRef(target: DiffTarget | null | undefined): SidebarDiffRef | null {
	if (target === null || target === undefined) return null;
	const path = text(target.path);
	if (path === undefined) return null;
	const repoRoot = text(target.repoRoot);
	const root = repoRoot === undefined ? {} : { repoRoot };
	if (target.kind === 'worktree') {
		return {
			kind: 'worktree',
			path,
			staged: target.staged === true,
			...(target.untracked === true ? { untracked: true } : {}),
			...root,
		};
	}
	if (target.kind === 'commit') {
		// 区间对比没有等价引用。
		if (text(target.baseHash) !== undefined) return null;
		const hashFull = text(target.hashFull) ?? text(target.hash);
		if (hashFull === undefined) return null;
		const hash = text(target.hash) ?? hashFull.slice(0, 8);
		return {
			kind: 'commit',
			hash,
			hashFull,
			subject: text(target.subject) ?? path,
			...root,
		};
	}
	return null;
}

/**
 * 差异页的标题：工作区差异取文件名，提交差异取「短哈希 提交标题」。
 *
 * 提交差异页显示的是整提交补丁而非单文件差异，标题据此描述整份补丁。
 *
 * @param ref - 差异引用。
 * @returns 页标题。
 */
export function diffTitleOf(ref: SidebarDiffRef): string {
	return ref.kind === 'worktree' ? baseName(ref.path) : `${ref.hash} ${ref.subject}`;
}

/**
 * 在 better-sidebar 的差异页中打开一个差异目标。
 *
 * 仓库根比工作区根深一级以上时报告回退：它会把命令跑在别的仓库上（见
 * {@link betterSidebarKnowsRepo}）。
 *
 * @param service - {@link resolveBetterSidebarDiff} 的返回值。
 * @param target - 本插件的差异描述。
 * @param scope - 会话作用域；`sessionId` 必填，`cwd` 供其内部按会话解析路径。
 * @returns 是否已交给 better-sidebar；false 表示调用方应回退。
 */
export function openDiffInBetterSidebar(
	service: BetterSidebarDiffService | null,
	target: DiffTarget | null | undefined,
	scope: DiffOpenScope,
): boolean {
	if (service === null) return false;
	// 工作区差异与提交差异都以所选仓库根为准；层级过深时它的解析会落到别的仓库。
	if (!betterSidebarKnowsRepo(scope.cwd, text(target?.repoRoot))) return false;
	const ref = toSidebarDiffRef(target);
	if (ref === null) return false;
	try {
		service.openTab(
			{ type: 'diff', title: diffTitleOf(ref), diff: ref },
			{ sessionId: scope.sessionId, ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }) },
		);
	} catch {
		return false;
	}
	return true;
}
