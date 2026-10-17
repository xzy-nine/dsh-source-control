/**
 * DSH 版源代码管理的 git 执行层：在指定仓库中以数组参数跑 git，无 shell。
 *
 * 工作区变更（状态、暂存、提交、工作树）在此实现；提交图查询与各类操作见
 * `git-query.ts` 与 `git-actions.ts`，两者共用这里的执行与错误处理。
 */
import { spawn } from 'node:child_process';
import { collectProcess } from './child-process.js';
import { resolveGitCommonDir } from './worktree-branches.js';

/**
 * 工作区变更的解析上限。
 *
 * 超大仓库（几十万未跟踪文件）的 status 输出会让解析本身成为负担，截断即可 —— 面板本就
 * 无法展示这么多条目。取值与 VSCode 的 `git.statusLimit` 一致。
 */
const STATUS_LIMIT = 10000;

/** 一次 git 调用的结果。 */
export interface GitResult {
	/** 退出码；被信号终止时为 -1。 */
	readonly code: number;
	/** 标准输出（按 UTF-8 解码）。 */
	readonly stdout: string;
	/** 标准错误（按 UTF-8 解码）。 */
	readonly stderr: string;
}

/** 仓库尚无提交时 `git restore --staged` 的报错；git 会给出带引号的 HEAD。 */
const NO_HEAD_PATTERN = /could not resolve ['"]?HEAD['"]?|unknown revision|ambiguous argument ['"]?HEAD['"]?/i;

/**
 * 子进程环境：在父进程环境上禁用凭据交互与分页。
 *
 * `GIT_TERMINAL_PROMPT=0` 让缺凭据的远程操作直接失败，而不是挂在等待输入上；
 * `GIT_PAGER` 兜住 git 误判为交互终端的场合。
 *
 * @returns 传给子进程的环境变量。
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
	return {
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
}

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
/**
 * 本地只读查询的超时上限。
 *
 * 单条 status 在本机约 80ms，但大仓库、冷启动、杀毒软件实时扫描下会明显变慢；
 * 这里的取值只用于兜住「永久挂住」，不用于限制正常慢查询。
 */
const GIT_TIMEOUT_LOCAL_MS = 30000;

/**
 * 远程操作的超时上限。
 *
 * fetch/push/pull 受网络与凭据影响，按本地查询的 10s 会误杀正常操作，因此单独放宽；
 * 但仍必须有上限，否则卡住的远程操作会永久占住子进程。
 */
const GIT_TIMEOUT_REMOTE_MS = 120000;

/** 一定访问远端的子命令。 */
const NETWORK_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'clone', 'ls-remote']);

/**
 * 判断一条命令是否会访问远端（网络与凭据都可能让它长时间等待）。
 *
 * 不能只看子命令名：`git remote`（列远程）、`git remote add/set-url`（改配置）都是纯本地，
 * 只有 `remote prune/update` 才联网；`git submodule` 单独用是本地，带 update 才联网。
 *
 * @param args - 完整参数数组。
 * @returns 需要长超时时为 true。
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
function normalizeRepo(cwd: string): string {
	return cwd.replace(/[\\/]+$/, '').toLowerCase();
}

/** 一条在跑的子进程：截止时刻、子命令名与超时后的收尾回调。 */
interface LiveChild {
	deadline: number;
	readonly label: string;
	/** 超时后调用：终止进程树并让调用方拿到失败结果，不依赖 close 事件。 */
	readonly onTimeout: () => void;
}

/**
 * 已启动且未结束的子进程；宿主退出时逐个终止，避免留下孤儿 git.exe。
 *
 * 值里带截止时刻，超时由一个共享的看护定时器统一检查：每个子进程各挂一个 setTimeout 时，
 * 定时器数量会随并发数增长（100 个在跑就有 100 个待触发的定时器）。
 */
const liveChildren = new Map<ReturnType<typeof spawn>, LiveChild>();

/** 超时看护定时器；有在跑的子进程时才会存在。 */
let watchdog: ReturnType<typeof setInterval> | null = null;

/** 看护检查间隔。 */
const WATCHDOG_INTERVAL_MS = 1000;

/**
 * 检查是否有子进程超过截止时刻，超时就整树终止。
 *
 * @returns 无。
 */
function sweepTimeouts(): void {
	if (liveChildren.size === 0) {
		if (watchdog !== null) { clearInterval(watchdog); watchdog = null; }
		return;
	}
	const now = Date.now();
	for (const [child, info] of liveChildren) {
		if (now < info.deadline) continue;
		// 标记为已超时，避免下一轮重复触发。
		info.deadline = Number.POSITIVE_INFINITY;
		killTree(child);
		info.onTimeout();
	}
}

/**
 * 按需启动看护定时器。
 *
 * @returns 无。
 */
function ensureWatchdog(): void {
	if (watchdog !== null || liveChildren.size === 0) return;
	watchdog = setInterval(sweepTimeouts, WATCHDOG_INTERVAL_MS);
	// 看护本身不应阻止宿主退出。
	if (typeof watchdog.unref === 'function') watchdog.unref();
}

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
	for (const child of liveChildren.keys()) killTree(child);
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
 * 写操作通过 {@link isIdle} 参与刷新门控 —— 写操作未完成时，由文件变更触发的刷新会等待。
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
 * 等到没有写操作在跑。
 *
 * @param repo - 限定仓库；省略时等待所有仓库。
 * @param signal - 取消信号。
 * @returns 无。
 */
export async function whenGitIdle(repo?: string, signal?: AbortSignal): Promise<void> {
	while (!isGitIdle(repo)) {
		if (signal?.aborted === true) return;
		await new Promise<void>((resolve) => {
			const notify = (): void => { idleListeners.delete(notify); resolve(); };
			idleListeners.add(notify);
		});
	}
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
	console.warn(`[source-control] git 调用过于频繁（${recent.length} 次/秒）：git ${args.join(' ')} ← ${caller}`);
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
 * 只读查询结果缓存时长。
 *
 * 面板在编辑期间会按节拍反复读同一份不变的数据；一次 git 约 70–90ms，若调用间隔大于
 * 执行时间，在途复用命不中，缓存按节拍命中即可避免整轮重复起进程。
 */
const CACHE_TTL_MS = 200;

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
 * 清掉某个仓库的只读缓存。
 *
 * @param repo - 规范化后的仓库路径。
 * @returns 无。
 */
function invalidateRepo(repo: string): void {
	const prefix = repo + '\u0000';
	for (const key of resultCache.keys()) {
		if (key.startsWith(prefix)) resultCache.delete(key);
	}
}

/** 进行中的调用：键为仓库与参数的组合，值共享同一个子进程。 */
const inFlightGit = new Map<string, Promise<GitResult>>();

/**
 * 仓库写操作的观察者：参数为仓库路径（调用方给出的原样写法）。
 *
 * 面板订阅它来即时反映别的会话、别的工作区或外部进程对同一仓库的改动 —— 那些改动不产生
 * 当前会话的事件，事件驱动的刷新看不到。只在**写操作成功**后通知，且通知不携带任何数据，
 * 由接收方自行重读。
 */
const writeListeners = new Set<(repo: string) => void>();

/**
 * 订阅仓库写操作。
 *
 * @param listener - 写操作成功时调用。
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
 * 运行一次 git。
 *
 * 子进程无法启动（git 不在 PATH、工作目录不存在）时不抛错，而是以退出码 -1 与
 * stderr 为异常文本返回，使调用方的错误处理与 git 自身失败走同一条路径。
 *
 * 同一仓库上参数完全相同的并发调用共享一个子进程；只读命令另有短时结果缓存。
 * 并发受全局与单仓库两层闸门限制，超时按子命令分流。
 *
 * @param args - 参数数组，按原样传给 git（不经过 shell）。
 * @param cwd - 工作目录，必须是仓库或其子目录。
 * @returns 退出码与输出。
 */
export async function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
	const readOnly = isReadOnly(args);
	const repo = normalizeRepo(cwd);
	// 参数用 JSON 序列化：join(' ') 会让 ['a b'] 与 ['a','b'] 撞成同一个键。
	const key = `${repo}\u0000${JSON.stringify(args)}`;

	if (readOnly) {
		const cached = resultCache.get(key);
		if (cached !== undefined && cached.expiresAt > Date.now()) return cached.result;
		const pendingCached = inFlightGit.get(key);
		if (pendingCached !== undefined) return pendingCached;
	}

	// 只记录不阻断：并发限制会把正常的多仓库刷新串行化，稀疏化靠刷新侧的门控与冷却。
	checkCallRate(args);
	const operation = startOperation(repo, kindOf(args));
	const task = (async (): Promise<GitResult> => {
		try {
			return await spawnGit(args, cwd);
		} finally {
			endOperation(repo, operation);
		}
	})();

	// 写操作先失效该仓库的只读缓存：否则「写 → 立刻读」的序列会命中写前缓存。
	// 所有 git 调用都经这里，因此无需在二十余处写操作里各自挂失效。
	if (!readOnly) invalidateRepo(repo);

	inFlightGit.set(key, task);
	try {
		const result = await task;
		// 只有成功且只读才缓存：失败结果缓存会让瞬时错误固化 200ms。
		if (readOnly && result.code === 0) setCachedResult(key, result);
		// 写操作成功后才通知：失败的写没有改动仓库，通知只会让面板白读一次。
		if (!readOnly && result.code === 0) notifyWrite(cwd);
		return result;
	} finally {
		inFlightGit.delete(key);
	}
}

function spawnGit(args: readonly string[], cwd: string): Promise<GitResult> {
	// 只有联网命令需要放宽超时；本地查询在正常机器上远快于上限。
	const deadline = Date.now() + (isNetworkCommand(args) ? GIT_TIMEOUT_REMOTE_MS : GIT_TIMEOUT_LOCAL_MS);
	return collectProcess({
		command: 'git',
		args,
		cwd,
		env: gitEnvironment(),
		onChild: (child, finish, partial) => {
			// 超时由看护统一触发；收尾不依赖 close，避免 kill 不掉时调用方永久挂起。
			liveChildren.set(child, {
				deadline,
				label: args[0] ?? '',
				onTimeout: () => {
					const { stdout, stderr } = partial();
					finish({ code: -1, stdout, stderr: stderr !== '' ? stderr : `git ${args[0] ?? ''} 超时未结束` });
				},
			});
			ensureWatchdog();
		},
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

/**
 * 读取仓库的工作区变更。
 *
 * @param repo - 仓库路径。
 * @returns 变更列表，按路径排序。
 */
export async function loadWorkingTree(repo: string): Promise<WorkingTreeEntry[]> {
	const stdout = await gitOrThrow(['status', '--porcelain', '-z', '--untracked-files=all'], repo);
	return parseStatus(stdout).sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 暂存指定路径；不传路径时暂存全部变更。
 *
 * @param repo - 仓库路径。
 * @param paths - 要暂存的路径。
 * @returns 无。
 */
export function stagePaths(repo: string, paths: readonly string[]): Promise<string> {
	return paths.length === 0
		? gitOrThrow(['add', '--all'], repo)
		: gitOrThrow(['add', '--', ...paths], repo);
}

/**
 * 取消暂存指定路径；不传路径时取消全部。
 *
 * `git restore` 没有 `--all` 选项，取消全部用 pathspec `.`。
 * 仓库尚无提交（没有 HEAD）时 `restore --staged` 需要 HEAD 才能工作，退回从索引移除。
 *
 * @param repo - 仓库路径。
 * @param paths - 要取消暂存的路径。
 * @returns 无。
 */
export async function unstagePaths(repo: string, paths: readonly string[]): Promise<string> {
	// 空数组表示全部：restore 与 rm 都用 `.` 这个 pathspec。
	const target = paths.length === 0 ? ['.'] : [...paths];
	try {
		return await gitOrThrow(['restore', '--staged', '--', ...target], repo);
	} catch (error) {
		// 走查错误信息：仅当仓库没有 HEAD 时才退回 rm --cached，其余失败原样抛出。
		// git 的实际措辞带引号（could not resolve 'HEAD'），正则因此不能写死无引号形式。
		const message = error instanceof Error ? error.message : String(error);
		if (!NO_HEAD_PATTERN.test(message)) throw error;
		return gitOrThrow(['rm', '--cached', '-r', '--quiet', '--', ...target], repo);
	}
}

/**
 * 提交暂存区内容。
 *
 * @param repo - 仓库路径。
 * @param message - 提交信息。
 * @param amend - 是否修补上一次提交。
 * @returns 新提交的完整哈希。
 */
export async function commitStaged(repo: string, message: string, amend: boolean): Promise<string> {
	const args = ['commit', '-m', message];
	if (amend) args.push('--amend');
	await gitOrThrow(args, repo);
	return (await gitOrThrow(['rev-parse', 'HEAD'], repo)).trim();
}

/**
 * 丢弃指定路径的工作区改动。
 *
 * 未跟踪文件用 `git clean` 删除，已跟踪文件用 `git restore` 还原到 HEAD。
 *
 * @param repo - 仓库路径。
 * @param paths - 要丢弃的路径。
 * @param untracked - 这些路径是否都是未跟踪文件。
 * @returns 无。
 */
export async function discardPaths(repo: string, paths: readonly string[], untracked: boolean): Promise<string> {
	if (untracked) return gitOrThrow(['clean', '-f', '--', ...paths], repo);
	return gitOrThrow(['restore', '--', ...paths], repo);
}

/**
 * 移除一个链接工作树。
 *
 * 主工作树不能被移除（git 报 `is a main working tree`）。工作树内有未提交改动时 git 会
 * 拒绝并要求 `--force`；目录已不存在时 git 会直接清理登记项，因此两种情况都不需要重试。
 *
 * git 子进程的工作目录不能落在被移除的工作树里：Windows 上该目录正被占用，删除会
 * `Permission denied`；工作目录本身也可能在移除后不存在，导致后续命令 `spawn git ENOENT`。
 * 因此从 `repo` 所在的工作树之外执行，拿不到仓库根时退回仓库自身的 git 公共目录。
 *
 * @param repo - 仓库路径（任意工作树均可）。
 * @param worktreePath - 要移除的工作树路径。
 * @param force - 是否强制移除有改动的工作树。
 * @returns 无。
 */
export async function removeWorktree(repo: string, worktreePath: string, force: boolean): Promise<void> {
	const args = force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath];
	await gitOrThrow(args, await removalCwd(repo));
}

/**
 * 取移除工作树时 git 的工作目录。
 *
 * 用仓库的 git 公共目录：它不在任何工作树内，因此既不会因待移除的工作树正被占用而
 * 删除失败，也不会在移除后消失。定位不到时退回调用方给出的路径。
 *
 * @param repo - 调用方给出的仓库路径。
 * @returns 可用的工作目录。
 */
async function removalCwd(repo: string): Promise<string> {
	return await resolveGitCommonDir(repo) ?? repo;
}
