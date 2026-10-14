/**
 * git 失败文本展示化测试。
 *
 * 措辞取自 git 的真实输出；未识别的文本必须原样返回，避免吞掉 git 的说明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutFailureText } from '../src/client/panel/git-messages.ts';

test('检出被本地改动挡住时给出中文说明', () => {
	const actual = [
		'error: Your local changes to the following files would be overwritten by checkout:',
		'\ta.txt',
		'Please commit your changes or stash them before you switch branches.',
		'Aborting',
	].join('\n');
	assert.match(checkoutFailureText(actual), /提交或贮藏/);
});

test('合并被本地改动挡住时给出同一说明', () => {
	const actual = 'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt';
	assert.match(checkoutFailureText(actual), /提交或贮藏/);
});

test('未跟踪文件被覆盖时给出未跟踪文件的说明', () => {
	assert.match(
		checkoutFailureText('error: The following untracked working tree files would be overwritten by checkout:\n\tb.txt'),
		/未跟踪/,
	);
});

test('未完成的合并与变基分别说明', () => {
	assert.match(checkoutFailureText('fatal: You have not concluded your merge (MERGE_HEAD exists).'), /未完成的合并/);
	assert.match(checkoutFailureText('fatal: It seems that there is already a rebase-merge directory'), /未完成的变基/);
});

test('同名分支已存在时说明分支名冲突', () => {
	assert.match(checkoutFailureText("fatal: a branch named 'other' already exists"), /同名本地分支已存在/);
});

test('未识别的文本原样返回', () => {
	const actual = 'fatal: not a git repository (or any of the parent directories): .git';
	assert.equal(checkoutFailureText(actual), actual);
});
