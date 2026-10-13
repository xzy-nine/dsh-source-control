/**
 * `gh` 失败分类：把 CLI 的真实输出形态映射成可读原因，供前端决定降级路径。
 *
 * 覆盖四类需要区分的情形：未安装、未登录、缺 scope、无权限。GitHub 对无权访问的资源
 * 常回 404，因此建仓库时的 404 要归入无权限而不是「不存在」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGhFailure } from '../src/source-control/gh-cli.ts';

/** 构造一次 gh 调用结果。 */
function result(code, stderr, stdout = '') {
	return { code, stderr, stdout };
}

test('未安装 gh 归为 missing-cli', () => {
	const failure = classifyGhFailure(result(-1, 'spawn gh ENOENT'));
	assert.equal(failure.kind, 'missing-cli');
	assert.match(failure.message, /gh CLI/);
});

test('未登录归为 not-logged-in', () => {
	const failure = classifyGhFailure(result(1, 'To get started with GitHub CLI, please run:  gh auth login'));
	assert.equal(failure.kind, 'not-logged-in');
});

test('缺 scope 时给出需要补的 scope 名', () => {
	// gh 的真实措辞：This API operation needs the "x" scope.
	const failure = classifyGhFailure(result(1, 'HTTP 404: Not Found\nThis API operation needs the "gist" scope. To request it, run:  gh auth refresh -h github.com -s gist'));
	assert.equal(failure.kind, 'missing-scope');
	assert.equal(failure.scope, 'gist');
	assert.match(failure.message, /gist/);
});

test('scope 提示优先于 403 权限提示', () => {
	// 同时含 403 与 scope 名时，补授权是更可操作的结论。
	const failure = classifyGhFailure(result(1, 'gh: Must have admin rights to Repository. (HTTP 403)\nThis API operation needs the "delete_repo" scope.'));
	assert.equal(failure.kind, 'missing-scope');
	assert.equal(failure.scope, 'delete_repo');
});

test('403 无 scope 提示时归为 forbidden', () => {
	const failure = classifyGhFailure(result(1, 'gh: Resource not accessible by integration (HTTP 403)'));
	assert.equal(failure.kind, 'forbidden');
});

test('建仓库时的 404 归为无权限', () => {
	// GitHub 不区分「无权访问」与「不存在」，建仓库场景按无权限提示更准确。
	const failure = classifyGhFailure(result(1, 'gh: Not Found (HTTP 404)'), 'create-repo');
	assert.equal(failure.kind, 'forbidden');
});

test('一般场景的 404 归为 not-found', () => {
	const failure = classifyGhFailure(result(1, 'gh: Not Found (HTTP 404)'));
	assert.equal(failure.kind, 'not-found');
});

test('422 归为 invalid', () => {
	const failure = classifyGhFailure(result(1, 'gh: New repository name must not be blank (HTTP 422)'));
	assert.equal(failure.kind, 'invalid');
});

test('无法归类的失败保留原文', () => {
	const failure = classifyGhFailure(result(1, 'gh: something unexpected'));
	assert.equal(failure.kind, 'unknown');
	assert.match(failure.message, /something unexpected/);
});
