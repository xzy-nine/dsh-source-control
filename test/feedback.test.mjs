/**
 * 反馈：正文拼装、标题前缀与日志评论的合并规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	FEEDBACK_REPO, FEEDBACK_TEXT, FEEDBACK_TYPES, buildIssueBody, feedbackIssueTitle,
} from '../lib/src/source-control/feedback-text.js';
import { LOG_COMMENT_TEXT, groupLogComments } from '../lib/src/source-control/feedback-comment.js';

/** 正文拼装的最小事实。 */
const facts = {
	type: 'bug', description: '点开差异页就空白', pluginVersion: '0.8.0',
	platform: 'win32 10.0 x64', node: 'v24.0.0',
	logFiles: ['20260102-090000.log'], logCommentCount: 1,
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
	assert.ok(body.includes('20260102-090000.log'));
	assert.ok(body.includes('令牌 ×1'));
});

test('日志段落写明全文在评论里', () => {
	const body = buildIssueBody(facts);
	// 断言段落由那两段文案构成：被守护的是「正文指向评论」，不是措辞。
	assert.ok(body.includes(FEEDBACK_TEXT.logOne.replace('{file}', '20260102-090000.log')));
	assert.ok(body.includes(FEEDBACK_TEXT.logComments.replace('{n}', '1')));
});

test('多份日志在正文里逐一列出', () => {
	const body = buildIssueBody({ ...facts, logFiles: ['a.log', 'b.log'], logCommentCount: 2 });
	assert.ok(body.includes(FEEDBACK_TEXT.logMany.replace('{files}', 'a.log、b.log')));
});

test('未附带日志时正文写明未附带', () => {
	const body = buildIssueBody({ ...facts, logFiles: [], logCommentCount: 0, redaction: '' });
	assert.ok(body.includes(FEEDBACK_TEXT.noLog));
	assert.ok(body.includes(FEEDBACK_TEXT.noRedaction));
});

test('反馈目标为本插件仓库', () => {
	assert.equal(FEEDBACK_REPO, 'xzy-nine/dsh-source-control');
});

/**
 * 造一份近似给定字符数的日志：每行 100 字符。
 *
 * 行内带上文件名，各份内容因此互不相同，用例才能按「整份出现几次」判断有没有被切开。
 */
function logOf(chars, name) {
	const rows = Math.max(1, Math.floor(chars / 100));
	const filler = 'x'.repeat(Math.max(0, 99 - name.length));
	return { name, text: Array.from({ length: rows }, () => `${name}${filler}`).join('\n') };
}

test('装得下的多份日志合进一条评论', () => {
	const budget = 3000;
	const sources = [logOf(800, 'a.log'), logOf(800, 'b.log')];
	const comments = groupLogComments(sources, budget);
	assert.equal(comments.length, 1, '两份合得下应只发一条');
	assert.deepEqual(comments[0].files, ['a.log', 'b.log']);
	assert.ok(comments[0].body.includes(LOG_COMMENT_TEXT.multiHeading.replace('{names}', 'a.log、b.log')));
	assert.ok(comments[0].body.includes('<details>') && comments[0].body.includes('</details>'));
	// 摘要必须包在 <summary> 里：裸文本会摊在折叠标题外，折叠结构也就失效了。
	assert.ok(comments[0].body.includes('<summary>') && comments[0].body.includes('</summary>'));
});

test('第 n+1 份装不下时另起一条，且不切分任何一份', () => {
	const budget = 3000;
	const sources = [logOf(1200, 'a.log'), logOf(1200, 'b.log'), logOf(1200, 'c.log')];
	const comments = groupLogComments(sources, budget);
	assert.ok(comments.length >= 2, '装不下时要另起一条');
	// 每份日志的正文完整落且只落在一个评论里，绝不跨条。
	for (const source of sources) {
		const holders = comments.filter((comment) => comment.body.includes(source.text.trimEnd()));
		assert.equal(holders.length, 1, `${source.name} 应整份落在一条评论里`);
	}
	for (const comment of comments) assert.ok(comment.body.length <= budget, '正文不得超过上限');
});

test('单份日志本身超限时独占一条并标注截断', () => {
	const budget = 2000;
	const big = logOf(6000, 'huge.log');
	const comments = groupLogComments([big, logOf(300, 'small.log')], budget, { 'huge.log': 'C:/logs/huge.log' });
	assert.equal(comments.length, 2);
	assert.deepEqual(comments[0].files, ['huge.log']);
	assert.ok(comments[0].body.length <= budget, '截断后仍须在上限内');
	assert.ok(comments[0].body.includes('C:/logs/huge.log'), '截断说明要给出本地路径');
});

test('没有日志时不产生任何评论', () => {
	assert.deepEqual(groupLogComments([], 65536), []);
});
