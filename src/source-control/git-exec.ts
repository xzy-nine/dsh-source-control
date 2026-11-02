/**
 * git 执行层：在指定仓库中以数组参数跑 git，无 shell。
 *
 * 子进程环境、子进程生命周期、空闲跟踪、调用频率告警、只读结果缓存与在途复用、
 * 仓库写事件都在本模块。上层的工作区操作与子模块操作共用这里的 {@link runGit}。
 */
import { spawn } from 'node:child_process';
import { collectProcess } from './child-process.js';
import { logDebug, logInfo, logWarn } from './logger.js';

/** 一次失败写进日志的 stderr 字符上限。 */
const MAX_GIT_LOG_CHARS = 2000;

/** 一次 git 调用的结果。 */
export interface GitResult {
	/** 退出码；被信号终止时为 -1。 */
	readonly code: number;
	/** 标准输出（按 UTF-8 解码）。 */
	readonly stdout: string;
	/** 标准错误（按 UTF-8 解码）。 */
	readonly stderr: string;
}

/** 一次 git 调用的选项。 */
export interface GitOptions {
	/**
	 * 跳过只读结果缓存，强制读取当前值。
	 *
	 * 判定性读取用它：缓存按毫秒计有效期，期间插件之外的写（编辑器、外部命令）不会让缓存失效，
	 * 读到的可能是旧值。
	 */
	readonly noCache?: boolean;
	/**
	 * 不通知仓库写事件。
	 *
	 * 供「可能没改动任何东西」的写命令使用：抓取在远端没有新提交时不改变任何引用，通知会
	 * 让所有面板重取一遍。调用方在确认确有改动后经 {@link notifyRepositoryWrite} 补发。
	 */
	readonly quietWrite?: boolean;
}

/**
 * 子进程环境：在父进程环境上禁用凭据交互与分页。
 *
 * `GIT_TERMINAL_PROMPT=0` 让缺凭据的远程操作直接失败，而不是挂在等待输入上；
 * `GIT_PAGER` 兜住 git 误判为交互终端的场合。
 *
 * `LANGUAGE` / `LC_ALL` / `LANG` 固定为英文：git 的提示文本参与失败归类（`git-messages.ts`
 * 按英文措辞匹配）与部分解析，随系统语言变化会让这两处行为不一致。父进程已显式给出这些
 * 键时保留用户取值。
 *
 * `GIT_OPTIONAL_LOCKS=0` 只加在只读命令上：它让 git 跳过「刷新索引」这类可选加锁，
 * 读操作因此不必等待写锁、也不会在仓库里留下锁文件。写命令不能设它，否则索引可能不落盘。
 *
 * @param readOnly - 本次命令是否只读。
 * @returns 传给子进程的环境变量。
 */
export function gitEnvironment(readOnly = false): NodeJS.ProcessEnv {
	const key = [readOnly ? '1' : '0', process.env.LANGUAGE ?? '', process.env.LC_ALL ?? '', process.env.LANG ?? ''].join('\0');
	const cached = environmentCache.get(key);
	if (cached !== undefined) return cached;
	const env = buildGitEnvironment(readOnly);
	environmentCache.set(key, env);
	return env;
}

/**
 * 环境对象的缓存。
 *
 * 一次取数会起多个子进程，环境对象因此只展开一次。键含父进程的语言取值：那三项参与结果，
 * 只按只读形态作键会让父进程改语言后仍返回旧对象。
 */
const environmentCache = new Map<string, NodeJS.ProcessEnv>();

/**
 * 构造子进程环境，未命中缓存时调用一次。
 *
 * @param readOnly - 本次命令是否只读。
 * @returns 传给子进程的环境变量。
 */
function buildGitEnvironment(readOnly: boolean): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: '0',
		GIT_PAGER: 'cat',
		GIT_EDITOR: 'true',
		// 远程操作挂在网络或凭据等待上时自行失败，而不是无限占住子进程。
		GIT_HTTP_LOW_SPEED_LIMIT: '1000',
		GIT_HTTP_LOW_SPEED_TIME: '30',
		GIT_ASKPASS: '',
		SSH_ASKPASS: '',
	};
	if (env.LANGUAGE === undefined) env.LANGUAGE = 'en';
	if (env.LC_ALL === undefined) env.LC_ALL = 'en_US.UTF-8';
	if (env.LANG === undefined) env.LANG = 'en_US.UTF-8';
	if (readOnly) env.GIT_OPTIONAL_LOCKS = '0';
	return env;
}

/** 一定访问远端的子命令。 */
const NETWORK_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'clone', 'ls-remote']);

/**
 * 判断一条命令是否会访问远端。
 *
 * 不能只看子命令名：`git remote`（列远程）、`git remote add/set-url`（改配置）都是纯本地，
 * 只有 `remote prune/update` 才联网；`git submodule` 单独用是本地，带 update 才联网。
 *
 * 用途是操作类别判定（联网命令记为 `network`，参与面板的忙碌分级）。
 *
 * @param args - 完整参数数组。
 * @returns 会访问远端时为 true。
 */
function isNetworkCommand(args: readonly string[]): boolean {
	const subcommand = args[0] ?? '';
	if (NETWORK_SUBCOMMANDS.has(subcommand)) return true;
	if (subcommand === 'remote') return args.slice(1).some((arg) => arg === 'prune' || arg === 'update');
	if (subcommand === 'submodule') return args.includes('update');
	return false;
}

/**
 * 规范化仓库路径，作为闸门与缓存的键。
 *
 * 大小写与结尾分隔符在 Windows 上等价，不归一会被当成两个仓库，各自占用一份并发额度。
 *
 * @param cwd - 工作目录。
 * @returns 规范化后的路径。
 */
export function normalizeRepo(cwd: string): string {
	return cwd.replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 已启动且未结束的子进程；宿主退出时逐个终止，避免留下孤儿 git.exe。
 *
 * 不设截止时刻：远端不可达或凭据缺失时 git 自身会结束进程，钩子属于仓库自身的脚本，
 * 其耗时不由本插件限制。本集合只用于宿主退出时的清理。
 */
const liveChildren = new Set<ReturnType<typeof spawn>>();

/**
 * 按进程树终止一个 git 子进程。
 *
 * Windows 上 kill 只终止直接子进程，而 git 会再派生 git.exe（子模块、凭据助手、lfs），
 * 遗留的孙进程同样占 CPU 与仓库句柄，因此按 /t 整树终止。
 *
 * @param child - 子进程。
 * @returns 无。
 */
function killTree(child: ReturnType<typeof spawn>): void {
	if (process.platform === 'win32' && child.pid !== undefined) {
		spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
		return;
	}
	try {
		child.kill();
	} catch {
		/* 进程已退出 */
	}
}

/**
 * 终止所有在跑的 git 子进程。
 *
 * Windows 上父进程退出不会连带结束子进程，遗留的 git.exe 会持有仓库句柄并占 CPU。
 *
 * @returns 无。
 */
export function killRunningGit(): void {
	for (const child of liveChildren) killTree(child);
	liveChildren.clear();
}

/* 宿主退出与终止信号下都收尾；重复调用无副作用。 */
process.once('exit', killRunningGit);
process.once('SIGINT', killRunningGit);
process.once('SIGTERM', killRunningGit);
process.once('beforeExit', killRunningGit);

/** 一次操作的类别；只读操作之间自由并发，写操作参与 idle 判定。 */
export type GitOperationKind = 'status' | 'log' | 'refs' | 'config' | 'diff' | 'write' | 'network' | 'other';

/** 操作类别中哪些属于只读；只读操作不参与 idle 判定，可自由并发。 */
const READ_ONLY_KINDS = new Set<GitOperationKind>(['status', 'log', 'refs', 'config', 'diff', 'other']);

/** 一条在跑的操作。 */
interface GitOperation {
	readonly kind: GitOperationKind;
	readonly readOnly: boolean;
	readonly repo: string;
}

/**
 * 运行中的操作登记：按仓库与类别跟踪。
 *
 * 不做队列、不做硬限流（并发限制会把正常的多仓库刷新串行化）：只读操作自由并发，
 * 写操作通过 {@link isGitIdle} 参与刷新门控 —— 写操作未完成时，由文件变更触发的刷新会等待。
 */
const runningOperations = new Map<string, Set<GitOperation>>();

/** 操作结束时的通知者；idle 门控据此唤醒等待方。 */
const idleListeners = new Set<() => void>();

/**
 * 登记一条操作开始。
 *
 * @param repo - 规范化后的仓库路径。
 * @param kind - 操作类别。
 * @returns 该操作的句柄，用于结束登记。
 */
function startOperation(repo: string, kind: GitOperationKind): GitOperation {
	const operation: GitOperation = { kind, readOnly: READ_ONLY_KINDS.has(kind), repo };
	let set = runningOperations.get(repo);
	if (set === undefined) { set = new Set(); runningOperations.set(repo, set); }
	set.add(operation);
	return operation;
}

/**
 * 注销一条操作，并唤醒 idle 等待者。
 *
 * @param repo - 规范化后的仓库路径。
 * @param operation - 操作句柄。
 * @returns 无。
 */
function endOperation(repo: string, operation: GitOperation): void {
	const set = runningOperations.get(repo);
	if (set === undefined) return;
	set.delete(operation);
	if (set.size === 0) runningOperations.delete(repo);
	for (const notify of idleListeners) notify();
}

/**
 * 是否没有写操作在跑。
 *
 * 只读操作（status / log / diff / refs / config）不算忙：它们之间互不冲突，
 * 让它们参与判定会让刷新在只读查询期间一直等待。
 *
 * @param repo - 限定仓库；省略时检查所有仓库。
 * @returns 没有写操作在跑时为 true。
 */
export function isGitIdle(repo?: string): boolean {
	for (const [key, set] of runningOperations) {
		if (repo !== undefined && key !== normalizeRepo(repo)) continue;
		for (const operation of set) {
			if (!operation.readOnly) return false;
		}
	}
	return true;
}

/**
 * 是否没有会改动工作区的操作在跑。
 *
 * 与 {@link isGitIdle} 的区别是联网命令不算阻塞：抓取与推送期间工作区与索引都不会被改写，
 * 读工作区的命令（status / diff / ls-files）可以照常读。抓取通常要几秒，等它会让面板明显卡顿，
 * 而读到的内容与抓取无关。
 *
 * 写操作（提交、合并、检出等）仍要等：它们会改写索引或工作区，读到的可能是写了一半的状态。
 *
 * @param repo - 限定仓库；省略时检查所有仓库。
 * @returns 没有会改写工作区的操作在跑时为 true。
 */
export function isWorktreeIdle(repo?: string): boolean {
	for (const [key, set] of runningOperations) {
		if (repo !== undefined && key !== normalizeRepo(repo)) continue;
		for (const operation of set) {
			if (!operation.readOnly && operation.kind !== 'network') return false;
		}
	}
	return true;
}

/**
 * 等到条件成立；每次有操作结束就重判一次。
 *
 * @param ready - 条件判据。
 * @param signal - 取消信号；已取消时立即返回。
 * @returns 无。
 */
async function waitUntil(ready: () => boolean, signal?: AbortSignal): Promise<void> {
	while (!ready()) {
		if (signal?.aborted === true) return;
		await new Promise<void>((resolve) => {
			const notify = (): void => { idleListeners.delete(notify); resolve(); };
			idleListeners.add(notify);
		});
	}
}

/**
 * 等到没有写操作在跑（含联网命令）。
 *
 * 提交、合并这类会改写索引或工作区的操作，以及需要独占仓库的联网操作都用它。
 *
 * @param repo - 限定仓库；省略时等待所有仓库。
 * @param signal - 取消信号。
 * @returns 无。
 */
export async function whenGitIdle(repo?: string, signal?: AbortSignal): Promise<void> {
	await waitUntil(() => isGitIdle(repo), signal);
}

/**
 * 等到没有会改动工作区的操作在跑（联网命令不算）。
 *
 * @param repo - 限定仓库；省略时等待所有仓库。
 * @param signal - 取消信号。
 * @returns 无。
 */
export async function whenWorktreeIdle(repo?: string, signal?: AbortSignal): Promise<void> {
	await waitUntil(() => isWorktreeIdle(repo), signal);
}

/**
 * 按命令推断操作类别。
 *
 * @param args - 完整参数数组。
 * @returns 操作类别。
 */
function kindOf(args: readonly string[]): GitOperationKind {
	const subcommand = args[0] ?? '';
	if (subcommand === 'status') return 'status';
	if (subcommand === 'log' || subcommand === 'show' || subcommand === 'rev-list') return 'log';
	if (subcommand === 'for-each-ref' || subcommand === 'rev-parse' || subcommand === 'symbolic-ref' || subcommand === 'reflog') return 'refs';
	if (subcommand === 'config') return 'config';
	if (subcommand === 'diff') return 'diff';
	if (isNetworkCommand(args)) return 'network';
	if (!isReadOnly(args)) return 'write';
	return 'other';
}

/**
 * 诊断用限流器：只记录、不阻断。
 *
 * 按调用方分组统计每秒调用数，超过阈值时记一条日志。用途是发现「谁在刷屏调 git」，
 * 而不是限制正常使用 —— 硬限流会把多仓库并行刷新串行化。
 */
const CALL_WINDOW_MS = 1000;
const CALL_WARN_THRESHOLD = 100;
const CALL_WARN_COOLDOWN_MS = 10000;
const callTimestamps = new Map<string, number[]>();
const lastWarnAt = new Map<string, number>();

/**
 * 记一次调用；超阈值时按调用点输出一条告警。
 *
 * @param args - 完整参数数组。
 * @returns 无。
 */
function checkCallRate(args: readonly string[]): void {
	const caller = new Error().stack?.split('\n')[3]?.trim() ?? 'unknown';
	const now = Date.now();
	const recent = (callTimestamps.get(caller) ?? []).filter((at) => now - at < CALL_WINDOW_MS);
	recent.push(now);
	callTimestamps.set(caller, recent);
	if (recent.length < CALL_WARN_THRESHOLD) return;
	const warnedAt = lastWarnAt.get(caller) ?? 0;
	if (now - warnedAt < CALL_WARN_COOLDOWN_MS) return;
	lastWarnAt.set(caller, now);
	logWarn('git', `git 调用过于频繁（1 秒内 ${String(recent.length)} 次），调用点 ${caller}：git ${describeGitArgs(args)}`);
}

/** 只读子命令的结果缓存：键为仓库与参数，值为结果与过期时间。 */
const resultCache = new Map<string, { result: GitResult; expiresAt: number }>();

/**
 * 结果缓存的条数上限。
 *
 * 游标分页的每页 key 都不同（含起始 hash），且取回后不会再读第二次；不设上限时翻几百页就会
 * 把每页结果永久留在宿主内存里。上限按「同时活跃的查询数」定，够覆盖面板的重复读，又不随
 * 翻页数增长。
 */
const MAX_CACHE_ENTRIES = 64;

/**
 * 只读子命令的结果缓存时长。
 *
 * 面板在编辑期间会按节拍反复读同一份不变的数据；一次 git 约 70–90ms，若调用间隔大于
 * 执行时间，在途复用命不中，缓存按节拍命中即可避免整轮重复起进程。
 */
const CACHE_TTL_MS = 200;

/**
 * 输出取决于工作区或索引当前内容的只读子命令：它们不进结果缓存。
 *
 * 缓存的失效只覆盖插件自己执行的写命令，插件之外的写（编辑器、外部命令）无从感知，
 * 缓存期内读到的因此可能是旧值。子模块的内部改动更会改变父仓库 `status` 的结果，
 * 失效范围再宽也覆盖不到。因此这类命令一律现读现用。
 */
const WORKTREE_DEPENDENT_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'ls-files']);

/**
 * 写入一条只读结果，并维持缓存上限。
 *
 * 淘汰顺序：先删过期项，仍超上限时按插入序删最旧。Map 保持插入序，因此无需额外维护 LRU 链。
 *
 * @param key - 缓存键。
 * @param result - 结果。
 * @returns 无。
 */
function setCachedResult(key: string, result: GitResult): void {
	const now = Date.now();
	resultCache.set(key, { result, expiresAt: now + CACHE_TTL_MS });
	if (resultCache.size <= MAX_CACHE_ENTRIES) return;
	for (const [existing, entry] of resultCache) {
		if (resultCache.size <= MAX_CACHE_ENTRIES) break;
		if (entry.expiresAt <= now) resultCache.delete(existing);
	}
	while (resultCache.size > MAX_CACHE_ENTRIES) {
		const oldest = resultCache.keys().next();
		if (oldest.done === true) break;
		resultCache.delete(oldest.value);
	}
}

/**
 * 只读命令的精确形态：子命令 + 允许出现的开关前缀。
 *
 * 不能只看第一个子命令名：`git remote`（读远程列表）与 `git remote add/remove/prune`（写）同首参，
 * `branch`/`tag`/`worktree`/`config` 也都如此；按名字放行会把写操作当只读缓存，写后读到旧值。
 * 因此这里逐一列出确认只读的形态，未列出的一律当作写操作（不缓存、并失效该仓库缓存）。
 */
const READ_ONLY_FORMS: ReadonlyArray<{ subcommand: string; allow?: readonly string[]; deny?: readonly string[] }> = [
	// 总是只读：这些子命令没有写形态。
	{ subcommand: 'status' },
	{ subcommand: 'diff' },
	{ subcommand: 'diff-tree' },
	{ subcommand: 'log' },
	{ subcommand: 'show' },
	{ subcommand: 'for-each-ref' },
	{ subcommand: 'rev-list' },
	{ subcommand: 'reflog' },
	{ subcommand: 'ls-files' },
	{ subcommand: 'cat-file' },
	{ subcommand: 'describe' },
	{ subcommand: 'symbolic-ref' },
	{ subcommand: 'rev-parse' },
	{ subcommand: 'remote', deny: ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'prune', 'update'] },
	{ subcommand: 'branch', deny: ['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '--set-upstream-to', '--unset-upstream', '--edit-description'] },
	{ subcommand: 'tag', deny: ['-d', '-a', '-s', '-m', '-f', '--delete', '--annotate', '--force'] },
	{ subcommand: 'worktree', deny: ['add', 'remove', 'prune', 'move', 'lock', 'unlock', 'repair'] },
	{ subcommand: 'config', allow: ['--list', '-l', '--get', '--get-all', '--get-regexp', '--get-urlmatch'] },
];

/**
 * 取子命令在参数数组中的下标。
 *
 * git 允许全局选项出现在子命令之前，本仓库用过的是 `-c key=value`（见 `git-query.ts` 的
 * `getLog`）。全局选项不改变子命令语义，但不先跳过就会让按首参识别子命令的判定把只读命令
 * 当成写操作。未识别的全局选项不跳过，这类命令仍按写操作处理。
 *
 * @param args - 完整参数数组。
 * @returns 子命令的下标。
 */
function subcommandIndex(args: readonly string[]): number {
	let index = 0;
	while (args[index] === '-c' && index + 1 < args.length) index += 2;
	return index;
}

/**
 * 判断一条命令是否只读。
 *
 * @param args - 完整参数数组。
 * @returns 确认只读时为 true。
 */
function isReadOnly(args: readonly string[]): boolean {
	const start = subcommandIndex(args);
	const form = READ_ONLY_FORMS.find((entry) => entry.subcommand === (args[start] ?? ''));
	if (form === undefined) return false;
	const rest = args.slice(start + 1);
	if (form.deny !== undefined && rest.some((arg) => form.deny?.includes(arg))) return false;
	// 有 allow 清单的子命令必须命中其一，避免 `git config key value`（写）被放行。
	if (form.allow !== undefined && !rest.some((arg) => form.allow?.includes(arg))) return false;
	return true;
}

/**
 * 判断一条只读命令的输出是否随工作区或索引的当前内容变化。
 *
 * @param args - 完整参数数组。
 * @returns 依赖当前内容时为 true。
 */
function dependsOnWorktree(args: readonly string[]): boolean {
	return WORKTREE_DEPENDENT_SUBCOMMANDS.has(args[subcommandIndex(args)] ?? '');
}

/**
 * 清掉某个仓库的只读缓存。
 *
 * 失效范围含该路径的所有祖先：子模块的写会改变父仓库 `status` 的结果（父仓库把子模块的
 * 内部改动记成自身的一条条目），因此子模块目录下的写必须让父仓库的缓存一并失效。
 * 链接工作树与主仓库共用 git 公共目录，两者的状态互为镜像，同样由前缀关系覆盖。
 *
 * @param repo - 规范化后的仓库路径。
 * @returns 无。
 */
function invalidateRepo(repo: string): void {
	for (const key of resultCache.keys()) {
		// 键形如 `<仓库>\0<参数>`：取仓库部分与各祖先前缀比对。
		const separator = key.indexOf('\u0000');
		if (separator === -1) continue;
		const cached = key.slice(0, separator);
		if (cached === repo || repo.startsWith(`${cached}/`) || cached.startsWith(`${repo}/`)) {
			resultCache.delete(key);
		}
	}
}

/** 进行中的调用：键为仓库与参数的组合，值共享同一个子进程。 */
const inFlightGit = new Map<string, Promise<GitResult>>();

/**
 * 仓库写操作的观察者：参数为仓库路径（调用方给出的原样写法）。
 *
 * 面板订阅它来即时反映别的会话、别的工作区或外部进程对同一仓库的改动 —— 那些改动不产生
 * 当前会话的事件，事件驱动的刷新看不到。通知不携带任何数据，由接收方自行重读。
 *
 * 判据是「写命令跑完了」，不是「退出码为 0」：冲突合并、拣选冲突与变基停下都以非零退出，
 * 但仓库已被改动（建立了待合并状态与未解决条目），此时仍必须通知。
 */
const writeListeners = new Set<(repo: string) => void>();

/**
 * 订阅仓库写操作。
 *
 * @param listener - 写命令结束后调用。
 * @returns 取消订阅。
 */
export function onRepositoryWrite(listener: (repo: string) => void): () => void {
	writeListeners.add(listener);
	return () => { writeListeners.delete(listener); };
}

/**
 * 通知一次仓库写操作。
 *
 * @param cwd - 工作目录，调用方给出的原样写法。
 * @returns 无。
 */
function notifyWrite(cwd: string): void {
	for (const listener of writeListeners) {
		try {
			listener(cwd);
		} catch {
			/* 观察者自身的异常不影响命令结果 */
		}
	}
}

/**
 * 通知一次仓库写入事件。
 *
 * 供以 {@link GitOptions.quietWrite} 执行、事后才确认确有改动的命令补发。
 *
 * @param repo - 仓库路径。
 * @returns 无。
 */
export function notifyRepositoryWrite(repo: string): void {
	notifyWrite(repo);
}

/**
 * 运行一次 git。
 *
 * 子进程无法启动（git 不在 PATH、工作目录不存在）时不抛错，而是以退出码 -1 与
 * stderr 为异常文本返回，使调用方的错误处理与 git 自身失败走同一条路径。
 *
 * 同一仓库上参数完全相同的并发调用共享一个子进程；只读命令另有短时结果缓存。
 * 不设超时：git 自身在远端不可达或凭据缺失时会结束进程，钩子是仓库自身的脚本。
 *
 * @param args - 参数数组，按原样传给 git（不经过 shell）。
 * @param cwd - 工作目录，必须是仓库或其子目录。
 * @param options - 见 {@link GitOptions}；省略时只读命令走缓存。
 * @returns 退出码与输出。
 */
export async function runGit(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<GitResult> {
	const readOnly = isReadOnly(args);
	const repo = normalizeRepo(cwd);
	// 参数用 JSON 序列化：join(' ') 会让 ['a b'] 与 ['a','b'] 撞成同一个键。
	const key = `${repo}\u0000${JSON.stringify(args)}`;
	// 输出随工作区或索引当前内容变化的只读命令不进缓存。
	const cacheable = readOnly && !dependsOnWorktree(args) && options.noCache !== true;

	if (cacheable) {
		const cached = resultCache.get(key);
		if (cached !== undefined && cached.expiresAt > Date.now()) return cached.result;
	}
	/*
	 * 只读命令共享在途子进程，与结果缓存解耦：`status`、`diff`、`ls-files` 的输出随工作区与索引
	 * 当前内容变化，因此不进结果缓存，但仍可复用正在跑的那个进程。客户端中止后重发、刷新与只取
	 * 快照并发时因此只跑一次 git。写命令一律独立执行。
	 */
	if (readOnly) {
		const pending = inFlightGit.get(key);
		if (pending !== undefined) return pending;
	}

	// 只记录不阻断：并发限制会把正常的多仓库刷新串行化，稀疏化靠刷新侧的门控与冷却。
	checkCallRate(args);
	const operation = startOperation(repo, kindOf(args));
	const task = (async (): Promise<GitResult> => {
		try {
			return await spawnGit(args, cwd, repo);
		} finally {
			endOperation(repo, operation);
		}
	})();

	// 写操作先失效该仓库的只读缓存：否则「写 → 立刻读」的序列会命中写前缓存。
	// 所有 git 调用都经这里，因此无需在二十余处写操作里各自挂失效。
	if (!readOnly) invalidateRepo(repo);

	if (readOnly) inFlightGit.set(key, task);
	try {
		const result = await task;
		/*
		 * 只读命令按调试、写命令按信息、失败按警告记一条。
		 *
		 * 查询型只读命令的非零退出是正常答案（例如 `config --get` 未配置、`rev-parse --verify`
		 * 目标不存在），不记警告，否则日志里全是「失败」而看不出真正的错误。
		 */
		if (result.code !== 0 && readOnly && isProbeCommand(args)) {
			logDebug('git', `只读查询无结果（退出码 ${String(result.code)}）：git ${describeGitArgs(args)}，仓库 ${repo}`);
		} else if (result.code !== 0) {
			// stderr 为空时不拼换行：否则会多出一条只有前缀的空记录。
			const detail = result.stderr.trim().slice(0, MAX_GIT_LOG_CHARS);
			logWarn('git', `git 命令失败（退出码 ${String(result.code)}）：git ${describeGitArgs(args)}，仓库 ${repo}${detail === '' ? '' : `\n${detail}`}`);
		} else if (readOnly) {
			logDebug('git', `执行只读 git 命令：git ${describeGitArgs(args)}，仓库 ${repo}`);
		} else {
			logInfo('git', `执行写操作 git 命令：git ${describeGitArgs(args)}，仓库 ${repo}`);
		}
		// 只有成功且只读才缓存：失败结果缓存会让瞬时错误固化 200ms。
		// 跳过缓存的调用不写入，也不取用：它读的是当前值，入缓存会把该值再固化 200ms。
		if (cacheable && result.code === 0) setCachedResult(key, result);
		// 写命令跑完即通知：非零退出也可能是冲突合并这类已改动仓库的情形。
		// 负退出码表示子进程未能启动，仓库没有被改动，不通知。
		if (!readOnly && result.code >= 0 && options.quietWrite !== true) notifyWrite(cwd);
		return result;
	} finally {
		if (readOnly) inFlightGit.delete(key);
	}
}

/** 值属于自由文本的参数名：日志里屏蔽其取值，避免把提交信息等写进日志。 */
const MASKED_VALUE_ARGS: ReadonlySet<string> = new Set(['-m', '--message', '--body', '-b', '--author', '--committer', '--grep', '-S', '-G']);

/**
 * git 参数的可读描述，屏蔽自由文本取值。
 *
 * @param args - 参数数组。
 * @returns 描述文本。
 */
export function describeGitArgs(args: readonly string[]): string {
	const parts: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const masked = MASKED_VALUE_ARGS.has(arg);
		parts.push(masked || MASKED_VALUE_ARGS.has(arg.split('=')[0]) ? `${arg.split('=')[0]}=<已屏蔽>` : arg);
		if (masked && index + 1 < args.length) { index += 1; }
	}
	return parts.join(' ');
}

/**
 * 查询型只读命令：非零退出表示「没有这个值」，不是错误。
 *
 * 覆盖 `config --get`、`rev-parse --verify`、`symbolic-ref`、`show-ref --quiet` 与
 * `check-ref-format` 这类用法 —— 它们的失败是调用方的正常分支之一。
 *
 * @param args - 完整参数数组。
 * @returns 属于查询型命令时为 true。
 */
export function isProbeCommand(args: readonly string[]): boolean {
	const command = args[0];
	const flags = args.slice(1);
	const quiet = flags.includes('--quiet') || flags.includes('-q');
	if (command === 'config') return flags.includes('--get');
	if (command === 'rev-parse') return flags.includes('--verify');
	if (command === 'symbolic-ref' || command === 'check-ref-format') return true;
	if (command === 'show-ref') return quiet;
	return false;
}

/** 各仓库已启动的 git 子进程数；供耗时汇总按仓库统计一轮刷新起了几个子进程。 */
const gitSpawnsByRepo = new Map<string, number>();

/**
 * 取一个仓库已启动的 git 子进程数。
 *
 * 按仓库分别计数：并发轮次各按自己的起点算差值，共用一个全局计数会把别的轮次的子进程算进来。
 *
 * @param repo - 仓库路径。
 * @returns 该仓库自进程启动以来的子进程数。
 */
export function gitSpawnCount(repo: string): number {
	return gitSpawnsByRepo.get(normalizeRepo(repo)) ?? 0;
}

/**
 * 启动一个 git 子进程。
 *
 * @param args - 参数数组。
 * @param cwd - 工作目录。
 * @param repo - 规范化后的仓库路径，用于计数。
 * @returns 子进程结果。
 */
function spawnGit(args: readonly string[], cwd: string, repo: string): Promise<GitResult> {
	gitSpawnsByRepo.set(repo, (gitSpawnsByRepo.get(repo) ?? 0) + 1);
	return collectProcess({
		command: 'git',
		args,
		cwd,
		env: gitEnvironment(isReadOnly(args)),
		onChild: (child) => { liveChildren.add(child); },
		onSettled: (child) => { liveChildren.delete(child); },
	});
}

/**
 * 运行一次 git，非零退出码时抛出携带 stderr 的错误。
 *
 * @param args - 参数数组。
 * @param cwd - 工作目录。
 * @returns 标准输出。
 */
export async function gitOrThrow(args: readonly string[], cwd: string): Promise<string> {
	const result = await runGit(args, cwd);
	if (result.code !== 0) {
		// 走查错误信息，git 的失败原因在 stderr；为空时退回 stdout。
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0] ?? ''} 执行失败`);
	}
	return result.stdout;
}

/**
 * 按字符预算切分路径参数。
 *
 * Windows 单个命令行上限 32767 字符，超出时 spawn 直接以 ENAMETOOLONG 失败；路径还要
 * 计入引号与分隔符，因此取上限的一半作预算。
 */
const PATH_BATCH_CHARS = 16000;

/**
 * 按字符预算切分路径参数。
 *
 * @param paths - 要传给 git 的路径。
 * @returns 逐批的路径；空输入时为空数组。
 */
export function pathBatches(paths: readonly string[]): string[][] {
	const batches: string[][] = [];
	let current: string[] = [];
	let size = 0;
	for (const path of paths) {
		// 每个参数按「内容 + 引号 + 分隔符」估算。
		const cost = path.length + 3;
		if (current.length > 0 && size + cost > PATH_BATCH_CHARS) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(path);
		size += cost;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/**
 * 分批执行一条带路径参数的 git 命令，逐批串行。
 *
 * @param repo - 仓库路径。
 * @param argsOf - 由一批路径构造完整参数数组。
 * @param paths - 要传给 git 的路径。
 * @returns 各批标准输出拼接。
 */
export async function gitInPathBatches(
	repo: string,
	argsOf: (batch: readonly string[]) => string[],
	paths: readonly string[],
): Promise<string> {
	let output = '';
	for (const batch of pathBatches(paths)) output += await gitOrThrow(argsOf(batch), repo);
	return output;
}
