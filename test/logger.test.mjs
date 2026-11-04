/**
 * 日志落盘实机契约：日志写进按日命名的文件夹，文件名按启动先后排列，
 * 每次启动新起一个文件；内容为 logcat 格式且每行带时间戳。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/* 本文件的用例必须串行执行：用例逐个改动 process.env 并真实落盘 */

/** 本进程启动时 setup.mjs 注入的隔离根；文件结束时还原回它。 */
const ISOLATED_HOME = process.env.DSH_SOURCE_CONTROL_HOME;

/** 本文件创建的临时 home；文件级 after 统一删除。 */
const homes = [];
test.after(async () => {
	/*
	 * 先重置日志状态再删目录：日志模块在进程退出时会 flush，而 flush 会按记录的文件路径
	 * 重建目录——顺序反过来会把刚删掉的目录又建出来。
	 */
	const module = await import('../lib/src/source-control/logger.js');
	module.resetLogStateForTests();
	for (const home of homes) rmSync(home, { recursive: true, force: true });
	if (ISOLATED_HOME === undefined) delete process.env.DSH_SOURCE_CONTROL_HOME;
	else process.env.DSH_SOURCE_CONTROL_HOME = ISOLATED_HOME;
});

/** logcat threadtime 的一行。 */
const LOGCAT_LINE = /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+ [VDIWE] [^:]+: .*$/;

/**
 * 每个用例用独立 home，避免互相看见对方的日志。
 *
 * `initLog` 只打开文件并清理，不写任何内容：文件由第一条真实日志创建。
 */
async function freshLogger() {
	const home = mkdtempSync(join(tmpdir(), 'dsh-log-'));
	homes.push(home);
	process.env.DSH_SOURCE_CONTROL_HOME = home;
	const module = await import('../lib/src/source-control/logger.js');
	module.resetLogStateForTests();
	module.initLog();
	return { home, module };
}

test('日志写入按日命名的文件夹，文件名为启动时刻', async () => {
	const { home, module } = await freshLogger();
	module.logInfo('test', 'first line');
	module.flushSync();
	const file = module.currentLogFile();
	assert.ok(file !== null && existsSync(file), '日志文件应已创建');
	// 目录：<home>/logs/<YYYY-MM-DD>/
	const day = file.slice(join(home, 'logs').length + 1).split(/[\\/]/)[0];
	assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
	const name = file.slice(file.lastIndexOf(file.includes('\\') ? '\\' : '/') + 1);
	// `YYYYMMDD-HHmmss.log`：按名称字典序即启动先后。
	assert.match(name, /^\d{8}-\d{6}\.log$/);
	const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
	assert.ok(lines.length >= 1, '应有本次写入');
	for (const line of lines) assert.match(line, LOGCAT_LINE);
	assert.ok(lines.some((line) => line.includes('first line')));
});

test('文件名按启动时刻命名，同一文件内的记录按写入顺序追加', async () => {
	const { home, module } = await freshLogger();
	module.logInfo('test', 'a');
	module.flushSync();
	const dir = dirname(module.currentLogFile());
	assert.equal(dirname(dir), join(home, 'logs'));
	assert.ok(existsSync(dir));
	const first = module.currentLogFile();
	// 重新初始化只重算文件名：同一秒内命中同一个文件，写入是追加而不是覆盖。
	module.resetLogStateForTests();
	const second = module.initLog();
	module.logInfo('test', 'b');
	module.flushSync();
	assert.notEqual(second, '');
	const files = readdirSync(dir).filter((name) => name.endsWith('.log'));
	assert.equal(files.length, 1, '同一秒内的启动共用一份文件');
	assert.equal(second, first);
	const text = readFileSync(second, 'utf8');
	assert.ok(text.includes('a') && text.includes('b'), '两次写入都保留');
	assert.ok(text.indexOf('a') < text.indexOf('b'), '按写入顺序追加');
});

test('清理会删除超出保留期的日文件夹', async () => {
	const { home, module } = await freshLogger();
	const stale = new Date();
	stale.setDate(stale.getDate() - 60);
	const day = `${String(stale.getFullYear())}-${String(stale.getMonth() + 1).padStart(2, '0')}-${String(stale.getDate()).padStart(2, '0')}`;
	const staleDir = join(home, 'logs', day);
	mkdirSync(staleDir, { recursive: true });
	writeFileSync(join(staleDir, '20200101-000000.log'), 'x', 'utf8');
	module.cleanLogs(new Date());
	assert.equal(existsSync(staleDir), false, '过期日文件夹应被删除');
});

test('启动清理清空反馈暂存目录，日志母本保留', async () => {
	const { home, module } = await freshLogger();
	module.logInfo('test', 'mother');
	module.flushSync();
	const mother = module.currentLogFile();
	const outbox = join(home, 'logs', 'outbox');
	// 上次会话留下的三类取用物：压缩包、未压缩副本、issue 正文草稿。
	mkdirSync(outbox, { recursive: true });
	writeFileSync(join(outbox, '20261104-143111-redacted.zip'), 'zip', 'utf8');
	writeFileSync(join(outbox, '20261104-143111-redacted.log'), 'plain', 'utf8');
	writeFileSync(join(outbox, 'issue-body-1762300000000.md'), '# body', 'utf8');
	module.cleanLogs(new Date());
	assert.deepEqual(readdirSync(outbox), [], '暂存目录应被清空');
	assert.ok(existsSync(mother), '日志母本不受清理影响');
	assert.ok(readFileSync(mother, 'utf8').includes('mother'), '母本内容保留');
});

test('会话内打包不会删掉上一次的压缩包', async () => {
	const { home, module } = await freshLogger();
	const { archiveLog } = await import('../lib/src/source-control/log-archive.js');
	const first = await archiveLog('20260101-000000.log', 'first\n');
	assert.ok(existsSync(first.path), '压缩包应已写出');
	// 同一次运行里再提交一条反馈：上一次的包仍在，用户可能还没把它拖进 issue 评论框。
	const second = await archiveLog('20260102-000000.log', 'second\n');
	assert.ok(existsSync(second.path));
	assert.ok(existsSync(first.path), '上一次的压缩包应保留到下次启动');
	assert.ok(existsSync(join(home, 'logs', 'outbox')));
});

test('日文件夹超限时清理最旧的文件', async () => {
	const { home, module } = await freshLogger();
	module.logInfo('test', 'current');
	module.flushSync();
	const dir = dirname(module.currentLogFile());
	const latest = module.currentLogFile().slice(module.currentLogFile().lastIndexOf(module.currentLogFile().includes('\\') ? '\\' : '/') + 1);
	// 造两份更旧的、共 16MB 的文件，超上限后最旧的先被删。
	writeFileSync(join(dir, '20000101-000000.log'), Buffer.alloc(9 * 1024 * 1024));
	writeFileSync(join(dir, '20000101-010000.log'), Buffer.alloc(9 * 1024 * 1024));
	module.cleanLogs(new Date());
	assert.equal(existsSync(join(dir, '20000101-000000.log')), false, '最旧的一份应被淘汰');
	assert.equal(existsSync(join(dir, '20000101-010000.log')), true, '较新的一份保留');
	assert.equal(existsSync(join(dir, latest)), true, '正在写入的文件不受影响');
	assert.ok(existsSync(join(home, 'logs')));
});
