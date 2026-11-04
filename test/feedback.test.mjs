/**
 * 反馈：正文拼装、标题前缀、日志打包与 issue 地址解析。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FEEDBACK_REPO, FEEDBACK_TEXT, FEEDBACK_TYPES, buildIssueBody, feedbackIssueTitle,
} from '../lib/src/source-control/feedback-text.js';
import { archiveFileName, archiveLog } from '../lib/src/source-control/log-archive.js';

/* 本文件的用例必须串行执行：用例改动 process.env 与真实 tar/zip 调用 */

/** 正文拼装的最小事实。 */
const facts = {
	type: 'bug', description: '点开差异页就空白', pluginVersion: '0.8.0',
	platform: 'win32 10.0 x64', node: 'v24.0.0',
	logFile: '20260102-090000-redacted.zip',
	redaction: '令牌 ×1', exemptionCount: 0,
};

test('标题带类型前缀', () => {
	assert.equal(feedbackIssueTitle('bug', '差异页空白'), `${FEEDBACK_TYPES.bug.prefix} 差异页空白`);
	assert.equal(feedbackIssueTitle('suggestion', '  加个快捷键  '), `${FEEDBACK_TYPES.suggestion.prefix} 加个快捷键`);
});

test('正文含描述、环境、日志与脱敏四段', () => {
	const body = buildIssueBody(facts);
	assert.ok(body.includes('点开差异页就空白'));
	assert.ok(body.includes('0.8.0'));
	assert.ok(body.includes('win32 10.0 x64'));
	assert.ok(body.includes('20260102-090000-redacted.zip'));
	assert.ok(body.includes('令牌 ×1'));
});

test('日志段落写明手动上传步骤', () => {
	const body = buildIssueBody(facts);
	// 断言段落由上传步骤那段文案构成：被守护的是「日志段写明了怎么上传」，不是措辞。
	assert.ok(body.includes(FEEDBACK_TEXT.uploadStep));
	assert.ok(body.includes(FEEDBACK_TEXT.localPathNote));
});

test('未附带日志时正文写明未附带', () => {
	const body = buildIssueBody({ ...facts, logFile: null, redaction: '' });
	assert.ok(body.includes(FEEDBACK_TEXT.noLog));
	assert.ok(body.includes(FEEDBACK_TEXT.noRedaction));
});

test('反馈目标为本插件仓库', () => {
	assert.equal(FEEDBACK_REPO, 'xzy-nine/dsh-source-control');
});

/** 本文件创建的临时目录；文件级 after 统一删除。 */
const temps = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** 建一个临时目录并登记清理。 */
function makeHome() {
	const home = mkdtempSync(join(tmpdir(), 'dsh-archive-'));
	temps.push(home);
	return home;
}

/** 本进程启动时 setup.mjs 注入的隔离根；用例结束时还原回它。 */
const ISOLATED_HOME = process.env.DSH_SOURCE_CONTROL_HOME;

test('日志打包：tar 可用时给出 zip，文件名可读', async () => {
	const home = makeHome();
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
	const home = makeHome();
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
		// 还原隔离根，避免影响后续用例。
		if (ISOLATED_HOME === undefined) delete process.env.DSH_SOURCE_CONTROL_HOME;
		else process.env.DSH_SOURCE_CONTROL_HOME = ISOLATED_HOME;
	}
});
