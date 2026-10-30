/**
 * 日志目录与保留判据：日文件夹命名、文件排序与启动先后一致、
 * 日文件夹体积淘汰顺序、按天过期。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	dayFolderName, isDayFolderName, logFileName, orderLogFiles, planDayEvictions, planExpiredDayFolders,
	DAY_FOLDER_LIMIT_BYTES, LOG_RETENTION_DAYS,
} from '../lib/src/source-control/log-retention.js';

test('日文件夹按本地日期命名', () => {
	assert.equal(dayFolderName(new Date(2026, 0, 2, 23, 59, 59)), '2026-01-02');
	assert.equal(dayFolderName(new Date(2026, 11, 31, 0, 0, 0)), '2026-12-31');
	assert.equal(isDayFolderName('2026-01-02'), true);
	assert.equal(isDayFolderName('outbox'), false);
	assert.equal(isDayFolderName('2026-1-2'), false);
});

test('文件名按启动时刻排序即启动先后', () => {
	const early = logFileName(new Date(2026, 0, 2, 9, 0, 0, 0), 100);
	const later = logFileName(new Date(2026, 0, 2, 9, 0, 0, 1), 200);
	assert.equal(early, 'logcat-20260102-090000000-100.log');
	assert.equal(later, 'logcat-20260102-090000001-200.log');
	assert.ok(early < later);
	const ordered = orderLogFiles([{ name: later }, { name: early }]).map((file) => file.name);
	assert.deepEqual(ordered, [early, later]);
});

test('日文件夹超限时按启动先后淘汰最旧的', () => {
	const files = [
		{ name: 'logcat-20260102-090000000-1.log', size: 6 },
		{ name: 'logcat-20260102-100000000-2.log', size: 6 },
		{ name: 'logcat-20260102-110000000-3.log', size: 6 },
	];
	// 上限 12：最新的两份留下，最旧的一份淘汰。
	assert.deepEqual(planDayEvictions(files, 12, []), [files[0].name]);
	// 上限足够时一份也不删。
	assert.deepEqual(planDayEvictions(files, 100, []), []);
});

test('正在写入的文件不参与累计也不被淘汰', () => {
	const current = 'logcat-20260102-090000000-1.log';
	const files = [
		{ name: current, size: 100 },
		{ name: 'logcat-20260102-100000000-2.log', size: 6 },
	];
	// 当前文件 100 字节超过上限，但它正在写：只按另一份计算。
	assert.deepEqual(planDayEvictions(files, 12, [current]), []);
});

test('保留期为 15 天，当天算第一天', () => {
	assert.equal(LOG_RETENTION_DAYS, 15);
	assert.equal(DAY_FOLDER_LIMIT_BYTES, 15 * 1024 * 1024);
	const now = new Date(2026, 0, 20, 12, 0, 0);
	const names = ['2026-01-20', '2026-01-06', '2026-01-05', '2025-12-31', 'outbox'];
	// 第 15 天是 01-06，早于它（01-05 及之前）的文件夹整体删除。
	assert.deepEqual(planExpiredDayFolders(names, now), ['2026-01-05', '2025-12-31']);
});
