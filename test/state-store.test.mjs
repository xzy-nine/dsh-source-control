/**
 * 状态文档迁移与类型化访问器回归。
 *
 * 从 `lib/` 产物导入宿主 `state-store.js`（`pretest` 先重建），从 `src/` 直连客户端
 * `path-key.ts` 做归一化跨端一致性校验。每个用例用 `DSH_SOURCE_CONTROL_HOME` 隔离磁盘文档。
 *
 * 迁移用例显式传入 sessionId -> 工作区根 的解析器，不依赖真实 DSH 会话存储。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = join(root, 'lib', 'src', 'source-control', 'state-store.js');
const clientPathKey = join(root, 'src', 'client', 'shared', 'path-key.ts');

const temps = [];
test.after(() => { for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } } });

/**
 * 在独立 home 下取一份 state-store 模块实例并写好初始文档。
 *
 * @param {string} json - 初始文档 JSON。
 * @returns 模块导出与 home 路径。
 */
async function freshState(json) {
	const home = mkdtempSync(join(tmpdir(), 'dsh-state-'));
	temps.push(home);
	process.env.DSH_SOURCE_CONTROL_HOME = home;
	if (json !== undefined) writeFileSync(join(home, 'state.json'), json);
	const mod = await import(pathToFileURL(statePath).href + '?v=' + temps.length);
	mod.resetStateCache();
	return { mod, home };
}

test('normalizePath：盘符路径小写、反斜杠转正斜杠、去尾斜杠', async () => {
	const { mod } = await freshState();
	assert.equal(mod.normalizePath('E:\\GitHubCode\\repo\\'), 'e:/githubcode/repo');
	assert.equal(mod.normalizePath('e:/GitHubCode/repo/'), 'e:/githubcode/repo');
	assert.equal(mod.normalizePath('E:/GitHubCode/repo'), 'e:/githubcode/repo');
	assert.equal(mod.normalizePath('/home/user/repo/'), '/home/user/repo');
	assert.equal(mod.normalizePath(null), '');
	assert.equal(mod.normalizePath(''), '');
});

test('normalizePath：与客户端 path-key 等价', async () => {
	const { mod } = await freshState();
	const client = await import(pathToFileURL(clientPathKey).href);
	const samples = [
		'E:\\GitHubCode\\02DSH\\dshPlugins\\dsh-source-control',
		'e:/githubcode/02dsh/dshplugins/dsh-source-control/',
		'C:\\Users\\WINDOWS\\.dsh',
		'/home/user/repo',
	];
	for (const p of samples) assert.equal(mod.normalizePath(p), client.normalizePath(p), `差异：${p}`);
});

test('migrateV1ToV3：各分区按类型归位', async () => {
	const { mod } = await freshState();
	const v1 = {
		version: 1,
		entries: {
			'dsh-source-control-settings': { autoFetch: true },
			'dsh-source-control-repo-open': false,
			'dsh-source-control-graph-height': 400,
			'dsh-source-control-ref-filter': { 'e:/githubcode/repo': 'all' },
			'dsh-source-control-ref-filter:E:\\githubcode\\other': { mode: 'manual', selected: ['main', 'feature/x'] },
			'dsh-source-control-ref-filter:e:/githubcode/auto': { mode: 'auto', selected: [] },
			'dsh-source-control-selection:session-abc': 'E:/GitHubCode/repo',
			'dsh-source-control-expanded:session-abc': ['e:/githubcode/repo', 'e:/githubcode/other'],
			'dsh-source-control-expanded:session-def': JSON.stringify(['e:/githubcode/x']),
			'ggg-commit-msg:e:/githubcode/repo': 'fix: bug',
			'ggg-commit-msg:e:/githubcode/empty': '',
			'dsh-source-control-migrated': true,
		},
		repos: {
			'E:\\GitHubCode': [
				{ path: 'E:/GitHubCode/repo', name: 'repo' },
			],
		},
	};
	// 两个会话还原到同一工作区根：按 updatedAt 取最新（同刻时 session-abc 先入，session-def 后入）。
	const cwds = { 'session-abc': 'E:/GitHubCode', 'session-def': 'E:/GitHubCode' };
	const doc = mod.migrateV1ToV3(v1, 1000, (id) => cwds[id] ?? null);
	assert.equal(doc.schemaVersion, 3);
	assert.deepEqual(doc.settings, { autoFetch: true });
	assert.equal(doc.layout.repoOpen, false);
	assert.equal(doc.layout.graphHeight, 400);
	assert.equal(doc.layout.graphOpen, true, '缺省 graphOpen');
	assert.equal(doc.layout.repoHeight, 200, '缺省 repoHeight');
	// ref-filter：全局表 + 旧按仓库键合并；自动模式不落盘。
	assert.equal(doc.refFilters['e:/githubcode/repo'], 'all');
	assert.deepEqual(doc.refFilters['e:/githubcode/other'], ['refs/heads/main', 'refs/remotes/feature/x']);
	assert.ok(!('e:/githubcode/auto' in doc.refFilters), '自动模式不落盘');
	// 工作区：键为工作区根，仓库位置并入；会话的选中与展开折进同一表。
	assert.ok('e:/githubcode' in doc.workspaces, '仓库位置落进工作区');
	assert.equal(doc.workspaces['e:/githubcode'].repos.length, 1);
	assert.equal(doc.workspaces['e:/githubcode'].repos[0].path, 'E:/GitHubCode/repo');
	assert.ok('e:/githubcode' in doc.workspaces);
	// 两个会话同工作区、updatedAt 相同：后者写入生效。
	assert.ok(doc.workspaces['e:/githubcode'].selectedRepo === 'e:/githubcode/repo' || doc.workspaces['e:/githubcode'].selectedRepo === null);
	// 草稿：非空保留，空串丢弃。
	assert.equal(doc.drafts.commitMessages['e:/githubcode/repo'], 'fix: bug');
	assert.ok(!('e:/githubcode/empty' in doc.drafts.commitMessages));
});

test('migrateV1ToV3：空会话与不可还原会话不保留', async () => {
	const { mod } = await freshState();
	const v1 = {
		version: 1,
		entries: {
			'dsh-source-control-selection:session-empty': null,
			'dsh-source-control-expanded:session-empty': [],
			'dsh-source-control-selection:session-lost': 'E:/GitHubCode/repo',
		},
		repos: {},
	};
	const doc = mod.migrateV1ToV3(v1, 1000, () => null);
	assert.deepEqual(doc.workspaces, {}, '无法还原工作区的会话丢弃');
});

test('migrateV2ToV3：会话与仓库位置按工作区根合并，updatedAt 取最新', async () => {
	const { mod } = await freshState();
	const v2 = {
		schemaVersion: 2,
		settings: null,
		layout: null,
		refFilters: {},
		sessions: {
			'session-old': { selectedRepo: 'e:/githubcode/old', expandedRepos: [], updatedAt: 500 },
			'session-new': { selectedRepo: 'e:/githubcode/new', expandedRepos: ['e:/githubcode/new'], updatedAt: 900 },
		},
		repoLocations: { 'E:\\GitHubCode': [{ path: 'E:/GitHubCode/repo', name: 'repo' }] },
		drafts: null,
	};
	// 两个会话都还原到 e:/githubcode，旧的先入、新的后入：取 updatedAt 最新的 session-new。
	const doc = mod.migrateV2ToV3(v2, (id) => (id === 'session-old' || id === 'session-new' ? 'E:/GitHubCode' : null));
	assert.equal(doc.schemaVersion, 3);
	assert.ok('e:/githubcode' in doc.workspaces);
	assert.equal(doc.workspaces['e:/githubcode'].selectedRepo, 'e:/githubcode/new');
	assert.deepEqual(doc.workspaces['e:/githubcode'].expandedRepos, ['e:/githubcode/new']);
	assert.equal(doc.workspaces['e:/githubcode'].updatedAt, 900);
	assert.equal(doc.workspaces['e:/githubcode'].repos.length, 1, '仓库位置并入同一工作区');
	assert.ok(!('sessions' in doc));
	assert.ok(!('repoLocations' in doc));
});

test('migrateV2ToV3：无法还原工作区的会话丢弃，仓库位置键归一保留', async () => {
	const { mod } = await freshState();
	const v2 = {
		schemaVersion: 2, settings: null, layout: null, refFilters: {},
		sessions: { s1: { selectedRepo: 'e:/githubcode/x', expandedRepos: [], updatedAt: 1 } },
		repoLocations: { 'E:\\GitHubCode\\': [{ path: 'e:/githubcode/repo', name: 'repo' }] },
		drafts: null,
	};
	const doc = mod.migrateV2ToV3(v2, () => null);
	assert.deepEqual(Object.keys(doc.workspaces), ['e:/githubcode'], '仅剩仓库位置所在工作区');
	assert.equal(doc.workspaces['e:/githubcode'].selectedRepo, null);
	assert.equal(doc.workspaces['e:/githubcode'].repos.length, 1);
});

test('writeWorkspace：合并部分状态并刷 updatedAt', async () => {
	const { mod } = await freshState(JSON.stringify({ schemaVersion: 3, settings: null, layout: null, refFilters: {}, workspaces: {}, drafts: null }));
	mod.resetStateCache();
	mod.writeWorkspace('E:/GitHubCode', { selectedRepo: 'E:/GitHubCode/repo' });
	const snap = mod.readSnapshot();
	assert.equal(snap.workspaces['e:/githubcode'].selectedRepo, 'e:/githubcode/repo');
	assert.equal(snap.workspaces['e:/githubcode'].expandedRepos.length, 0);
	assert.ok(snap.workspaces['e:/githubcode'].updatedAt > 0);
	// 只写 expanded，selectedRepo 保留。
	const before = snap.workspaces['e:/githubcode'].updatedAt;
	await new Promise((r) => setTimeout(r, 5));
	mod.writeWorkspace('E:/GitHubCode', { expandedRepos: ['e:/githubcode/other'] });
	const snap2 = mod.readSnapshot();
	assert.equal(snap2.workspaces['e:/githubcode'].selectedRepo, 'e:/githubcode/repo');
	assert.deepEqual(snap2.workspaces['e:/githubcode'].expandedRepos, ['e:/githubcode/other']);
	assert.ok(snap2.workspaces['e:/githubcode'].updatedAt > before, 'updatedAt 应刷新');
});

test('writeWorkspace：树状态都空且无仓库位置时删除工作区，有仓库位置时保留', async () => {
	const { mod } = await freshState(JSON.stringify({ schemaVersion: 3, settings: null, layout: null, refFilters: {}, workspaces: { 'e:/githubcode': { selectedRepo: 'e:/githubcode/r', expandedRepos: [], repos: [], updatedAt: 1 } }, drafts: null }));
	mod.resetStateCache();
	mod.writeWorkspace('E:/GitHubCode', { selectedRepo: null, expandedRepos: [] });
	assert.ok(!('e:/githubcode' in mod.readSnapshot().workspaces), '无仓库位置时删除');

	mod.writeRepoLocations('E:/GitHubCode', [{ path: 'E:/GitHubCode/repo', name: 'repo' }]);
	mod.writeWorkspace('E:/GitHubCode', { selectedRepo: null, expandedRepos: [] });
	const ws = mod.readSnapshot().workspaces['e:/githubcode'];
	assert.ok(ws !== undefined, '仍有仓库位置时保留');
	assert.equal(ws.repos.length, 1);
});

test('pruneWorkspaces：按年龄与上限删除', async () => {
	const now = Date.now();
	const workspaces = {};
	for (let i = 0; i < 5; i += 1) workspaces[`s${i}`] = { selectedRepo: 'e:/r', expandedRepos: [], repos: [], updatedAt: now - i * 1000 };
	const { mod } = await freshState(JSON.stringify({ schemaVersion: 3, settings: null, layout: null, refFilters: {}, workspaces, drafts: null }));
	mod.resetStateCache();
	// 年龄阈值 2500ms：s0/s1/s2 保留，s3/s4 过期。
	mod.pruneWorkspaces(2500, 200);
	let snap = mod.readSnapshot();
	assert.equal(Object.keys(snap.workspaces).length, 3);
	assert.ok('s0' in snap.workspaces && 's1' in snap.workspaces && 's2' in snap.workspaces);
	// 上限 2：按 updatedAt 升序删最旧（s0 最旧）。
	mod.pruneWorkspaces(Infinity, 2);
	snap = mod.readSnapshot();
	assert.equal(Object.keys(snap.workspaces).length, 2);
	assert.ok('s0' in snap.workspaces && 's1' in snap.workspaces, '保留最新的两个');
});

test('readRepoLocations / writeRepoLocations / listRepoLocationWorkspaces：经工作区读写', async () => {
	const { mod } = await freshState(JSON.stringify({ schemaVersion: 3, settings: null, layout: null, refFilters: {}, workspaces: {}, drafts: null }));
	mod.resetStateCache();
	assert.deepEqual(mod.readRepoLocations('E:/GitHubCode'), []);
	mod.writeRepoLocations('E:/GitHubCode', [{ path: 'E:/GitHubCode/repo', name: 'repo' }]);
	assert.deepEqual(mod.readRepoLocations('e:/githubcode/'), [{ path: 'E:/GitHubCode/repo', name: 'repo' }]);
	assert.deepEqual(mod.listRepoLocationWorkspaces(), ['e:/githubcode']);
});

test('readSnapshot：v1 文档首次读取自动迁移并落盘', async () => {
	const { mod, home } = await freshState(JSON.stringify({
		version: 1,
		entries: { 'dsh-source-control-settings': { x: 1 } },
		repos: {},
	}));
	mod.resetStateCache();
	const snap = mod.readSnapshot();
	assert.deepEqual(snap.settings, { x: 1 });
	// 落盘后文件已是当前结构版本。
	const { readFileSync } = await import('node:fs');
	const persisted = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
	assert.equal(persisted.schemaVersion, 3);
});

test('readSnapshot：v2 文档首次读取自动迁移并落盘', async () => {
	const { mod, home } = await freshState(JSON.stringify({
		schemaVersion: 2, settings: { y: 2 }, layout: null, refFilters: {},
		sessions: {}, repoLocations: { 'e:/githubcode': [{ path: 'e:/githubcode/repo', name: 'repo' }] }, drafts: null,
	}));
	mod.resetStateCache();
	const snap = mod.readSnapshot();
	assert.deepEqual(snap.settings, { y: 2 });
	assert.equal(snap.workspaces['e:/githubcode'].repos.length, 1);
	const { readFileSync } = await import('node:fs');
	const persisted = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
	assert.equal(persisted.schemaVersion, 3);
	assert.ok(!('sessions' in persisted) && !('repoLocations' in persisted), '旧分区不再落盘');
});

test('readDraft / clearDraft：按归一化键读写', async () => {
	const { mod } = await freshState(JSON.stringify({
		schemaVersion: 3, settings: null, layout: null, refFilters: {}, workspaces: {},
		drafts: { commitMessages: { 'e:/githubcode/repo': 'fix' } },
	}));
	mod.resetStateCache();
	assert.equal(mod.readDraft('E:\\GitHubCode\\repo'), 'fix');
	assert.equal(mod.readDraft('e:/githubcode/other'), null);
	mod.clearDraft('E:/GitHubCode/repo');
	assert.equal(mod.readDraft('e:/githubcode/repo'), null);
});
