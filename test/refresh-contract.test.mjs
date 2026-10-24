/**
 * 刷新路径的图形区状态契约：只取快照的刷新不得让图形区卡在 loading。
 *
 * 用 jsdom + react-dom/client 真实挂载 `useGraphData`，用可控延迟的 fetch 桩制造「提交图仍在途」
 * 的时序，再触发只取快照的刷新，断言 `phase` 最终收敛到 ready 且提交列表非空。
 *
 * 该文件依赖 devDependencies 中的 jsdom；该包无法加载时整体跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** jsdom 的 JSDOM 构造；包无法加载时为 null。 */
let JSDOM = null;
try {
	({ JSDOM } = await import('jsdom'));
} catch {
	JSDOM = null;
}
const skip = JSDOM === null ? '未安装 jsdom，跳过客户端 hook 契约' : false;

/** 稳定的设置对象：每次渲染都新建会让 refresh 回调重建并触发 effect 循环。 */
const SETTINGS = {
	commitOrdering: 'topo', showStashes: true, showTags: true, showRemoteBranches: true,
	onlyFollowFirstParent: false, includeCommitsMentionedByReflogs: false, autoRefresh: false,
};
/** 稳定的回调：同上。 */
const noop = () => {};

/** 提交图响应体。 */
const COMMITS_PAYLOAD = {
	command: 'loadCommits', error: null, onlyFollowFirstParent: false,
	commits: [{ hash: 'c1', parents: [], heads: ['main'], tags: [], remotes: [], stash: null, message: 'c1', author: 'a', email: 'a@b.c', date: 1700000000 }],
	head: 'c1', tags: [], moreCommitsAvailable: false, nextCursor: null, repoInfo: null,
};
/** 工作区快照响应体。 */
const SNAPSHOT_PAYLOAD = {
	command: 'loadWorkingTreeSnapshot', error: null,
	entries: [{ path: 'a.txt', origPath: null, index: ' ', worktree: 'M' }],
	head: 'c1', branch: 'main', upstream: null, ahead: 0, behind: 0,
};

/**
 * 安装 DOM 并挂载 `useGraphData`。
 *
 * @param initialDelays - 挂载前就要生效的命令延迟；首屏请求在 `render` 期间发出，延迟必须在挂载
 *   之前设置才能制造「首屏在途」的时序。
 * @returns 状态读取器、刷新函数与请求记录。
 */
async function mount(initialDelays = {}) {
	const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
		url: 'http://localhost/', pretendToBeVisual: true,
	});
	globalThis.window = dom.window;
	globalThis.document = dom.window.document;
	Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
	globalThis.HTMLElement = dom.window.HTMLElement;
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;

	const React = (await import(pathToFileURL(join(root, 'node_modules/react/index.js')).href)).default;
	const { createRoot } = await import(pathToFileURL(join(root, 'node_modules/react-dom/client.js')).href);
	const { useGraphData } = await import(pathToFileURL(join(root, 'src/client/panel/use-graph-data.ts')).href);
	const act = React.unstable_act ?? React.act;

	/** 请求记录与按命令配置的延迟。 */
	const calls = [];
	const delays = new Map(Object.entries(initialDelays));
	/** 当前快照条目；测试可改写以制造条目变化。 */
	const snapshot = { entries: SNAPSHOT_PAYLOAD.entries };
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push(body.command);
		const wait = delays.get(body.command) ?? 0;
		if (wait > 0) await new Promise((done) => setTimeout(done, wait));
		// 与真实 fetch 一致：请求被中止时调用方看到 AbortError，而不是拿到正常响应。
		if (init.signal?.aborted === true) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		const payload = body.command === 'loadCommits' ? COMMITS_PAYLOAD
			: body.command === 'loadWorkingTreeSnapshot' ? { ...SNAPSHOT_PAYLOAD, entries: snapshot.entries }
				: { command: body.command, error: null };
		return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
	};

	const reactRoot = createRoot(document.getElementById('root'));
	/** hook 的最新状态与函数。 */
	const latest = { state: null, refresh: null, refreshEntries: null };
	/** 当前仓库路径；测试可改写以制造换仓库。 */
	const target = { path: '/repo' };
	function Probe() {
		const result = useGraphData({
			workingTreePath: target.path, hasWorkspace: true, maxCommits: 200,
			settings: SETTINGS, selectedId: null, setSyncById: noop,
		});
		latest.state = result.state;
		latest.refresh = result.refresh;
		latest.refreshEntries = result.refreshEntries;
		return null;
	}
	await act(async () => { reactRoot.render(React.createElement(Probe)); });
	return {
		calls, delays, snapshot, latest, act, reactRoot,
		/** 换到另一个仓库并重渲染。 */
		setPath: (path) => {
			target.path = path;
			return act(async () => { reactRoot.render(React.createElement(Probe)); });
		},
	};
}

/** 推进若干毫秒并让 React 处理副作用。 */
async function settle(harness, ms) {
	await harness.act(async () => { await new Promise((done) => setTimeout(done, ms)); });
}

test('提交图在途时触发只取快照的刷新：phase 仍收敛到 ready', { skip }, async () => {
	/*
	 * 延迟必须在挂载之前设好：首屏请求在 render 期间发出，挂载完成时若首屏已就绪，`phase` 已是
	 * ready，后续无论怎么 abort 都不会 stuck —— 那样就构造不出本用例要覆盖的时序。
	 */
	const harness = await mount({ loadCommits: 600 });
	assert.equal(harness.latest.state.phase, 'loading', '挂载后首屏应仍在途');
	// 用 full 制造真实的在途窗口：它会把 phase 置 loading 并发出提交图请求。
	await harness.act(async () => {
		void harness.latest.refresh('full');
		await new Promise((done) => setTimeout(done, 20));
		assert.equal(harness.latest.state.phase, 'loading', '触发时提交图应在途');
		await harness.latest.refreshEntries();
	});
	await settle(harness, 1500);
	assert.equal(harness.latest.state.phase, 'ready', 'phase 必须收敛到 ready');
	assert.ok(harness.latest.state.commits.length > 0, '提交列表不应为空');
	await harness.act(async () => { harness.reactRoot.unmount(); });
});

test('只取快照的刷新：更新条目、不改 phase、条目未变时保持提交列表引用', { skip }, async () => {
	const harness = await mount();
	await harness.act(async () => { await harness.latest.refresh('reconcile'); });
	assert.equal(harness.latest.state.phase, 'ready');
	const commitsBefore = harness.latest.state.commits;
	await harness.act(async () => { await harness.latest.refreshEntries(); });
	assert.equal(harness.latest.state.phase, 'ready', '只取快照不改 phase');
	assert.equal(harness.latest.state.entries.length, 1);
	assert.equal(harness.latest.state.commits, commitsBefore, '条目未变时提交列表保持原引用');
	await harness.act(async () => { harness.reactRoot.unmount(); });
});

test('只取快照的刷新：条目由零变正时补出未提交行', { skip }, async () => {
	const harness = await mount();
	// 初始仓库干净：没有未提交行。
	harness.snapshot.entries = [];
	await harness.act(async () => { await harness.latest.refresh('reconcile'); });
	assert.equal(harness.latest.state.entries.length, 0);
	assert.equal(harness.latest.state.commits.some((commit) => commit.hash === '*'), false);

	// 随后产生改动：只取快照的刷新应补出未提交行。
	harness.snapshot.entries = SNAPSHOT_PAYLOAD.entries;
	await harness.act(async () => { await harness.latest.refreshEntries(); });
	assert.equal(harness.latest.state.entries.length, 1);
	const row = harness.latest.state.commits.find((commit) => commit.hash === '*');
	assert.ok(row !== undefined, '条目由零变正时必须补出未提交行');
	assert.equal(row.message, 'Uncommitted Changes (1)');
	await harness.act(async () => { harness.reactRoot.unmount(); });
});

test('reconcile 刷新：后台刷新登记在取数期间非空、结束后清空', { skip }, async () => {
	// 两路都延迟：登记在请求发出时写入，取数返回后才移除。
	const harness = await mount({ loadCommits: 200, loadWorkingTreeSnapshot: 200 });
	await settle(harness, 700);
	assert.equal(harness.latest.state.phase, 'ready');
	assert.deepEqual(harness.latest.state.background, [], '首屏收敛后不应有残留登记');

	/*
	 * 断言放在独立的 act 块里：同一 act 内的 await 之后读到的仍是进入该块时的快照，
	 * 看不到这期间的状态推进。
	 */
	await harness.act(async () => { void harness.latest.refresh('reconcile'); });
	await settle(harness, 40);
	/*
	 * 两路并行、各有 200ms 延迟，此刻都在途：两个作用面都应登记，界面据此给出指示。
	 * full 模式不登记——它改用 phase 呈现占位。
	 */
	const scopes = harness.latest.state.background.map((entry) => entry.scope).sort();
	assert.deepEqual(scopes, ['entries', 'graph'], 'reconcile 期间两个作用面都应登记');
	assert.equal(harness.latest.state.phase, 'ready', 'reconcile 不改 phase');

	await settle(harness, 700);
	assert.deepEqual(harness.latest.state.background, [], '刷新结束后登记应清空');
	assert.ok(harness.latest.state.lastRefreshAt > 0, '应记下完成时刻供「上次刷新」文案使用');
	await harness.act(async () => { harness.reactRoot.unmount(); });
});

test('full 刷新：不走后台登记，改用 phase 呈现', { skip }, async () => {
	const harness = await mount({ loadCommits: 200 });
	await settle(harness, 600);
	assert.equal(harness.latest.state.phase, 'ready');
	await harness.act(async () => { void harness.latest.refresh('full'); });
	assert.equal(harness.latest.state.phase, 'loading', 'full 模式应置加载态');
	assert.deepEqual(harness.latest.state.background, [], 'full 模式不应登记后台刷新');
	await settle(harness, 700);
	assert.equal(harness.latest.state.phase, 'ready');
	await harness.act(async () => { harness.reactRoot.unmount(); });
});

test('只取快照的刷新：登记 entries 作用面', { skip }, async () => {
	const harness = await mount({ loadWorkingTreeSnapshot: 200 });
	await settle(harness, 600);
	await harness.act(async () => { void harness.latest.refreshEntries(); });
	const scopes = harness.latest.state.background.map((entry) => entry.scope);
	assert.deepEqual(scopes, ['entries'], '只应登记 entries');
	await settle(harness, 600);
	assert.deepEqual(harness.latest.state.background, []);
	await harness.act(async () => { harness.reactRoot.unmount(); });
});

test('换仓库：取数返回前条目与提交列表已清空', { skip }, async () => {
	const harness = await mount();
	await settle(harness, 400);
	assert.equal(harness.latest.state.entries.length, 1, '初始应有一个条目');
	assert.ok(harness.latest.state.commits.length > 0, '初始应有提交');
	// 换仓库由 workingTreePath 变化触发：改探针的入参即可，fetch 桩对任意路径都给同一份数据。
	harness.delays.set('loadWorkingTreeSnapshot', 300);
	harness.delays.set('loadCommits', 300);
	await harness.setPath('/other');
	assert.deepEqual(harness.latest.state.entries, [], '取数返回前必须清空旧仓库的条目');
	assert.deepEqual(harness.latest.state.commits, [], '取数返回前必须清空旧仓库的提交列表');
	await settle(harness, 900);
	assert.equal(harness.latest.state.entries.length, 1, '取数返回后应写入新仓库的条目');
	await harness.act(async () => { harness.reactRoot.unmount(); });
});
