/**
 * git 失败文本展示化：把会改写工作区的常见拒绝原因换成可读说明。
 *
 * 断言按条目身份取文案，不复制文案内容：文案归 `git-messages.ts` 的 `OVERWRITE_PATTERNS`，
 * 改措辞不该让测试变红。
 */
import assert from 'node:assert/strict';
import { OVERWRITE_PATTERNS, checkoutFailureText } from '../src/client/panel/git-messages.ts';
import { parallel } from './harness.mjs';

/**
 * 取第 `index` 条拒绝原因的展示文案。
 *
 * @param index - 条目下标。
 * @returns 该条目的说明。
 */
function textOf(index) {
	return OVERWRITE_PATTERNS[index].text;
}


/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('git 失败文本', (t) => {
	t.test('检出被本地改动挡住时给出中文说明', () => {
		const actual = [
			'error: Your local changes to the following files would be overwritten by checkout:',
			'\ta.txt',
			'Please commit your changes or stash them before you switch branches.',
			'Aborting',
		].join('\n');
		assert.equal(checkoutFailureText(actual), textOf(0));
	});

	t.test('未指明操作种类的覆盖提示同样给出说明', () => {
		// 第二条模式兜住 git 未点明是检出、合并还是变基的措辞（如某些子命令与旧版本）。
		const actual = 'error: Your local changes to the following files would be overwritten by cherry-pick:\n\ta.txt';
		assert.equal(checkoutFailureText(actual), textOf(1));
	});

	t.test('未跟踪文件被覆盖时给出未跟踪文件的说明', () => {
		const actual = 'error: The following untracked working tree files would be overwritten by checkout:\n\tb.txt';
		assert.equal(checkoutFailureText(actual), textOf(2));
	});

	t.test('未完成的合并与变基分别说明', () => {
		assert.equal(checkoutFailureText('fatal: You have not concluded your merge (MERGE_HEAD exists).'), textOf(3));
		assert.equal(checkoutFailureText('fatal: It seems that there is already a rebase-merge directory'), textOf(4));
	});

	t.test('同名分支已存在时说明分支名冲突', () => {
		assert.equal(checkoutFailureText("fatal: a branch named 'other' already exists"), textOf(6));
	});

	t.test('未识别的文本原样返回', () => {
		const actual = 'fatal: not a git repository (or any of the parent directories): .git';
		assert.equal(checkoutFailureText(actual), actual);
	});
});
