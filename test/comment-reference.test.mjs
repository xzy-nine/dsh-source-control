/**
 * 评论引用的测试：定位文本按作用域与侧给出精确行号，且不携带代码片段。
 *
 * 引用要能让模型据此精确读文件，因此每种作用域都必须写明行号属于哪个版本：
 * 提交、工作区、暂存区，以及旧侧行号编号的是改动前的内容。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const refs = await import(pathToFileURL(join(root, 'src', 'client', 'diff', 'comment-reference.ts')).href);

test('工作区引用写文件与行号区间', () => {
	const text = refs.commentReference('src/app.ts', { kind: 'worktree', staged: false }, { side: 'R', startLine: 12, endLine: 14 });
	assert.equal(text, '工作区 src/app.ts 第 12-14 行');
});

test('暂存区引用与工作区区分开', () => {
	const text = refs.commentReference('src/app.ts', { kind: 'worktree', staged: true }, { side: 'R', startLine: 3, endLine: 3 });
	assert.equal(text, '暂存区 src/app.ts 第 3 行');
});

test('提交引用带短哈希', () => {
	const text = refs.commentReference('src/app.ts', { kind: 'commit', hash: 'abcdef1234567890' }, { side: 'R', startLine: 7, endLine: 8 });
	assert.equal(text, '提交 abcdef1 src/app.ts 第 7-8 行');
});

test('两提交对比写出两侧短哈希', () => {
	const text = refs.commentReference('src/app.ts', { kind: 'compare', baseHash: '1111111aaaa', hash: '2222222bbbb' }, { side: 'R', startLine: 1, endLine: 2 });
	assert.equal(text, '提交 1111111 → 2222222 src/app.ts 第 1-2 行');
});

test('旧侧行号标明它编号的是改动前的内容', () => {
	const text = refs.commentReference('src/app.ts', { kind: 'commit', hash: 'abcdef1234567890' }, { side: 'L', startLine: 5, endLine: 5 });
	assert.match(text, /旧侧/);
	assert.match(text, /改动前/);
	assert.match(text, /abcdef1/);
});

test('单行与多行的写法不同', () => {
	const one = refs.commentReference('a.ts', { kind: 'worktree', staged: false }, { side: 'R', startLine: 9, endLine: 9 });
	const many = refs.commentReference('a.ts', { kind: 'worktree', staged: false }, { side: 'R', startLine: 9, endLine: 11 });
	assert.match(one, /第 9 行$/);
	assert.match(many, /第 9-11 行$/);
});

test('顺序为版本、文件地址、行号', () => {
	const text = refs.commentReference('Docs/实现/代码结构.md', { kind: 'worktree', staged: false }, { side: 'R', startLine: 55, endLine: 147 });
	// 版本在前，读到的人先知道行号属于哪一份内容；随后是文件地址，最后是行号。
	assert.match(text, /^工作区 Docs\/实现\/代码结构\.md 第 55-147 行$/);
});

test('引用不携带代码片段', () => {
	const text = refs.formatCommentQuote('src/app.ts', { kind: 'worktree', staged: false }, { side: 'R', startLine: 12, endLine: 14 }, '这里需要判空');
	assert.ok(!text.includes('```'), '不应有代码围栏');
	assert.ok(!text.includes('差异片段'), '不应带片段标题');
	assert.equal(text, '工作区 src/app.ts 第 12-14 行\n这里需要判空');
});

test('没有正文时只有定位一行', () => {
	const text = refs.formatCommentQuote('src/app.ts', { kind: 'worktree', staged: false }, { side: 'R', startLine: 12, endLine: 12 }, '   ');
	assert.equal(text, '工作区 src/app.ts 第 12 行');
});

test('多行区间按原样写出起止行号', () => {
	const text = refs.commentReference('src/app.ts', { kind: 'worktree', staged: false }, { side: 'R', startLine: 144, endLine: 146 });
	assert.equal(text, '工作区 src/app.ts 第 144-146 行');
	assert.match(text, /144-146/, '必须保留区间，不能退化成单行');
});
