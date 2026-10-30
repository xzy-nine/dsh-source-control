/**
 * 提交行文本与引用标记的测试：用 `node --test` 运行。
 *
 * 覆盖标记的种类与当前分支判定、HEAD 变化后的重算、按对象身份缓存的引用稳定性，
 * 以及未提交行与贮藏行的文案转换。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	avatarUrlsOf, displayMessage, labelsOf, refLabels, stashMessage, titleOf,
} from '../src/client/graph/row-model.ts';

/** 造一条提交。 */
const commit = (fields = {}) => ({ hash: 'h1', ...fields });

test('本地分支、远程分支、标签与贮藏各自成标记', () => {
	const stash = commit({ hash: 's1', message: 'On main: 暂存改动', stash: { selector: 'refs/stash' } });
	const labels = refLabels(commit({
		message: 'On main: 暂存改动',
		heads: ['main'],
		remotes: [{ name: 'origin/main' }],
		tags: [{ name: 'v1' }],
		stash: { selector: 'refs/stash' },
	}), 'main');
	assert.deepEqual(labels.map((label) => [label.kind, label.text, label.refType, label.refName]), [
		['head', 'main', 'head', 'main'],
		['remote', 'origin/main', 'remote', 'origin/main'],
		['tag', 'v1', 'tag', 'v1'],
		['stash', '暂存改动', 'stash', 'refs/stash'],
	]);
	assert.equal(labels[0].title, '当前分支 main');
	// 非当前分支的本地分支按普通分支标出。
	const other = refLabels(commit({ heads: ['dev'] }), 'main');
	assert.equal(other[0].kind, 'branch');
	assert.equal(other[0].title, '分支 dev');
	// 贮藏消息取消息里用户写的那一段；没有消息时退回短引用名。
	assert.equal(stashMessage(stash), '暂存改动');
	assert.equal(stashMessage(commit({ stash: { selector: 'refs/stash' } })), 'stash');
});

test('labelsOf 按提交与 HEAD 缓存，HEAD 变化后重算', () => {
	const target = commit({ heads: ['main'] });
	const first = labelsOf(target, 'main');
	assert.equal(labelsOf(target, 'main'), first, '同一提交与同一 HEAD 返回同一引用');
	assert.equal(first[0].kind, 'head');
	const switched = labelsOf(target, 'dev');
	assert.notEqual(switched, first, 'HEAD 变化必须重算');
	assert.equal(switched[0].kind, 'branch');
	// 回到原 HEAD 时重新计算，不沿用被覆盖的缓存。
	assert.equal(labelsOf(target, 'main')[0].kind, 'head');
});

test('未提交行的英文占位译成中文', () => {
	const plural = commit({ hash: '*', message: 'Uncommitted Changes (3)' });
	assert.equal(displayMessage(plural), '未提交的更改（3）');
	assert.equal(displayMessage(commit({ hash: '*', message: 'Uncommitted Changes' })), '未提交的更改');
	// 文案对不上时不改写。
	assert.equal(displayMessage(commit({ hash: '*', message: '其他' })), '其他');
	// 普通提交原样返回。
	assert.equal(displayMessage(commit({ message: 'feat: x' })), 'feat: x');
	// 贮藏行优先取贮藏消息。
	assert.equal(displayMessage(commit({ message: 'On main: 改了一处', stash: { selector: 'refs/stash' } })), '改了一处');
});

test('titleOf 按对象缓存，内容相同的另一个对象各自计算但结果一致', () => {
	const one = commit({ hash: '*', message: 'Uncommitted Changes (1)' });
	const two = commit({ hash: '*', message: 'Uncommitted Changes (1)' });
	assert.equal(titleOf(one), '未提交的更改（1）');
	assert.equal(titleOf(two), titleOf(one));
	// 未提交行的文案随条目数变化而变，对象换了就重新计算。
	assert.equal(titleOf(commit({ hash: '*', message: 'Uncommitted Changes (5)' })), '未提交的更改（5）');
});

test('头像候选地址按 noreply 邮箱解析', () => {
	assert.deepEqual(
		avatarUrlsOf('12345+octocat@users.noreply.github.com', 40),
		['https://avatars.githubusercontent.com/u/12345?s=40&v=4'],
	);
	assert.deepEqual(
		avatarUrlsOf('octocat@users.noreply.github.com', 20),
		['https://avatars.githubusercontent.com/octocat?s=20&v=4'],
	);
	// 非 noreply 邮箱、空邮箱与非字符串都没有候选。
	assert.deepEqual(avatarUrlsOf('someone@example.com'), []);
	assert.deepEqual(avatarUrlsOf('   '), []);
	assert.deepEqual(avatarUrlsOf(undefined), []);
	// 同一邮箱与边长命中缓存，返回同一引用。
	assert.equal(
		avatarUrlsOf('12345+octocat@users.noreply.github.com', 40),
		avatarUrlsOf('12345+octocat@users.noreply.github.com', 40),
	);
});
