/**
 * 仓库结构监视的判据：监视目标生成与事件名过滤。
 *
 * 监视本身依赖文件系统事件，实机契约见 repo-watcher-live.test.mjs；这里只覆盖纯判据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { importHostModule } from './lib-import.mjs';

const module = await importHostModule('source-control/repo-watcher.js');
const { structureWatchTargets, isStructureChange } = module;

test('监视目标覆盖工作树登记、子模块目录与仓库根', () => {
	const repo = join('root', 'repo');
	const common = join(repo, '.git');
	const targets = structureWatchTargets(repo, common, []);
	const directories = targets.map((target) => target.directory);
	assert.ok(directories.includes(common), '公共目录本身：worktrees 与 modules 的出现与消失');
	assert.ok(directories.includes(repo), '仓库根：.gitmodules 与 .git');
	assert.equal(directories.length, 2, '未声明子模块时只有两个目标');
});

test('不监视 worktrees 与 modules 目录自身', () => {
	const repo = join('root', 'repo');
	const common = join(repo, '.git');
	const directories = structureWatchTargets(repo, common, []).map((target) => target.directory);
	assert.ok(!directories.includes(join(common, 'worktrees')), 'worktrees 目录自身不作为目标');
	assert.ok(!directories.includes(join(common, 'modules')), 'modules 目录自身不作为目标');
});

test('公共目录按 worktrees 与 modules 名字过滤', () => {
	const repo = join('root', 'repo');
	const common = join(repo, '.git');
	const target = structureWatchTargets(repo, common, []).find((item) => item.directory === common);
	assert.deepEqual(target.names, ['worktrees', 'modules']);
	assert.equal(isStructureChange(target, 'worktrees'), true);
	assert.equal(isStructureChange(target, 'modules'), true);
	assert.equal(isStructureChange(target, 'index'), false);
});

test('声明的子模块带来其父目录的监视目标', () => {
	const repo = join('root', 'repo');
	const common = join(repo, '.git');
	const submodule = join(repo, 'lib', 'dep');
	const targets = structureWatchTargets(repo, common, [submodule]);
	const parent = targets.find((target) => target.directory === join(repo, 'lib'));
	assert.deepEqual(parent.names, ['dep'], '父目录按子模块目录名过滤');
});

test('没有 .gitmodules 时不生成子模块目标', () => {
	const repo = join('root', 'repo');
	const common = join(repo, '.git');
	assert.equal(structureWatchTargets(repo, common, null).length, structureWatchTargets(repo, common, []).length);
});

test('名字不可知时按结构变化处理', () => {
	const target = { directory: 'x', names: ['worktrees'] };
	assert.equal(isStructureChange(target, null), true);
});

test('不限定名字的目标接受任意变化', () => {
	const target = { directory: 'x', names: [] };
	assert.equal(isStructureChange(target, 'anything'), true);
});
