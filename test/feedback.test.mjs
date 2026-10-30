/**
 * 反馈：正文拼装、标题前缀、日志打包与 issue 地址解析。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FEEDBACK_REPO, FEEDBACK_TYPES, buildIssueBody, feedbackIssueTitle, formatBytes,
} from '../lib/src/source-control/feedback-text.js';
import { archiveFileName, archiveLog } from '../lib/src/source-control/log-archive.js';

/** 正文拼装的最小事实。 */
const facts = {
	type: 'bug', description: '点开差异页就空白', pluginVersion: '0.8.0',
	platform: 'win32 10.0 x64', node: 'v24.0.0',
	logFile: '20260102-090000-redacted.zip', logSize: 320 * 1024,
	redaction: '令牌 ×1', exemptionCount: 0,
};

test('标题带类型前缀', () => {
	assert.equal(feedbackIssueTitle('bug', '差异页空白'), `${FEEDBACK_TYPES.bug.prefix} 差异页空白`);
	assert.equal(feedbackIssueTitle('suggestion', '  加个快捷键  '), '[建议] 加个快捷键');
});

test('正文含描述、环境、日志与脱敏四段', () => {
	const body = buildIssueBody(facts);
	assert.ok(body.includes('点开差异页就空白'));
	assert.ok(body.includes('0.8.0'));
	assert.ok(body.includes('win32 10.0 x64'));
	assert.ok(body.includes('20260102-090000-redacted.zip'));
	assert.ok(body.includes('320.0 KB'));
	assert.ok(body.includes('令牌 ×1'));
});

test('日志段落写明手动上传步骤', () => {
	const body = buildIssueBody(facts);
	assert.ok(body.includes('拖到本条 issue 的评论框上传'));
	assert.ok(body.includes('不接受日志等文本类型'));
});

test('未附带日志时正文写明未附带', () => {
	const body = buildIssueBody({ ...facts, logFile: null, logSize: null, redaction: '' });
	assert.ok(body.includes('未附带日志'));
	assert.ok(body.includes('未触发脱敏替换'));
});

test('反馈目标为本插件仓库', () => {
	assert.equal(FEEDBACK_REPO, 'xzy-nine/dsh-source-control');
});

test('字节数换算', () => {
	assert.equal(formatBytes(512), '512 B');
	assert.equal(formatBytes(2048), '2.0 KB');
	assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('日志打包：tar 可用时给出 zip，文件名可读', async () => {
	const home = mkdtempSync(join(tmpdir(), 'dsh-archive-'));
	process.env.DSH_SOURCE_CONTROL_HOME = home;
	const { resetLogStateForTests } = await import('../lib/src/source-control/logger.js');
	resetLogStateForTests();
	const packed = await archiveLog('20260102-090000.log', '10-30 09:00:00.000  1  0 I t: hi\n');
	assert.ok(existsSync(packed.path), '压缩包应已写出');
	assert.match(archiveFileName(packed.path), /\.(zip|log)$/);
	if (packed.compressed) {
		assert.match(packed.path, /\.zip$/);
		assert.ok(packed.size > 0);
	}
});

test('tar 不可用时退回未压缩副本', async () => {
	const home = mkdtempSync(join(tmpdir(), 'dsh-archive-'));
	process.env.DSH_SOURCE_CONTROL_HOME = home;
	const { resetLogStateForTests } = await import('../lib/src/source-control/logger.js');
	resetLogStateForTests();
	const original = process.env.PATH;
	process.env.PATH = '';
	try {
		const packed = await archiveLog('a.log', 'hello\n');
		assert.equal(packed.compressed, false);
		assert.match(packed.path, /\.log$/);
		assert.equal(readFileSync(packed.path, 'utf8'), 'hello\n');
	} finally {
		process.env.PATH = original;
	}
	// 还原 home，避免影响后续用例。
	delete process.env.DSH_SOURCE_CONTROL_HOME;
});
