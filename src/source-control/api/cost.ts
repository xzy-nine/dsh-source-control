/**
 * 刷新耗时汇总：单条命令不记日志，按「一次刷新」把耗时与 git 子进程数汇总成一行。
 *
 * 这是「显示到界面」之外唯一需要的性能观测点：一次刷新会打十几次命令，逐条记既淹没日志，
 * 又看不出那一次刷新到底花了多少。
 *
 * 分组按客户端随请求带来的 `refreshId`：同一轮刷新的命令归到一组，轮次边界由客户端决定。
 * 没有 `refreshId` 的命令（抓取这类由用户操作直接触发的、或旧版客户端）按仓库与时间窗口归组。
 */
import { flushSync, logInfo } from '../logger.js';
import { gitSpawnCount } from '../git-exec.js';

/** 无轮次编号时一轮的合并窗口（毫秒）。 */
const COST_WINDOW_MS = 3000;

/** 退出时冲刷的已登记标志。 */
let exitFlushRegistered = false;

/** 一轮刷新内的累计。 */
interface CostBucket {
	/** 本轮的标识，仅用于日志展示。 */
	readonly label: string;
	/** 本轮所属仓库；git 子进程计数按它取。 */
	readonly repo: string;
	/** 本轮第一条命令的开始时刻。 */
	firstStartedAt: number;
	/** 本轮最后一条命令的结束时刻；墙钟由它与 firstStartedAt 相减得到。 */
	lastEndedAt: number;
	/** 本轮开始时的 git 子进程计数。 */
	spawnsAtStart: number;
	/** 各命令的执行次数。 */
	readonly counts: Map<string, number>;
	/** 各命令累计耗时（毫秒）。 */
	readonly msByCommand: Map<string, number>;
	/** 各命令命中缓存的次数（耗时 0 ms 且不是首次）。 */
	readonly cachedCounts: Map<string, number>;
	/** 最慢的一条命令与其耗时。 */
	slowest: { command: string; ms: number } | null;
	/** 本轮累计耗时（毫秒）。 */
	totalMs: number;
}

/** 在跑的轮次：键为仓库 + 轮次编号（无编号时用 `*`）。 */
const costBuckets = new Map<string, CostBucket>();

/** 各轮次的归组键 → 超时冲刷定时器。 */
const costTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 输出一轮的汇总。
 *
 * @param key - 归组键。
 * @returns 无。
 */
function flushCostBucket(key: string): void {
	const timer = costTimers.get(key);
	if (timer !== undefined) {
		clearTimeout(timer);
		costTimers.delete(key);
	}
	const current = costBuckets.get(key);
	if (current === undefined) return;
	costBuckets.delete(key);
	const breakdown = [...current.counts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.map(([name, count]) => {
			const cached = current.cachedCounts.get(name) ?? 0;
			const suffix = cached === 0 ? '' : cached === count ? '（全部命中缓存）' : `（${String(cached)} 次命中缓存）`;
			return `${name}×${String(count)}=${String(current.msByCommand.get(name) ?? 0)}ms${suffix}`;
		})
		.join('、');
	const slowest = current.slowest === null ? '' : `，最慢 ${current.slowest.command} ${String(current.slowest.ms)} ms`;
	/*
	 * 墙钟取「首条命令开始 → 末条命令结束」，不是「归组开启至今」：命令之间的空闲不算用户等待。
	 *
	 * 命令是并行发出的，各条耗时之和会大于墙钟，因此两个数都给：墙钟是用户感知，
	 * 命令之和是工作量。git 子进程数是这套取数的主要成本来源（一次约 80ms 固定开销）。
	 */
	const wall = Math.max(0, current.lastEndedAt - current.firstStartedAt);
	// 按仓库计数：并发轮次各自算差值，共用全局计数会把别的轮次的子进程算进来。
	const spawns = gitSpawnCount(current.repo) - current.spawnsAtStart;
	logInfo('perf', `${current.label}墙钟 ${String(wall)} ms，命令耗时合计 ${String(current.totalMs)} ms，git 子进程 ${String(spawns)} 个，共 ${String(current.counts.size)} 种命令${slowest}：${breakdown}`);
}

/**
 * 输出全部在跑的轮次并复位。
 *
 * @returns 无。
 */
function flushCommandCost(): void {
	for (const key of [...costBuckets.keys()]) flushCostBucket(key);
}

/**
 * 记一条命令的耗时；轮次结束时输出一行汇总。
 *
 * @param command - 命令名。
 * @param ms - 本次耗时（毫秒）。
 * @param repo - 仓库路径。
 * @param refreshId - 客户端给出的轮次编号；未给出时为 null。
 * @returns 无。
 */
function recordCommandCost(command: string, ms: number, repo: string, refreshId: number | null): void {
	if (command === '' || command === 'logEvent') return;
	if (!exitFlushRegistered) {
		exitFlushRegistered = true;
		/*
		 * 定时器 unref 过：进程退出时靠这里把最后一轮写出去。
		 *
		 * 退出钩子按注册顺序执行，而日志模块自己的收尾钩子在插件装载时就已注册、会先跑；
		 * 因此这里写完必须自己再 flush 一次，否则刚写进缓冲的行赶不上落盘。
		 */
		process.once('exit', () => {
			flushCommandCost();
			flushSync();
		});
	}
	const repoLabel = repo === '' ? '（未指定仓库）' : repo;
	const key = `${repo.toLowerCase()}\u0000${refreshId === null ? '*' : String(refreshId)}`;
	/*
	 * 同一仓库出现新的轮次编号时，说明上一轮已经打完：先把它写出去，不再等定时器。
	 * 定时器只兜「客户端不再发新轮次」的情形（例如窗口被关掉）。
	 */
	for (const existing of [...costBuckets.keys()]) {
		if (existing === key) continue;
		if (!existing.startsWith(`${repo.toLowerCase()}\u0000`)) continue;
		flushCostBucket(existing);
	}
	const now = Date.now();
	let current = costBuckets.get(key);
	if (current === undefined) {
		current = {
			label: refreshId === null ? `一轮刷新（${repoLabel}）` : `第 ${String(refreshId)} 轮刷新（${repoLabel}）`,
			repo, firstStartedAt: now - ms, lastEndedAt: now, spawnsAtStart: gitSpawnCount(repo),
			counts: new Map(), msByCommand: new Map(), cachedCounts: new Map(), slowest: null, totalMs: 0,
		};
		costBuckets.set(key, current);
	}
	current.lastEndedAt = now;
	current.counts.set(command, (current.counts.get(command) ?? 0) + 1);
	current.msByCommand.set(command, (current.msByCommand.get(command) ?? 0) + ms);
	current.totalMs += ms;
	// 0 ms 的命令即命中了缓存：单独计数，否则无法判断缓存是否生效。
	if (ms === 0) current.cachedCounts.set(command, (current.cachedCounts.get(command) ?? 0) + 1);
	if (current.slowest === null || ms > current.slowest.ms) current.slowest = { command, ms };
	// 每一轮都重新计时：轮次内的命令可能间隔很久（用户在等某个慢操作）。
	const existTimer = costTimers.get(key);
	if (existTimer !== undefined) clearTimeout(existTimer);
	const timer = setTimeout(() => {
		costTimers.delete(key);
		flushCostBucket(key);
	}, COST_WINDOW_MS);
	if (typeof timer.unref === 'function') timer.unref();
	costTimers.set(key, timer);
}

export { recordCommandCost };