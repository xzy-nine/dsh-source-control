/**
 * 缓存分层：数据缓存留宿主内存，客户端只保留渲染态。
 *
 * 侧栏页签按会话存储，切换会话会让面板整体重新挂载。这里守护两条约定：
 * - 数据缓存（提交图窗口、仓库信息、工作区快照）只在宿主，客户端不再自建一份；
 * - 客户端只记渲染态（面板状态与取数参数），供重新挂载时首帧呈现。
 *
 * 断言源码结构而不是渲染结果：这些是模块边界与 hook 初始化写法，无法由纯函数直接观测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const graphData = readFileSync(join(root, 'src', 'client', 'panel', 'use-graph-data.ts'), 'utf8');
const panel = readFileSync(join(root, 'src', 'client', 'panel', 'index.ts'), 'utf8');
const hostCache = readFileSync(join(root, 'src', 'source-control', 'host-cache.ts'), 'utf8');
const routes = readFileSync(join(root, 'src', 'source-control', 'routes.ts'), 'utf8');

test('数据缓存位于宿主内存', () => {
	for (const store of ['graphs', 'repoInfos', 'snapshots']) {
		assert.match(hostCache, new RegExp(`const ${store} = new Map`), `宿主应有 ${store} 缓存`);
	}
	for (const fn of ['readGraph', 'writeGraph', 'readRepoInfo', 'writeRepoInfo', 'readSnapshot', 'writeSnapshot']) {
		assert.match(hostCache, new RegExp(`export function ${fn}`), `宿主应导出 ${fn}`);
	}
	/*
	 * 写操作后整表清空：同一仓库的主工作树与链接工作树路径不同，按执行目录作废会漏掉另一半。
	 */
	assert.match(hostCache, /onRepositoryWrite\(\(\) => \{ clearHostCache\(\); \}\)/, '成功的写操作应清空全部缓存');
});

test('宿主在读取路径上命中缓存', () => {
	assert.match(routes, /const cachedGraph = readGraph\(repo, graphParams\)/, 'loadCommits 应先查缓存');
	assert.match(routes, /const cachedSnapshot = readSnapshot\(repo\)/, 'loadWorkingTreeSnapshot 应先查缓存');
	assert.match(
		routes,
		/let repoInfo = readRepoInfo\(repo, \{ showRemoteBranches, showStashes, hideRemotes \}\)/,
		'loadRepoInfo 应按取数参数查缓存',
	);
	assert.match(routes, /case 'invalidateCache'/, '应提供主动作废命令');
	/*
	 * 仓库信息的缓存键必须含三个取数参数：远程分支、贮藏与隐藏远程都会改变 getRepoInfo 的结果。
	 */
	assert.match(
		hostCache,
		/function repoInfoKey\(repo: string, params: RepoInfoParams\): string \{[\s\S]{0,400}?listKey\(params\.hideRemotes\)/,
		'仓库信息缓存键应含取数参数',
	);
	assert.match(
		hostCache,
		/for \(const infoKey of repoInfos\.keys\(\)\) \{\s*if \(infoKey\.startsWith\(prefix\)\) repoInfos\.delete\(infoKey\)/,
		'invalidateRepo 应按前缀清除该仓库所有参数组合',
	);
	assert.match(
		hostCache,
		/listKey\(params\.hideRemotes\), listKey\(params\.branches\),\s*listKey\(params\.remotes\), listKey\(params\.stashes\)/,
		'提交图缓存键应含远程标识与贮藏标识',
	);
	/*
	 * 列表按 JSON 编码：远程名与分支名允许含逗号，逗号拼接会让「一个含逗号的名字」与
	 * 「多个名字」得到同一个键。
	 */
	assert.match(
		hostCache,
		/function listKey\(values: readonly string\[\] \| null\): string \{[\s\S]{0,200}?JSON\.stringify\(values\)/,
		'列表应保留边界地编码进缓存键',
	);
});

test('客户端不再自建数据缓存', () => {
	for (const gone of ['createCommitGraphCache', 'knownRepoInfo', 'graphWindows']) {
		assert.ok(!graphData.includes(gone), `客户端不应再有 ${gone}`);
	}
	assert.ok(!graphData.includes('lastLoadedHead'), '客户端不应再缓存 HEAD');
});

test('客户端只保留渲染态与取数参数', () => {
	assert.match(graphData, /const lastPanelState = new Map/, '应缓存渲染态');
	assert.match(graphData, /const lastMaxCommits = new Map/, '应缓存提交数上限');
	assert.match(graphData, /export function rememberedMaxCommits/, '面板需要读取该上限');
	assert.match(
		graphData,
		/rememberPanelState\(workingTreePath, \{ \.\.\.state, busy: \[\] \}, maxCommits\)/,
		'就绪后写入，且不把未完成的忙碌状态带进缓存',
	);
});

test('重新挂载时初始状态直接取渲染态', () => {
	assert.match(
		graphData,
		/useState<PanelState>\(\(\) => \{[\s\S]{0,200}?rememberedPanelState\(workingTreePath\)/,
		'初始状态应取该仓库上次的结果',
	);
	assert.match(
		panel,
		/useState\(\s*\(\) => \(workingTreePath === null \? INITIAL_MAX_COMMITS : \(rememberedMaxCommits\(workingTreePath\)/,
		'maxCommits 初值按仓库恢复，保证宿主缓存键一致',
	);
});

test('外部改动经显式命令作废宿主缓存', () => {
	// 外部进程的提交不产生写事件，宿主无从得知，只能由读到 HEAD 变化的客户端请求作废。
	assert.match(graphData, /await invalidateHostCache\(workingTreePath\)/, 'HEAD 移动时应请求宿主作废');
	assert.match(hostCache, /export function clearHostCache/, '宿主应提供整表清空');
});
