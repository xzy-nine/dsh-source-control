/**
 * 文本日志：logcat 格式（每行带时间戳）、目录与文件命名、按启动先后排序、
 * 按体积淘汰与按天保留的判据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLogLines, formatLogTimestamp } from '../lib/src/source-control/log-format.js';

/** logcat threadtime 的一行：`MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message`。 */
const LOGCAT_LINE = /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+ [VDIWE] [^:]+: .*$/;

test('每条记录以 logcat 时间戳开头', () => {
	const time = new Date(2026, 9, 30, 9, 5, 7, 42);
	assert.equal(formatLogTimestamp(time), '10-30 09:05:07.042');
	const lines = formatLogLines({ time, pid: 1234, tid: 0, level: 'I', tag: 'source-control', message: 'hello' });
	assert.equal(lines.length, 1);
	assert.match(lines[0], LOGCAT_LINE);
	assert.equal(lines[0], '10-30 09:05:07.042  1234     0 I source-control: hello');
});

test('多行消息逐行带时间戳', () => {
	const time = new Date(2026, 0, 2, 3, 4, 5, 6);
	const lines = formatLogLines({ time, pid: 1, tid: 2, level: 'E', tag: 't', message: 'a\nb\nc' });
	assert.equal(lines.length, 3);
	for (const line of lines) assert.match(line, LOGCAT_LINE);
	assert.ok(lines.every((line) => line.startsWith('01-02 03:04:05.006')));
});
