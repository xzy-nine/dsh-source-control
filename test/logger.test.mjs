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

/** 每个用例用独立 home，避免互相看见对方的日志。 */
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
	assert.match(name, /^logcat-\d{8}-\d{9}-\d+\.log$/);
	const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
	assert.ok(lines.length >= 2, '应包含初始化行与本次写入');
	for (const line of lines) assert.match(line, LOGCAT_LINE);
	assert.ok(lines.some((line) => line.includes('first line')));
});

test('每次启动新起一个文件，文件名升序即启动先后', async () => {
	const { home, module } = await freshLogger();
	module.logInfo('test', 'a');
	module.flushSync();
	const dir = dirname(module.currentLogFile());
	assert.equal(dirname(dir), join(home, 'logs'));
	assert.ok(existsSync(dir));
	module.resetLogStateForTests();
	const second = module.initLog();
	module.flushSync();
	assert.notEqual(second, '');
	const files = readdirSync(dir).filter((name) => name.endsWith('.log'));
	assert.equal(files.length, 2, '每次启动一个新文件');
	const sorted = [...files].sort();
	assert.deepEqual(files.sort(), sorted);
});

test('清理会删除超出保留期的日文件夹', async () => {
	const { home, module } = await freshLogger();
	module.flushSync();
	const stale = new Date();
	stale.setDate(stale.getDate() - 60);
	const day = `${String(stale.getFullYear())}-${String(stale.getMonth() + 1).padStart(2, '0')}-${String(stale.getDate()).padStart(2, '0')}`;
	const staleDir = join(home, 'logs', day);
	mkdirSync(staleDir, { recursive: true });
	writeFileSync(join(staleDir, 'logcat-old.log'), 'x', 'utf8');
	module.cleanLogs(new Date());
	assert.equal(existsSync(staleDir), false, '过期日文件夹应被删除');
});

test('日文件夹超限时清理最旧的文件', async () => {
	const { home, module } = await freshLogger();
	module.flushSync();
	const dir = dirname(module.currentLogFile());
	const latest = module.currentLogFile().slice(module.currentLogFile().lastIndexOf(module.currentLogFile().includes('\\') ? '\\' : '/') + 1);
	// 造两份更旧的、共 16MB 的文件，超上限后最旧的先被删。
	writeFileSync(join(dir, 'logcat-20000101-000000000-1.log'), Buffer.alloc(9 * 1024 * 1024));
	writeFileSync(join(dir, 'logcat-20000101-010000000-2.log'), Buffer.alloc(9 * 1024 * 1024));
	module.cleanLogs(new Date());
	assert.equal(existsSync(join(dir, 'logcat-20000101-000000000-1.log')), false, '最旧的一份应被淘汰');
	assert.equal(existsSync(join(dir, 'logcat-20000101-010000000-2.log')), true, '较新的一份保留');
	assert.equal(existsSync(join(dir, latest)), true, '正在写入的文件不受影响');
	assert.ok(existsSync(join(home, 'logs')));
});
