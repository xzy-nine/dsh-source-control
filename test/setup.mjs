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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 隔离目录名前缀。 */
const PREFIX = 'dsh-source-control-test-';

// 先清掉上一次运行留下的隔离目录。
try {
	for (const name of readdirSync(tmpdir())) {
		if (name.startsWith(PREFIX)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
	}
} catch {
	/* 清理失败不影响测试本身 */
}

/** 本进程的隔离根。 */
const home = mkdtempSync(join(tmpdir(), PREFIX));

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
