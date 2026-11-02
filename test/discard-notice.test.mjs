/**
 * 丢弃结局提示的测试：哪些结局需要告知用户，以及提示里是否点明未清理的部分。
 *
 * 断言取 `DISCARD_TEXT` 的模板：被守护的是「哪类结局要提示」与「提示里带上了子模块路径」，
 * 不是提示措辞。
 */
import assert from 'node:assert/strict';
import { DISCARD_TEXT, discardNoticeOf } from '../src/client/panel/discard-notice.ts';
import { parallel } from './harness.mjs';

/** 造一份丢弃结局。 */
const report = (overrides = {}) => ({
	discarded: [],
	submodules: [],
	skippedRepositories: [],
	...overrides,
});

/** 造一条子模块结局。 */
const submodule = (path, status, dirty = false, reason = null) => ({ path, status, dirty, reason });

/** 按模板代入路径。 */
const fill = (template, name) => template.replace('{name}', name);


/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('丢弃结局提示', (t) => {
	t.test('全部丢弃成功时不提示', () => {
		assert.equal(discardNoticeOf(report({ discarded: ['a.txt', 'b.txt'] })), '');
	});

	t.test('子模块已移动且内部干净时不提示', () => {
		assert.equal(discardNoticeOf(report({ submodules: [submodule('lib/dep', 'moved')] })), '');
	});

	t.test('子模块已移动但内部仍有改动时说明未清理', () => {
		const text = discardNoticeOf(report({ submodules: [submodule('lib/dep', 'moved', true)] }));
		assert.equal(text, fill(DISCARD_TEXT.movedDirty, 'lib/dep'));
	});

	t.test('子模块未被移动时说明原因', () => {
		const blocked = discardNoticeOf(report({
			submodules: [submodule('lib/dep', 'blocked', true, 'error: local changes would be overwritten')],
		}));
		// 被拒的结局把 git 原文接在说明之后，用户据此判断原因。
		assert.ok(blocked.startsWith(fill(DISCARD_TEXT.blocked, 'lib/dep')), '应先给出未移动的说明');
		assert.match(blocked, /local changes would be overwritten/);

		const uninitialized = discardNoticeOf(report({ submodules: [submodule('lib/dep', 'uninitialized')] }));
		assert.equal(uninitialized, fill(DISCARD_TEXT.uninitialized, 'lib/dep'));
	});

	t.test('未删除的嵌套仓库与子模块结局一并列出', () => {
		const text = discardNoticeOf(report({
			submodules: [submodule('lib/dep', 'unchanged', true)],
			skippedRepositories: ['vendor/nested'],
		}));
		const lines = text.split('\n');
		assert.equal(lines.length, 2);
		assert.equal(lines[0], fill(DISCARD_TEXT.unchangedDirty, 'lib/dep'));
		assert.equal(lines[1], DISCARD_TEXT.skippedRepos.replace('{names}', 'vendor/nested'));
	});
});
