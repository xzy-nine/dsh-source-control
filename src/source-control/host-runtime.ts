/**
 * 宿主能力面：子进程、文件系统读取与目录监视。
 *
 * 三项能力都走宿主 seam（`ctx.subprocess` / `ctx.fs`）：子进程进受管范围，读取与监视尊重
 * 后端的执行世界与沙箱。宿主未装载对应服务时插件无法工作，装载期即报错，不做原生回退——
 * 回退会绕开受管范围与沙箱，让「哪一半在用」取决于部署，两条路径都可能单独坏掉。
 *
 * 不覆盖插件自身的持久化与日志：那些写在插件数据目录下，位于沙箱可写根之外，走 seam 会被
 * `FS_SANDBOX_DENIED` 拒绝，因此仍用 `node:fs`。
 */
import { logDebug } from './logger.js';

/** 子进程收集输出的默认内存上限（字节）；超出时按 seam 约定保留尾部并标记截断。 */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** 终止受管进程范围前留给它的宽限毫秒数。 */
const TERMINATE_GRACE_MS = 3000;

/** 文件系统目标的最小面：身份不透明，只用 `displayPath` 展示。 */
export interface FsTargetLike {
	readonly targetKey: unknown;
	readonly displayPath: string;
}

/** 目录项的最小面。 */
export interface FsEntryLike {
	readonly name: string;
	readonly type: string;
	readonly target: FsTargetLike;
}

/** 一次 `stat` 的结果：类型、体积与不透明的新鲜度令牌。 */
export interface FsInfoLike {
	readonly type: string;
	readonly size?: number | undefined;
	/** 后端给出的新鲜度令牌；内容或元数据变化时改变。 */
	readonly version?: unknown;
}

/** `ctx.fs` 的最小面：本插件用到的读取与监视操作。 */
export interface FsLike {
	resolve(path: string, opts?: { cwd?: string }): Promise<FsTargetLike>;
	stat(target: FsTargetLike): Promise<FsInfoLike | undefined>;
	readText(target: FsTargetLike): Promise<string>;
	listDir(target: FsTargetLike): Promise<readonly FsEntryLike[]>;
	watch(target: FsTargetLike, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>;
}

/** `ctx.subprocess` 的最小面：本插件用到的 spawn 与收集读取。 */
export interface SubprocessLike {
	spawn(spec: {
		readonly argv: readonly string[];
		readonly cwd: string;
		readonly stdio: {
			readonly stdin: 'ignore' | 'pipe' | { readonly data: string };
			readonly stdout: unknown;
			readonly stderr: unknown;
		};
		readonly graceMs: number;
		readonly signal?: AbortSignal | undefined;
		readonly env?: NodeJS.ProcessEnv | undefined;
	}): {
		readonly collected: {
			readonly stdout?: { readFrom(fromByte: number): { readonly text: string; readonly lossy: boolean } };
			readonly stderr?: { readFrom(fromByte: number): { readonly text: string; readonly lossy: boolean } };
		};
		readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
		terminate(): void;
	};
}

/** 一次收集式调用的结果。 */
export interface CollectResult {
	/** 退出码；子进程无法启动、超时或被截断时为 -1。 */
	readonly code: number;
	/** 标准输出（按 UTF-8 解码）。 */
	readonly stdout: string;
	/** 标准错误（按 UTF-8 解码）。 */
	readonly stderr: string;
}

/** 已装载的宿主能力。 */
let installedFs: FsLike | undefined;
let installedSubprocess: SubprocessLike | undefined;

/** 在跑的受管子进程；宿主退出时逐个终止。 */
const liveHandles = new Set<{ terminate(): void }>();

/**
 * 登记宿主能力。
 *
 * 服务缺失时抛错：插件没有原生回退，缺一项就无法读取仓库或运行 git，早失败比晚失败好定位。
 *
 * @param read - 按服务名取宿主服务。
 * @returns 无。
 */
export function installHostCapabilities(read: (name: string) => unknown): void {
	const fs = read('fs') as FsLike | undefined;
	if (typeof fs?.resolve !== 'function' || typeof fs.watch !== 'function') {
		throw new Error('source-control 需要 ctx.fs：文件读取与目录监视都经它进行，没有原生回退');
	}
	const subprocess = read('subprocess') as SubprocessLike | undefined;
	if (typeof subprocess?.spawn !== 'function') {
		throw new Error('source-control 需要 ctx.subprocess：git 与 gh 都在受管进程范围里运行，没有原生回退');
	}
	installedFs = fs;
	installedSubprocess = subprocess;
	logDebug('runtime', '宿主能力：ctx.fs 与 ctx.subprocess 均已装载');
}

/** 清掉已装载的能力；测试用。 */
export function resetHostCapabilities(): void {
	installedFs = undefined;
	installedSubprocess = undefined;
}

/**
 * 取 `ctx.fs`；未装载时抛错。
 *
 * @returns 文件系统服务。
 */
function requireFs(): FsLike {
	if (installedFs === undefined) throw new Error('ctx.fs 未装载：installHostCapabilities 尚未执行');
	return installedFs;
}

/**
 * 取 `ctx.subprocess`；未装载时抛错。
 *
 * @returns 子进程服务。
 */
function requireSubprocess(): SubprocessLike {
	if (installedSubprocess === undefined) throw new Error('ctx.subprocess 未装载：installHostCapabilities 尚未执行');
	return installedSubprocess;
}

/** 一次收集式调用的参数。 */
export interface CollectSpec {
	/** 可执行文件名。 */
	readonly command: string;
	/** 参数数组，按原样传给子进程。 */
	readonly args: readonly string[];
	/** 工作目录；省略时用宿主进程工作目录。 */
	readonly cwd?: string | undefined;
	/** 子进程环境变量；省略时继承父进程。 */
	readonly env?: NodeJS.ProcessEnv | undefined;
	/** 超时毫秒数；省略时不设超时。 */
	readonly timeoutMs?: number | undefined;
	/** 超时时的错误文本。 */
	readonly timeoutMessage?: string | undefined;
	/** 送进标准输入的内容；省略时关闭标准输入。 */
	readonly input?: string | undefined;
}

/**
 * 终止全部在跑的受管子进程。
 *
 * @returns 无。
 */
export function terminateAllChildren(): void {
	for (const handle of liveHandles) {
		try {
			handle.terminate();
		} catch {
			/* 进程已退出 */
		}
	}
	liveHandles.clear();
}

/**
 * 运行一次子进程并收集输出。
 *
 * 走受管范围：终止按整棵树生效，输出按 seam 的上限收集并在截断时报告。子进程无法启动、
 * 超时、输出被截断与提供方失败都收敛成退出码 -1，调用方的失败处理与 git 自身失败走同一条路径。
 *
 * @param spec - 见 {@link CollectSpec}。
 * @returns 退出码与输出。
 */
export async function runCollect(spec: CollectSpec): Promise<CollectResult> {
	const subprocess = requireSubprocess();
	const collect = (): { maxBytes: number } => ({ maxBytes: DEFAULT_MAX_OUTPUT_BYTES });
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	/* 超时后由中止信号结束受管范围；结果按 seam 的退出事实给出，文案在下面按中止原因替换。 */
	const timeout = { fired: false };
	if (spec.timeoutMs !== undefined) {
		timer = setTimeout(() => {
			timeout.fired = true;
			controller.abort();
		}, spec.timeoutMs);
	}
	let handle: ReturnType<SubprocessLike['spawn']>;
	try {
		handle = subprocess.spawn({
			argv: [spec.command, ...spec.args],
			cwd: spec.cwd ?? process.cwd(),
			stdio: {
				stdin: spec.input === undefined ? 'ignore' : { data: spec.input },
				stdout: collect(),
				stderr: collect(),
			},
			graceMs: TERMINATE_GRACE_MS,
			signal: controller.signal,
			env: spec.env,
		});
	} catch (error) {
		if (timer !== undefined) clearTimeout(timer);
		const message = error instanceof Error ? error.message : String(error);
		return { code: -1, stdout: '', stderr: message };
	}
	liveHandles.add(handle);
	try {
		const outcome = await handle.done;
		const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false };
		const stderr = handle.collected.stderr?.readFrom(0) ?? { text: '', lossy: false };
		if (timeout.fired) {
			return {
				code: -1, stdout: stdout.text,
				stderr: stderr.text !== '' ? stderr.text : (spec.timeoutMessage ?? `${spec.command} 超时未结束`),
			};
		}
		// 输出被截断时按失败处理：git 的解析需要完整输出，截断的尾部会给出错误的提交图。
		if (stdout.lossy || stderr.lossy) {
			return {
				code: -1, stdout: stdout.text,
				stderr: `${spec.command} 输出超过 ${String(DEFAULT_MAX_OUTPUT_BYTES)} 字节上限，结果不可用`,
			};
		}
		return { code: outcome.exitCode ?? -1, stdout: stdout.text, stderr: stderr.text };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { code: -1, stdout: '', stderr: message };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		liveHandles.delete(handle);
	}
}

/* 宿主退出时收尾：受管范围由 seam 终止。 */
process.once('exit', terminateAllChildren);

/** 一个路径的探测结果。 */
export type PathKind = 'file' | 'directory' | 'other';

/**
 * 读一个文件的全部文本。
 *
 * @param path - 绝对路径。
 * @returns 文件文本。
 */
export async function readTextAt(path: string): Promise<string> {
	const fs = requireFs();
	return fs.readText(await fs.resolve(path));
}

/**
 * 探测一个路径的类型。
 *
 * @param path - 绝对路径。
 * @returns 类型；路径不存在或不可读时为 null。
 */
export async function probePathAt(path: string): Promise<PathKind | null> {
	const fs = requireFs();
	try {
		const info = await fs.stat(await fs.resolve(path));
		return info === undefined ? null : (info.type as PathKind);
	} catch {
		return null;
	}
}

/**
 * 取一个路径的元数据。
 *
 * @param path - 绝对路径。
 * @returns 类型、体积与新鲜度令牌；路径不存在时为 undefined。
 */
export async function statAt(path: string): Promise<FsInfoLike | undefined> {
	const fs = requireFs();
	return fs.stat(await fs.resolve(path));
}

/**
 * 列出一个目录的直接子项。
 *
 * @param path - 绝对路径。
 * @returns 子项名称与类型；目录不可读时抛错，由调用方决定降级。
 */
export async function listDirAt(path: string): Promise<readonly { readonly name: string; readonly type: string }[]> {
	const fs = requireFs();
	const entries = await fs.listDir(await fs.resolve(path));
	return entries.map((entry) => ({ name: entry.name, type: entry.type }));
}

/**
 * 一次目录变化回调。
 *
 * @param error - 监视句柄的错误。
 * @param name - 变化的文件名；seam 的监视不提供名字时为 null。
 * @param kind - 事件类型；seam 的监视不提供类型时为 null。
 */
export type DirChangeListener = (error?: Error, name?: string | null, kind?: string | null) => void;

/**
 * 观察一个目录的变化。
 *
 * `ctx.fs.watch` 只观察该目录的直接子项、回调只给错误，名字与类型因此为 null。需要第二层的
 * 调用方自己按层挂句柄，并按「名字未知」核对结构状态后决定是否通知。
 *
 * @param path - 绝对路径。
 * @param changed - 变化回调。
 * @param signal - 取消监视。
 * @returns 关闭监视的函数。
 */
export async function watchDirAt(
	path: string, changed: DirChangeListener, signal: AbortSignal,
): Promise<() => Promise<void>> {
	const fs = requireFs();
	return fs.watch(await fs.resolve(path), (error) => { changed(error, null, null); }, signal);
}
