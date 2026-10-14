/**
 * 文件改动事件判据的测试：已落地的写入/编辑、仓库内判定、刷新冷却与定时参数收拢。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	AUTO_REFRESH_COOLDOWN_MS, CLEANUP_INTERVAL_MS, FALLBACK_POLL_INTERVAL_MS,
	autoFetchPeriodMs, hasRepositoryChange, isAutoRefreshDue, isCacheExpired, repositoryRelativePath, settledFileChanges,
	shouldFallbackRefresh,
} from '../src/client/panel/change-events.ts';

/** 一次工具调用事件。 */
const call = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } });

/** 一次工具结果事件。 */
const result = (callId, isError = false) => ({
	type: 'tool/result',
	data: { message: { source: { callId }, isError } },
});

test('拿到结果且非错误的写入才算落地', () => {
	const events = [call('a', 'write', { file_path: 'src/a.ts' }), result('a')];
	assert.deepEqual(settledFileChanges(events), [{ callId: 'a', kind: 'write', path: 'src/a.ts' }]);
});

test('未结算的调用不算落地', () => {
	assert.deepEqual(settledFileChanges([call('a', 'edit', { file_path: 'src/a.ts' })]), []);
});

test('结果报错的调用不算落地', () => {
	const events = [call('a', 'edit', { file_path: 'src/a.ts' }), result('a', true)];
	assert.deepEqual(settledFileChanges(events), []);
});

test('与文件无关的工具不参与判定', () => {
	const events = [call('a', 'bash', { command: 'ls' }), result('a')];
	assert.deepEqual(settledFileChanges(events), []);
});

test('run_code 内嵌套的写入按派发事件判定', () => {
	const events = [
		{ type: 'tool/ptc-dispatch-start', data: { subCallId: 'root:ptc:1', name: 'write', arguments: { file_path: 'src/b.ts' } } },
		{ type: 'tool/ptc-dispatch', data: { subCallId: 'root:ptc:1', isError: false } },
	];
	assert.deepEqual(settledFileChanges(events), [{ callId: 'root:ptc:1', kind: 'write', path: 'src/b.ts' }]);
});

test('嵌套写入失败同样不算落地', () => {
	const events = [
		{ type: 'tool/ptc-dispatch-start', data: { subCallId: 'root:ptc:1', name: 'edit', arguments: { file_path: 'src/b.ts' } } },
		{ type: 'tool/ptc-dispatch', data: { subCallId: 'root:ptc:1', isError: true } },
	];
	assert.deepEqual(settledFileChanges(events), []);
});

test('相对路径按会话工作区解析，落在仓库内时给出仓库相对路径', () => {
	assert.equal(repositoryRelativePath('C:\\repo', 'C:\\repo\\sub', 'src/a.ts'), 'sub/src/a.ts');
});

test('仓库之外的路径不算仓库内改动', () => {
	assert.equal(repositoryRelativePath('C:\\repo', 'C:\\tmp', 'a.ts'), null);
});

test('绝对路径按仓库根判断，越界的上级目录被拒绝', () => {
	assert.equal(repositoryRelativePath('C:\\repo', null, 'C:\\other\\a.ts'), null);
	assert.equal(repositoryRelativePath('C:\\repo', null, 'C:\\repo/src/a.ts'), 'src/a.ts');
});

test('仓库根下的相对路径直接给出，仓库外路径不触发', () => {
	assert.equal(repositoryRelativePath('C:\\repo', 'C:\\repo', 'a.ts'), 'a.ts');
	assert.equal(hasRepositoryChange([{ callId: 'a', kind: 'write', path: 'C:\\tmp\\a.ts' }], 'C:\\repo', 'C:\\repo'), false);
	assert.equal(hasRepositoryChange([{ callId: 'a', kind: 'write', path: 'a.ts' }], 'C:\\repo', 'C:\\repo'), true);
});

test('冷却时间未满时不刷新，满后放行', () => {
	assert.equal(isAutoRefreshDue(0, AUTO_REFRESH_COOLDOWN_MS), true);
	assert.equal(isAutoRefreshDue(1, AUTO_REFRESH_COOLDOWN_MS), false);
	assert.equal(isAutoRefreshDue(0, 0), false);
});

test('抓取间隔收拢到区间内，非有限数用默认值', () => {
	assert.equal(autoFetchPeriodMs(180), 180000);
	assert.equal(autoFetchPeriodMs(1), 10000);
	assert.equal(autoFetchPeriodMs(999999), 3600000);
	assert.equal(autoFetchPeriodMs(Number.NaN), 180000);
});

test('缓存未到清理周期时保留，到达后过期', () => {
	assert.equal(isCacheExpired(0, CLEANUP_INTERVAL_MS - 1), false);
	assert.equal(isCacheExpired(0, CLEANUP_INTERVAL_MS), true);
});

test('兜底轮询间隔明显低于事件响应节拍', () => {
	assert.ok(FALLBACK_POLL_INTERVAL_MS >= AUTO_REFRESH_COOLDOWN_MS * 10);
});

test('兜底轮询首次读取不重载', () => {
	assert.equal(shouldFallbackRefresh('a', '', 'b', 1), false);
});

test('兜底轮询在签名仍在变化时不重载', () => {
	assert.equal(shouldFallbackRefresh('b', 'a', 'c', 1), false);
});

test('兜底轮询连续两次读到同一签名才重载', () => {
	assert.equal(shouldFallbackRefresh('a', 'a', 'b', 1), false);
	assert.equal(shouldFallbackRefresh('a', 'a', 'b', 2), true);
});

test('兜底轮询在签名与已加载一致时不重载', () => {
	assert.equal(shouldFallbackRefresh('a', 'a', 'a', 5), false);
});
