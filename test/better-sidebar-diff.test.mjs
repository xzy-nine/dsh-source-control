/**
 * better-sidebar 差异页接入的测试：能力探测、种子换算与打开的回退判据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	betterSidebarKnowsRepo,
	diffTitleOf,
	openDiffInBetterSidebar,
	resolveBetterSidebarDiff,
	toSidebarDiffRef,
} from '../src/client/diff/better-sidebar-diff.ts';

/** 一个可用的服务桩，记录收到的打开请求。 */
const service = (overrides = {}) => {
	const opened = [];
	return {
		opened,
		getTab: (id) => (id === 'diff' ? { id: 'diff' } : undefined),
		isTabEnabled: () => true,
		openTab: (seed, scope) => { opened.push({ seed, scope }); },
		...overrides,
	};
};

test('未装载服务时不可用', () => {
	assert.equal(resolveBetterSidebarDiff(undefined), null);
	assert.equal(resolveBetterSidebarDiff(null), null);
	assert.equal(resolveBetterSidebarDiff({}), null);
	assert.equal(resolveBetterSidebarDiff({ openTab: () => {} }), null);
});

test('diff 类型未注册时不可用', () => {
	// openTab 对未注册类型是静默 no-op，因此必须能确认类型已注册。
	assert.equal(resolveBetterSidebarDiff(service({ getTab: () => undefined })), null);
});

test('diff 类型被设置页关闭时不可用', () => {
	assert.equal(resolveBetterSidebarDiff(service({ isTabEnabled: () => false })), null);
	// 缺 isTabEnabled 时视为启用。
	assert.notEqual(resolveBetterSidebarDiff(service({ isTabEnabled: undefined })), null);
});

test('getTab 抛错时不可用而不是向外抛', () => {
	assert.equal(resolveBetterSidebarDiff(service({ getTab: () => { throw new Error('boom'); } })), null);
});

test('工作区差异换算为 worktree 引用', () => {
	assert.deepEqual(
		toSidebarDiffRef({ kind: 'worktree', path: 'src/a.ts', staged: true, repoRoot: 'E:/w' }),
		{ kind: 'worktree', path: 'src/a.ts', staged: true, repoRoot: 'E:/w' },
	);
});

test('未跟踪工作区差异带上 untracked 标记', () => {
	assert.deepEqual(
		toSidebarDiffRef({ kind: 'worktree', path: 'a.ts', staged: false, untracked: true }),
		{ kind: 'worktree', path: 'a.ts', staged: false, untracked: true },
	);
});

test('提交差异换算为整提交补丁引用', () => {
	assert.deepEqual(
		toSidebarDiffRef({ kind: 'commit', path: 'a.ts', hash: 'abc1234', hashFull: 'abc1234def', subject: 'fix: x' }),
		{ kind: 'commit', hash: 'abc1234', hashFull: 'abc1234def', subject: 'fix: x' },
	);
});

test('缺完整哈希时用短哈希兜底，缺标题时用路径', () => {
	assert.deepEqual(
		toSidebarDiffRef({ kind: 'commit', path: 'a.ts', hash: 'abc1234' }),
		{ kind: 'commit', hash: 'abc1234', hashFull: 'abc1234', subject: 'a.ts' },
	);
});

test('两提交区间对比没有等价引用', () => {
	// better-sidebar 的引用没有旧侧哈希字段，近似会显示成另一段差异。
	assert.equal(toSidebarDiffRef({ kind: 'commit', path: 'a.ts', hash: 'b', baseHash: 'a' }), null);
});

test('非差异与缺路径的目标不换算', () => {
	assert.equal(toSidebarDiffRef({ kind: 'file', path: 'a.ts' }), null);
	assert.equal(toSidebarDiffRef({ kind: 'worktree' }), null);
	assert.equal(toSidebarDiffRef(null), null);
});

test('标题区分工作区与提交差异', () => {
	assert.equal(diffTitleOf({ kind: 'worktree', path: 'src/a/b.ts', staged: false }), 'b.ts');
	assert.equal(diffTitleOf({ kind: 'commit', hash: 'abc1234', hashFull: 'x', subject: 'fix: x' }), 'abc1234 fix: x');
});

test('可用时把差异交给 better-sidebar 并带上会话作用域', () => {
	const stub = service();
	const ok = openDiffInBetterSidebar(
		resolveBetterSidebarDiff(stub),
		{ kind: 'worktree', path: 'src/a.ts', staged: false, repoRoot: 'E:/w/repo' },
		{ sessionId: 's1', cwd: 'E:/w' },
	);
	assert.equal(ok, true);
	assert.equal(stub.opened.length, 1);
	assert.deepEqual(stub.opened[0].seed.diff, { kind: 'worktree', path: 'src/a.ts', staged: false, repoRoot: 'E:/w/repo' });
	assert.deepEqual(stub.opened[0].scope, { sessionId: 's1', cwd: 'E:/w' });
});

test('换算不出或服务缺失时报告回退', () => {
	const stub = service();
	assert.equal(openDiffInBetterSidebar(resolveBetterSidebarDiff(stub), { kind: 'commit', path: 'a.ts', hash: 'b', baseHash: 'a', repoRoot: 'E:/w/repo' }, { sessionId: 's1', cwd: 'E:/w' }), false);
	assert.equal(openDiffInBetterSidebar(null, { kind: 'worktree', path: 'a.ts', staged: false, repoRoot: 'E:/w/repo' }, { sessionId: 's1', cwd: 'E:/w' }), false);
	assert.equal(stub.opened.length, 0);
});

test('openTab 抛错时报告回退而不是向外抛', () => {
	const stub = service({ openTab: () => { throw new Error('boom'); } });
	assert.equal(
		openDiffInBetterSidebar(resolveBetterSidebarDiff(stub), { kind: 'worktree', path: 'a.ts', staged: false, repoRoot: 'E:/w/repo' }, { sessionId: 's1', cwd: 'E:/w' }),
		false,
	);
});

test('只把工作区根本身与其直接子目录仓库交给 better-sidebar', () => {
	// 它的仓库发现只覆盖这两层；更深时它会静默回退到发现列表的第一项，
	// 差异于是落在别的仓库上（工作区差异显示无差异、提交差异报 bad object）。
	const ws = 'E:/GitHubCode/02DSH';
	assert.equal(betterSidebarKnowsRepo(ws, ws), true, '工作区根本身');
	assert.equal(betterSidebarKnowsRepo(ws, 'E:/GitHubCode/02DSH/deepseek-harness'), true, '直接子目录仓库');
	assert.equal(betterSidebarKnowsRepo(ws, 'E:/GitHubCode/02DSH/dshPlugins/dsh-source-control'), false, '孙目录仓库');
	assert.equal(betterSidebarKnowsRepo(ws, 'E:/GitHubCode/02DSH/dshPlugins/a/b/c'), false, '更深层仓库');
	assert.equal(betterSidebarKnowsRepo(ws, 'E:/GitHubCode/other'), false, '工作区之外的仓库');
	// 分隔符与尾斜杠的写法不影响判定。
	assert.equal(betterSidebarKnowsRepo('E:\\GitHubCode\\02DSH\\', 'E:/GitHubCode/02DSH/deepseek-harness'), true);
	assert.equal(betterSidebarKnowsRepo(undefined, 'E:/w'), false, '工作区根未知');
	assert.equal(betterSidebarKnowsRepo(ws, undefined), false, '仓库根未知');
	// 前缀相同但不是子路径的目录不算子目录。
	assert.equal(betterSidebarKnowsRepo('E:/w', 'E:/w-other/repo'), false);
});

test('仓库根过深时回退而不是交给 better-sidebar', () => {
	const stub = service();
	const ok = openDiffInBetterSidebar(
		resolveBetterSidebarDiff(stub),
		{ kind: 'worktree', path: 'src/a.ts', staged: false, repoRoot: 'E:/GitHubCode/02DSH/dshPlugins/dsh-source-control' },
		{ sessionId: 's1', cwd: 'E:/GitHubCode/02DSH' },
	);
	assert.equal(ok, false, '孙目录仓库应回退');
	assert.equal(stub.opened.length, 0, '不应向 better-sidebar 发起打开');
	// 直接子目录仓库仍交给它。
	const ok2 = openDiffInBetterSidebar(
		resolveBetterSidebarDiff(stub),
		{ kind: 'worktree', path: 'src/a.ts', staged: false, repoRoot: 'E:/GitHubCode/02DSH/deepseek-harness' },
		{ sessionId: 's1', cwd: 'E:/GitHubCode/02DSH' },
	);
	assert.equal(ok2, true);
	assert.equal(stub.opened.length, 1);
});
