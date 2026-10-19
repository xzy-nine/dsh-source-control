/**
 * 仓库结构监视的判据：监视目标生成与事件名过滤。
 *
 * 监视本身依赖文件系统事件，实机契约见 repo-watcher-live.test.mjs；这里只覆盖纯判据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importHostModule } from './lib-import.mjs';

const module = await importHostModule('source-control/repo-watcher.js');
const { structureWatchTargets, isStructureChange, isRepositorySetChange } = module;

test('监视目标覆盖工作树登记、子模块声明与子模块父目录', () => {
	const repo = join('root', 'repo');
	const common = join(repo, '.git');
	const targets = structureWatchTargets(repo, common, []);
	const directories = targets.map((target) => target.directory);
	assert.ok(directories.includes(common), '公共目录：worktrees 与 modules 的出现与消失');
	assert.ok(directories.includes(repo), '仓库根：.gitmodules');
	assert.equal(directories.length, 2, '未声明子模块时只有两个目标');
});

test('仓库根只按 .gitmodules 过滤，不含 .git', () => {
	const repo = join('root', 'repo');
	const common = join(repo, '.git');
	const target = structureWatchTargets(repo, common, []).find((item) => item.directory === repo);
	assert.deepEqual(target.names, ['.gitmodules']);
	assert.equal(isStructureChange(target, '.git'), false, '.git 内部变化不得触发结构事件');
	assert.equal(isStructureChange(target, '.gitmodules'), true);
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

/* --- 工作区级判据：仓库集合是否可能已变 --- */

test('已知仓库内部的 .git 事件不触发工作区级重新发现', async () => {
	const repo = join('root', 'known-repo');
	const before = await isRepositorySetChange(join(repo, '.git', 'index.lock'), 'rename', [repo]);
	assert.equal(before, false, '普通 git 操作在 .git 下的写事件不得触发');
	assert.equal(await isRepositorySetChange(join(repo, '.git'), 'change', [repo]), false);
});

test('未知仓库的 .git 事件触发工作区级重新发现', async () => {
	const known = [join('root', 'known-repo')];
	assert.equal(
		await isRepositorySetChange(join('root', 'brand-new', '.git'), 'rename', known),
		true,
		'新建仓库的 .git 出现时该路径尚无句柄',
	);
});

test('普通文件与普通目录的事件不触发工作区级重新发现', async () => {
	const known = [join('root', 'known-repo')];
	assert.equal(await isRepositorySetChange(join('root', 'notes.md'), 'rename', known), false);
	assert.equal(await isRepositorySetChange(join('root', 'plain-dir'), 'rename', known), false, '普通目录没有 .git 条目');
	assert.equal(await isRepositorySetChange(join('root', 'plain-dir'), 'change', known), false, 'change 事件只认 .git 路径');
});

test('已知仓库目录消失时触发工作区级重新发现', async () => {
	const repo = join('root', 'known-repo');
	assert.equal(await isRepositorySetChange(repo, 'rename', [repo]), true, '仓库目录被整体删除');
	assert.equal(await isRepositorySetChange(join('root'), 'rename', [repo]), true, '仓库的祖先目录被删除');
	assert.equal(await isRepositorySetChange(join('root', 'known-repo-other'), 'rename', [repo]), false, '同名前缀不算祖先');
});

test('名字缺失时按已知仓库是否仍存在判定', async () => {
	// 删除目录树时 Windows 的递归句柄只报 change 而不给名字，只有这条信号可判断。
	assert.equal(await isRepositorySetChange(null, 'change', []), false, '没有已知仓库时无从判断，不触发');
	assert.equal(await isRepositorySetChange(null, 'change', [join('root', 'not-created')]), true, '已知仓库不存在');
});

test('新建目录里初始化的仓库按下探层数发现', async () => {
	const root = mkdtempSync(join(tmpdir(), 'gg-watch-probe-'));
	try {
		const deep = join(root, 'nested', 'repo');
		mkdirSync(deep, { recursive: true });
		mkdirSync(join(deep, '.git'), { recursive: true });
		// 事件只给一级目录名：要下探两层才看得到 nested/repo/.git。
		assert.equal(await isRepositorySetChange(join(root, 'nested'), 'rename', []), true, '下探层数内出现仓库');
		const flat = join(root, 'flat');
		mkdirSync(flat);
		assert.equal(await isRepositorySetChange(flat, 'rename', []), false, '普通目录不触发');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
