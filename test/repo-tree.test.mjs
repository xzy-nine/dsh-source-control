/**
 * 存储库树的 children 挂载与选中规划：首屏浅层树 + 后台补齐结果如何合流。
 *
 * 面板首屏走浅层发现（只出顶层仓库），随后在空闲回调里补齐工作树与子模块，结果按仓库路径
 * 另行保存。本测试锁定三条语义，全部断言 `use-repos.ts` 实际调用的那些函数：
 * - 后台纠正用新的浅层节点整棵替换时，已补齐的 children 不得丢；
 * - 重新扫描时清掉保存的记录，children 必须变空（已删除的工作树不得残留）；
 * - 持久化选中的工作树/子模块在浅层树里找不到时记下待认领，补齐后认领回原节点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	attachChildren, claimPendingSelection, findNode, flattenVisible, ancestryOf, planSelection, selectInitial,
} from '../src/client/panel/repo-tree.ts';

/** 造一个仓库节点。 */
function repo(id, children = []) {
	return { id, path: id, name: id.split('/').pop(), kind: 'repo', depth: 0, branch: 'main', head: null, available: true, children };
}

/** 造一个工作树节点。 */
function worktree(id) {
	return { id, path: id, name: id.split('/').pop(), kind: 'worktree', depth: 1, branch: 'wt', head: 'abc1234', available: true, children: [] };
}

test('没有补齐记录时节点原样返回', () => {
	const nodes = [repo('/a')];
	const attached = attachChildren(nodes, new Map());
	assert.deepEqual(attached[0].children, []);
});

test('已补齐的 children 按仓库路径挂回浅层节点', () => {
	const children = new Map([['/a', [worktree('/a-wt')]]]);
	const attached = attachChildren([repo('/a'), repo('/b')], children);
	assert.deepEqual(attached[0].children, [worktree('/a-wt')]);
	assert.deepEqual(attached[1].children, []);
});

test('后台纠正换成新的浅层节点后 children 不丢', () => {
	const children = new Map([['/a', [worktree('/a-wt')]]]);
	// 第一次浅层结果 → 补齐 → 后台纠正又给一份新的浅层节点（对象不同、内容相同）。
	const first = attachChildren([repo('/a')], children);
	assert.deepEqual(first[0].children, [worktree('/a-wt')]);
	const corrected = attachChildren([repo('/a')], children);
	assert.deepEqual(corrected[0].children, [worktree('/a-wt')]);
});

test('补齐记录被清空后 children 变空（已删除的工作树不残留）', () => {
	const nodes = [repo('/a')];
	const before = attachChildren(nodes, new Map([['/a', [worktree('/a-wt')]]]));
	assert.equal(before[0].children.length, 1);
	// 重新扫描：保存的记录被清空。
	const after = attachChildren(nodes, new Map());
	assert.deepEqual(after[0].children, []);
});

test('节点自带 children 时原样采用，不被记录覆盖', () => {
	const nodes = [repo('/a', [worktree('/own')])];
	const attached = attachChildren(nodes, new Map([['/a', [worktree('/recorded')]]]));
	assert.deepEqual(attached[0].children, [worktree('/own')]);
});

test('挂载不修改入参节点', () => {
	const nodes = [repo('/a')];
	attachChildren(nodes, new Map([['/a', [worktree('/a-wt')]]]));
	assert.deepEqual(nodes[0].children, []);
});

test('持久化选中的工作树：浅层树找不到时记为待认领，补齐后认领回原节点', () => {
	const shallow = [repo('/a'), repo('/top')];
	const attached = attachChildren(shallow, new Map([['/a', [worktree('/a-wt')]]]));

	// 首屏：只有浅层树，worktree 节点还不存在，选中回退成第一个仓库，原 id 记为待认领。
	const shallowPlan = planSelection(shallow, '/top', '/a-wt');
	assert.equal(shallowPlan.selectedId, '/top');
	assert.equal(shallowPlan.pendingId, '/a-wt');

	// 补齐后：认领回原节点。
	const claimed = claimPendingSelection(attached, shallowPlan.pendingId);
	assert.equal(claimed?.id, '/a-wt');

	// 已存在的选中不产生待认领项。
	const direct = planSelection(attached, '/top', '/a-wt');
	assert.equal(direct.selectedId, '/a-wt');
	assert.equal(direct.pendingId, null);
});

test('补齐记录里没有待认领节点时保持首次发现的选中', () => {
	const attached = attachChildren([repo('/a'), repo('/top')], new Map());
	assert.equal(claimPendingSelection(attached, '/a-wt'), null);
});

test('无持久化选中时按工作区根选，不产生待认领项', () => {
	const plan = planSelection([repo('/a'), repo('/top')], '/top', null);
	assert.equal(plan.selectedId, '/top');
	assert.equal(plan.pendingId, null);
});

test('待认领节点补齐后出现在可见行里（展开链完整）', () => {
	const children = new Map([['/a', [worktree('/a-wt')]]]);
	const attached = attachChildren([repo('/a')], children);
	const claimed = claimPendingSelection(attached, '/a-wt');
	const expanded = new Set(ancestryOf(attached, claimed.id));
	const rows = flattenVisible(attached, expanded);
	assert.deepEqual(rows.map((row) => row.node.id), ['/a', '/a-wt']);
});

test('展开的工作树在浅层纠正后仍可见', () => {
	const children = new Map([['/a', [worktree('/a-wt')]]]);
	const attached = attachChildren([repo('/a')], children);
	const rows = flattenVisible(attached, new Set(['/a']));
	assert.deepEqual(rows.map((row) => row.node.id), ['/a', '/a-wt']);
	assert.deepEqual(ancestryOf(attached, '/a-wt'), ['/a', '/a-wt']);
	assert.equal(findNode(attached, '/a-wt')?.id, '/a-wt');
});
