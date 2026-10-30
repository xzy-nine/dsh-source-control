/**
 * 日志落盘实机契约：日志写进按日命名的文件夹，文件名按启动先后排列，
 * 每次启动新起一个文件；内容为 logcat 格式且每行带时间戳。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** logcat threadtime 的一行。 */
const LOGCAT_LINE = /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+ [VDIWE] [^:]+: .*$/;

/**
 * 每个用例用独立 home，避免互相看见对方的日志。
 *
 * `initLog` 只打开文件并清理，不写任何内容：文件由第一条真实日志创建。
 */
async function freshLogger() {
	const home = mkdtempSync(join(tmpdir(), 'dsh-log-'));
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
