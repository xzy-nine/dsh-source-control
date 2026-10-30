/**
 * 查询型 git 命令的判定：这些命令的非零退出是正常答案，不该记成警告。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importHostModule } from './lib-import.mjs';

const { isProbeCommand, describeGitArgs } = await importHostModule('source-control/working-tree.js');

test('查询型只读命令的非零退出不算错误', () => {
	assert.equal(isProbeCommand(['config', '--get', 'core.hooksPath']), true, 'config --get 未配置时退出 1');
	assert.equal(isProbeCommand(['rev-parse', '--verify', '--quiet', 'refs/heads/x']), true, '目标不存在时退出 1');
	assert.equal(isProbeCommand(['symbolic-ref', '--short', '-q', 'HEAD']), true, '分离头指针时退出 1');
	assert.equal(isProbeCommand(['show-ref', '--verify', '--quiet', 'refs/heads/x']), true);
	assert.equal(isProbeCommand(['check-ref-format', '--branch', 'x']), true);
});

test('真正会失败的命令仍按警告记', () => {
	assert.equal(isProbeCommand(['push']), false);
	assert.equal(isProbeCommand(['commit', '-m', 'x']), false);
	assert.equal(isProbeCommand(['merge', '--no-ff', 'x']), false);
	assert.equal(isProbeCommand(['checkout', '--detach', 'abc']), false);
	// config 不带 --get 是写入，失败就是真的失败。
	assert.equal(isProbeCommand(['config', 'user.name', 'x']), false);
});

test('日志里的 git 参数屏蔽自由文本取值', () => {
	const shown = describeGitArgs(['commit', '-m', '很长的提交信息', '--amend']);
	assert.ok(!shown.includes('很长的提交信息'), '提交信息不应进日志');
	assert.ok(shown.includes('<已屏蔽>'));
	assert.equal(describeGitArgs(['status', '--porcelain']), 'status --porcelain', '普通参数原样保留');
});
