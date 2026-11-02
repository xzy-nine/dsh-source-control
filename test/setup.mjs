/**
 * 测试进程的隔离根：插件状态与日志一律落在临时目录，不碰用户真实的 `~/.dsh`。
 *
 * 由 `node --test --import ./test/setup.mjs` 在每个测试进程启动时先执行一次（早于任何
 * 被测模块导入，因此模块级缓存拿到的是隔离路径）。
 *
 * 退出钩子按注册顺序执行、先注册先跑，而这里是最先加载的模块：直接注册清理会排到所有
 * 后续钩子之前，被测代码的收尾钩子（日志落盘、perf 汇总）随后又把文件写回来。因此本模块
 * 接管 `process.on('exit')` 的登记，把各模块的钩子收集起来，在最后统一先跑它们、再删目录。
 *
 * 启动时另清一遍上次运行留下的隔离目录，兜住没跑成退出钩子的进程（被强制结束时不会跑）。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 隔离目录名前缀。 */
const PREFIX = 'dsh-source-control-test-';

/** 存活判定文件：记下创建它的进程号。 */
const OWNER = '.owner';

/** 无主目录的保留时限；超出即视为上次运行的残留。 */
const STALE_MS = 6 * 60 * 60 * 1000;

/**
 * 判断一个残留隔离目录是否仍有进程在使用。
 *
 * 并行跑测试时每个文件一个进程，各自建自己的隔离根；按前缀无条件删会把兄弟进程正在用的
 * 目录一并删掉。因此只回收「属主进程已不在」的目录：有属主且仍存活就跳过，无属主时按
 * 修改时间兜底。进程号被复用只会让目录多留一会儿，不会误删别人在用的目录。
 *
 * @param dir - 待判定的隔离目录绝对路径。
 * @returns 可以回收时为 true。
 */
function isReclaimable(dir) {
	try {
		const owner = Number.parseInt(readFileSync(join(dir, OWNER), 'utf8'), 10);
		if (Number.isInteger(owner) && owner > 0) {
			try {
				process.kill(owner, 0);
				return false;
			} catch {
				return true;
			}
		}
	} catch {
		/* 无属主文件：按修改时间兜底 */
	}
	try {
		return Date.now() - statSync(dir).mtimeMs > STALE_MS;
	} catch {
		return false;
	}
}

// 先清掉上一次运行留下、且属主已不在的隔离目录。
try {
	for (const name of readdirSync(tmpdir())) {
		if (!name.startsWith(PREFIX)) continue;
		const dir = join(tmpdir(), name);
		if (isReclaimable(dir)) rmSync(dir, { recursive: true, force: true });
	}
} catch {
	/* 清理失败不影响测试本身 */
}

/** 本进程的隔离根。 */
const home = mkdtempSync(join(tmpdir(), PREFIX));

// 写下属主，供后续运行的进程判断本目录仍在使用中。
try {
	writeFileSync(join(home, OWNER), String(process.pid));
} catch {
	/* 属主文件写失败只影响下次回收时机，不影响隔离本身 */
}

process.env.DSH_SOURCE_CONTROL_HOME = home;

/* ── 接管退出钩子，保证清理排在最后 ───────────────────────── */

/** 收集到的退出钩子，按登记顺序执行。 */
const exitHooks = [];
const realOn = process.on.bind(process);
const realOnce = process.once.bind(process);

/**
 * 登记一个退出钩子；其余事件原样交给 process。
 *
 * @param event - 事件名。
 * @param listener - 回调。
 * @returns process 本身，与原生 API 一致。
 */
function intercept(event, listener) {
	if (event === 'exit') {
		exitHooks.push(listener);
		return process;
	}
	return realOn(event, listener);
}

process.on = intercept;
process.once = intercept;

realOn('exit', () => {
	for (const hook of exitHooks) {
		try {
			hook();
		} catch {
			/* 单个钩子失败不影响后续清理 */
		}
	}
	try {
		rmSync(home, { recursive: true, force: true });
	} catch {
		/* 清理失败不影响测试结论 */
	}
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 初始化日志模块，让它把收尾钩子登记进上面收集的列表。
try {
	const logger = await import(pathToFileURL(join(root, 'lib', 'src', 'source-control', 'logger.js')).href);
	logger.initLog();
} catch {
	// 产物尚未构建时（例如只跑单个客户端测试）没有日志模块可初始化，不影响隔离本身。
}
