/**
 * 丢弃结局提示的测试：哪些结局需要告知用户，以及提示里是否点明未清理的部分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { discardNoticeOf } from '../src/client/panel/discard-notice.ts';

/** 造一份丢弃结局。 */
const report = (overrides = {}) => ({
	discarded: [],
	submodules: [],
	skippedRepositories: [],
	...overrides,
});

/** 造一条子模块结局。 */
const submodule = (path, status, dirty = false, reason = null) => ({ path, status, dirty, reason });

test('全部丢弃成功时不提示', () => {
	assert.equal(discardNoticeOf(report({ discarded: ['a.txt', 'b.txt'] })), '');
});

test('子模块已移动且内部干净时不提示', () => {
	assert.equal(discardNoticeOf(report({ submodules: [submodule('lib/dep', 'moved')] })), '');
});

test('子模块已移动但内部仍有改动时说明未清理', () => {
	const text = discardNoticeOf(report({ submodules: [submodule('lib/dep', 'moved', true)] }));
	assert.match(text, /lib\/dep/);
	assert.match(text, /未清理/);
});

test('子模块未被移动时说明原因', () => {
	const blocked = discardNoticeOf(report({
		submodules: [submodule('lib/dep', 'blocked', true, 'error: local changes would be overwritten')],
	}));
	assert.match(blocked, /lib\/dep/);
	assert.match(blocked, /local changes would be overwritten/);

	const uninitialized = discardNoticeOf(report({ submodules: [submodule('lib/dep', 'uninitialized')] }));
	assert.match(uninitialized, /lib\/dep/);
	assert.match(uninitialized, /未初始化/);
});

test('未删除的嵌套仓库与子模块结局一并列出', () => {
	const text = discardNoticeOf(report({
		submodules: [submodule('lib/dep', 'unchanged', true)],
		skippedRepositories: ['vendor/nested'],
	}));
	const lines = text.split('\n');
	assert.equal(lines.length, 2);
	assert.match(lines[1], /vendor\/nested/);
	assert.match(lines[1], /未删除/);
});
