/**
 * 仓库树预加载的契约回归：活跃会话工作区判定、四步取数、快照发布、在途去重与取消。
 *
 * `repo-preload.ts` 经 `../api/index.ts` 取数，这里以替换 `globalThis.fetch` 的方式提供宿主响应，
 * 因此覆盖的是真实命令序列与真实解析层。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	activeWorkspaceOf, dropWorkspace, getWorkspaceSnapshot, preloadWorkspace, subscribeWorkspace,
} from '../src/client/panel/repo-preload.ts';

/** 一个仓库节点。 */
function repoNode(path, children = []) {
	return {
		id: path.toLowerCase(), path, name: path.split('/').pop() ?? path, kind: 'repo',
		depth: 0, branch: 'main', head: null, available: true, children,
	};
}

/** 一个工作树节点。 */
function worktreeNode(path) {
	return {
		id: path.toLowerCase(), path, name: path.split('/').pop() ?? path, kind: 'worktree',
		depth: 1, branch: 'linked', head: null, available: true, children: [],
	};
}

/**
 * 按命令名返回响应的 fetch 替身。
 *
 * @param handlers - 命令名 -> 响应载荷。
 * @returns { restore, calls }：还原函数与收到的命令序列。
 */
function stubFetch(handlers) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(init.body);
		calls.push(body);
		const handler = handlers[body.command];
		const payload = handler === undefined ? { error: `未知命令: ${body.command}` } : handler(body);
		return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
	};
	return { restore: () => { globalThis.fetch = original; }, calls };
}

/**
 * 等到条件成立。
 *
 * @param predicate - 判定函数。
 * @returns 条件成立时为 true；超时为 false。
 */
async function waitFor(predicate) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((done) => setTimeout(done, 5));
	}
	return false;
}

test('activeWorkspaceOf：只取主视图当前会话的那一个工作区', () => {
	const list = {
		ids: ['s1', 's2', 's3', 's4'],
		byId: {
			s1: { cwd: '/work/a' },
			s2: { cwd: '/work/b', retainedBy: { mainView: 1 } },
			s3: { cwd: '/work/c' },
			s4: { cwd: '/work/d', retainedBy: { mainView: 1 }, origin: 'subagent' },
		},
	};
	assert.deepEqual(
		activeWorkspaceOf(list),
		{ sessionId: 's2', cwd: '/work/b' },
		'只返回主视图会话的工作区，其它会话的工作区不参与',
	);

	assert.deepEqual(
		activeWorkspaceOf({ ids: ['s1'], byId: { s1: { cwd: '/work/a' } } }),
		null,
		'没有正在显示的会话时为空',
	);
	assert.deepEqual(
		activeWorkspaceOf({ ids: ['s1'], byId: { s1: { cwd: '/work/a', retainedBy: { mainView: 1 } } }, current: 's1' }),
		{ sessionId: 's1', cwd: '/work/a' },
		'旧宿主的 current 标记同样生效',
	);
	assert.deepEqual(
		activeWorkspaceOf({ ids: ['s1'], byId: { s1: { retainedBy: { mainView: 1 } } } }),
		null,
		'缺 cwd 的会话不产生工作区',
	);
	assert.deepEqual(activeWorkspaceOf(null), null, '非对象输入返回 null');
});

test('预加载：按发现、纠正、补齐、同步的顺序取数并逐阶段发布', async () => {
	const root = '/work/preload-a';
	const repoA = '/work/preload-a/alpha';
	const repoB = '/work/preload-a/beta';
	const stubbed = stubFetch({
		discoverRepositories: (body) => ({
			command: 'discoverRepositories',
			nodes: [repoNode(repoA), repoNode(repoB)],
			truncated: false,
			// 首轮命中持久化位置：驱动一次位置纠正。
			usedCache: body.fullScan !== true,
		}),
		enrichRepositories: (body) => ({
			command: 'enrichRepositories',
			nodes: body.repos.map((path) => repoNode(path, [worktreeNode(`${path}-wt`)])),
		}),
		loadReposSync: (body) => ({
			command: 'loadReposSync',
			results: body.repos.map((path) => ({ path, branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })),
		}),
	});
	const seen = [];
	preloadWorkspace(root);
	const unsubscribe = subscribeWorkspace(root, () => {
		const snapshot = getWorkspaceSnapshot(root);
		if (snapshot !== null) seen.push(snapshot);
	});
	try {
		await waitFor(() => (getWorkspaceSnapshot(root)?.syncById.size ?? 0) >= 4);
	} finally {
		unsubscribe();
		stubbed.restore();
		dropWorkspace(root);
	}

	const commands = stubbed.calls.map((call) => call.command);
	assert.deepEqual(commands, [
		'discoverRepositories', 'discoverRepositories', 'enrichRepositories', 'loadReposSync',
	], '浅层发现 -> 位置纠正 -> 补齐 -> 领先/落后');
	assert.equal(stubbed.calls[0].shallow, true);
	assert.equal(stubbed.calls[1].fullScan, true, '位置纠正绕开持久化位置');
	assert.deepEqual(stubbed.calls[2].repos, [repoA, repoB], '一次下发全部仓库，不按批切分');
	assert.deepEqual(
		stubbed.calls[3].repos,
		[repoA, `${repoA}-wt`, repoB, `${repoB}-wt`],
		'领先/落后覆盖全部节点',
	);

	assert.ok(seen.length >= 3, '发现、补齐、同步各发布一次');
	const last = seen.at(-1);
	assert.equal(last.status, 'ready');
	assert.equal(last.nodes.length, 2);
	assert.equal(last.nodes[0].children.length, 1, '补齐出的工作树挂回仓库节点');
	assert.equal(last.discoveryRevision, 2, '发现与位置纠正各递增一次代次');
	assert.equal(last.syncById.get(last.nodes[0].id).ahead, 2);
	assert.equal(last.syncById.get(last.nodes[0].children[0].id).upstream, 'origin/main', '工作树节点也写回领先/落后');
});

test('预加载：同一工作区在途只发一份请求，force 重取', async () => {
	const root = '/work/preload-b';
	let discovers = 0;
	const stubbed = stubFetch({
		discoverRepositories: () => {
			discovers += 1;
			return { command: 'discoverRepositories', nodes: [], truncated: false, usedCache: false };
		},
		loadReposSync: () => ({ command: 'loadReposSync', results: [] }),
	});
	try {
		preloadWorkspace(root);
		preloadWorkspace(root);
		preloadWorkspace(root);
		await waitFor(() => discovers >= 1);
		assert.equal(discovers, 1, '在途期间重复调用只发一份请求');

		preloadWorkspace(root, { force: true });
		await waitFor(() => discovers >= 2);
		assert.equal(discovers, 2, 'force 中止在途并重取');
	} finally {
		stubbed.restore();
		dropWorkspace(root);
	}
});

test('预加载：发现失败时状态为 error 且错误文本透出', async () => {
	const root = '/work/preload-c';
	const stubbed = stubFetch({
		discoverRepositories: () => ({ command: 'discoverRepositories', error: 'git 不可用' }),
	});
	try {
		preloadWorkspace(root);
		await waitFor(() => getWorkspaceSnapshot(root)?.status === 'error');
	} finally {
		stubbed.restore();
	}
	const snapshot = getWorkspaceSnapshot(root);
	assert.equal(snapshot.status, 'error');
	assert.equal(snapshot.error, 'git 不可用');
	dropWorkspace(root);
});

test('dropWorkspace：丢弃后快照与订阅一并清除，重新预加载重新取数', async () => {
	const root = '/work/preload-d';
	let discovers = 0;
	const stubbed = stubFetch({
		discoverRepositories: () => {
			discovers += 1;
			return { command: 'discoverRepositories', nodes: [repoNode(`${root}/r`)], truncated: false, usedCache: false };
		},
		enrichRepositories: (body) => ({ command: 'enrichRepositories', nodes: body.repos.map((path) => repoNode(path)) }),
		loadReposSync: (body) => ({ command: 'loadReposSync', results: body.repos.map((path) => ({ path, branch: 'main', upstream: null, ahead: 0, behind: 0 })) }),
	});
	try {
		preloadWorkspace(root);
		await waitFor(() => getWorkspaceSnapshot(root)?.nodes.length === 1);
		assert.notEqual(getWorkspaceSnapshot(root), null);

		dropWorkspace(root);
		assert.equal(getWorkspaceSnapshot(root), null, '丢弃后无快照');

		preloadWorkspace(root);
		await waitFor(() => discovers >= 2);
		assert.equal(discovers, 2, '重新预加载重新取数');
	} finally {
		stubbed.restore();
		dropWorkspace(root);
	}
});

test('预加载：补齐空结果按路径重试，连续失败到上限后停止', async () => {
	const root = '/work/preload-e';
	const repo = `${root}/only`;
	let enrichCalls = 0;
	const stubbed = stubFetch({
		discoverRepositories: () => ({ command: 'discoverRepositories', nodes: [repoNode(repo)], truncated: false, usedCache: false }),
		enrichRepositories: () => {
			enrichCalls += 1;
			return { command: 'enrichRepositories', nodes: [] };
		},
		loadReposSync: (body) => ({ command: 'loadReposSync', results: body.repos.map((path) => ({ path, branch: 'main', upstream: null, ahead: 0, behind: 0 })) }),
	});
	try {
		preloadWorkspace(root);
		await waitFor(() => enrichCalls > 1);
	} finally {
		stubbed.restore();
		dropWorkspace(root);
	}
	assert.ok(enrichCalls > 1, '空结果驱动重试');
	assert.ok(enrichCalls <= 6, '连续失败到上限后停止下发');
});
