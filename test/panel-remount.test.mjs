/**
 * 缓存分层：数据缓存留宿主内存，客户端只保留渲染态。
 *
 * 侧栏页签按会话存储，切换会话会让面板整体重新挂载。这里守护两条约定：
 * - 数据缓存（提交图窗口、仓库信息、工作区快照）只在宿主，客户端不再自建一份；
 * - 客户端只记渲染态（面板状态与取数参数），供重新挂载时首帧呈现。
 *
 * 断言源码结构而不是渲染结果：这些是模块边界与 hook 初始化写法，无法由纯函数直接观测。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parallel } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const graphData = readFileSync(join(root, 'src', 'client', 'panel', 'use-graph-data.ts'), 'utf8');
const windowCache = readFileSync(join(root, 'src', 'client', 'panel', 'graph-window-cache.ts'), 'utf8');
const polling = readFileSync(join(root, 'src', 'client', 'panel', 'use-graph-polling.ts'), 'utf8');
const panel = readFileSync(join(root, 'src', 'client', 'panel', 'index.ts'), 'utf8');
const hostCache = readFileSync(join(root, 'src', 'source-control', 'host-cache.ts'), 'utf8');
const graphRoutes = readFileSync(join(root, 'src', 'source-control', 'api', 'graph.ts'), 'utf8');
const workspaceRoutes = readFileSync(join(root, 'src', 'source-control', 'api', 'workspace.ts'), 'utf8');
const miscRoutes = readFileSync(join(root, 'src', 'source-control', 'api', 'misc.ts'), 'utf8');
const composer = readFileSync(join(root, 'src', 'client', 'panel', 'use-commit-composer.ts'), 'utf8');
const clientEntry = readFileSync(join(root, 'src', 'client', 'index.ts'), 'utf8');


/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('面板重挂载', (t) => {
	t.test('数据缓存位于宿主内存', () => {
		for (const store of ['graphs', 'repoInfos', 'snapshots']) {
			assert.match(hostCache, new RegExp(`const ${store} = new Map`), `宿主应有 ${store} 缓存`);
		}
		for (const fn of ['readGraph', 'writeGraph', 'readRepoInfo', 'writeRepoInfo', 'readSnapshot', 'writeSnapshot']) {
			assert.match(hostCache, new RegExp(`export function ${fn}`), `宿主应导出 ${fn}`);
		}
		/*
		 * 写操作按仓库作废：别的仓库数据不受影响，清全表会让同时打开多个仓库的面板各自重取。
		 * 同一仓库的主工作树与链接工作树路径不同，按 git 公共目录一并覆盖。
		 */
		assert.match(hostCache, /onRepositoryWrite\(\(repo, surface\) => \{ invalidateOnWrite\(repo, surface\); \}\)/, '成功的写操作应按仓库与影响面作废缓存');
		assert.match(hostCache, /export function invalidateOnWrite\(repo: string, surface: WriteSurface = 'history'\)/, '应导出按影响面作废的实现');
		assert.match(hostCache, /noteRepoCommonDir/, '应登记 git 公共目录以覆盖链接工作树');
	});

	t.test('宿主在读取路径上命中缓存', () => {
		assert.match(graphRoutes, /const cachedGraph = readGraph\(repo, graphParams\)/, 'loadCommits 应先查缓存');
		// 快照键含 HEAD：外部提交不产生写事件，不带 HEAD 会回投提交前的条目。
		assert.match(
			workspaceRoutes,
			/readSnapshot\(repo, await repoHeadHash\(repo\)\)/,
			'loadWorkingTreeSnapshot 应先查缓存，且键含当前 HEAD',
		);
		// 兜底轮询要读当前值：命中缓存会让条目签名永远不变，外部改动再也发现不了。
		assert.match(workspaceRoutes, /bool\('noCache'\) \? undefined : readSnapshot/, '应支持跳过快照缓存');
		assert.match(
			graphRoutes,
			/let repoInfo = readRepoInfo\(repo, \{ showRemoteBranches, showStashes, hideRemotes \}\)/,
			'loadRepoInfo 应按取数参数查缓存',
		);
		assert.match(miscRoutes, /case 'invalidateCache'/, '应提供主动作废命令');
		/*
		 * 仓库信息的缓存键必须含三个取数参数：远程分支、贮藏与隐藏远程都会改变 getRepoInfo 的结果。
		 */
		assert.match(
			hostCache,
			/function repoInfoKey\(repo: string, params: RepoInfoParams\): string \{[\s\S]{0,400}?listKey\(params\.hideRemotes\)/,
			'仓库信息缓存键应含取数参数',
		);
		/*
		 * 按仓库作废要覆盖祖先与后代：子模块的写会改变父仓库 `status` 的结果，反之亦然。
		 */
		assert.match(
			hostCache,
			/function affectedBy\(cachedRepo: string, key: string\): boolean \{[\s\S]{0,200}?cachedRepo\.startsWith\(`\$\{key\}\/`\)/,
			'invalidateRepo 应按祖先与后代关系清除该仓库所有参数组合',
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

	t.test('AI 生成按发起仓库归属，不随活跃仓库漂移', () => {
		/*
		 * 事故形态：在 A 生成、生成中切到子模块，结果写进了子模块的提交框。守护三条 ——
		 * 生成状态按仓库登记、发起时记下仓库、结果只写那一份。
		 */
		assert.match(composer, /beginGeneration\(repo\)/, '发起时按仓库开始生成');
		assert.match(composer, /const repo = workingTreePath;/, '整段生成绑定发起时的仓库');
		assert.match(composer, /generationStateOf\(workingTreePath\)/, '生成状态按当前仓库取');
		// 不中断：卸载时不再 abort 生成请求。
		assert.ok(!/aiAbortRef/.test(composer), '生成不应在切换仓库或卸载时被中断');
	});

	t.test('提交框上屏条件取自会话判定与侧栏页可见性', () => {
		/*
		 * 判据本身由 test/session-visibility.test.mjs 按行为覆盖：`retainedBy.mainView` 是引用计数，
		 * 当布尔比较恒为假，会让生成结果永远不上屏。这里只断言传递链。
		 */
		assert.match(clientEntry, /isSessionDisplayed\(sessions, sessionId\)/, '应复用会话判定，不另造一套');
		assert.match(clientEntry, /tab\?\.visible === true/, '应判定侧栏页是否可见');
		assert.match(clientEntry, /onScreen,/, '应把上屏条件传给面板');
		assert.match(panel, /onScreen = true/, '面板应接收上屏条件');
		assert.match(panel, /onScreen, run,/, '应把上屏条件传给提交框');
	});

	t.test('变更列表与提交图各有自己的就绪阶段', () => {
		/*
		 * 两路并行取数、快照通常先回：共用一个阶段会让更改区陪着提交图显示占位。
		 */
		assert.match(panel, /phase: state\.entriesPhase/, '更改区应读变更列表那一路的阶段');
		assert.match(panel, /busy: busyFlags, phase: state\.phase/, '图形区应读提交图那一路的阶段');
	});

	t.test('客户端不缓存提交数据，只保留取数参数', () => {
		// 提交图窗口与工作区快照只在宿主缓存，客户端不复制一份。
		for (const gone of ['createCommitGraphCache', 'graphWindows']) {
			assert.ok(!graphData.includes(gone), `客户端不应再有 ${gone}`);
		}
		assert.ok(!graphData.includes('lastLoadedHead'), '客户端不应再缓存 HEAD');
		/*
		 * `knownRepoInfo` 不是数据副本：它是随请求回传宿主的取数参数（远程名与贮藏标识），
		 * 使宿主跳过仓库信息批。因此它必须有容量上限，且随写操作作废。
		 */
		assert.match(windowCache, /const knownRepoInfo = new Map/, '应保留已知仓库信息');
		assert.match(windowCache, /const KNOWN_REPO_INFO_LIMIT = \d+/, '已知仓库信息应有容量上限');
		assert.match(
			windowCache,
			/export function dropGraphWindows\(repoPath: string\): void \{[\s\S]{0,300}?knownRepoInfo\.delete\(key\)/,
			'写操作与换仓库时应作废已知仓库信息',
		);
	});

	t.test('客户端只保留渲染态与取数参数', () => {
		assert.match(windowCache, /const lastPanelState = new Map/, '应缓存渲染态');
		assert.match(windowCache, /const lastMaxCommits = new Map/, '应缓存提交数上限');
		assert.match(windowCache, /export function rememberedMaxCommits/, '面板需要读取该上限');
		assert.match(
			graphData,
			/rememberPanelState\(workingTreePath, \{ \.\.\.state, busy: \[\] \}, maxCommits\)/,
			'就绪后写入，且不把未完成的忙碌状态带进缓存',
		);
	});

	t.test('重新挂载时初始状态直接取渲染态', () => {
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

	t.test('外部改动经显式命令作废宿主缓存', () => {
		// 外部进程的提交不产生写事件，宿主无从得知，只能由读到 HEAD 变化的客户端请求作废。
		assert.match(polling, /await invalidateHostCache\(workingTreePath\)/, 'HEAD 移动时应请求宿主作废');
		assert.match(hostCache, /export function clearHostCache/, '宿主应提供整表清空');
	});
});
