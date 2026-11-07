/**
 * 分区空态判据的回归：没有仓库、选中节点不可用时三个分区显示什么。
 *
 * 判据是纯函数，直接由 `src/` 导入 `.ts`。
 */
import { parallel } from './harness.mjs';
import assert from 'node:assert/strict';
import { workspaceEmptyOf } from '../src/client/panel/workspace-empty.ts';

/** 造一个节点。 */
function node(kind, available, path = '/ws/sub') {
	return { id: path, path, name: path.split('/').pop(), kind, depth: 1, branch: 'main', head: null, available, children: [] };
}

/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('分区空态判据', (t) => {
	t.test('工作区里没有仓库时给出初始化入口', () => {
		const empty = workspaceEmptyOf({ hasWorkspace: true, treeLoading: false, selectedNode: null, workspaceIsRepo: false });
		assert.equal(empty?.actionKind, 'init-workspace');
		assert.equal(empty?.action, '初始化仓库');
		assert.equal(empty?.path, '');
	});

	t.test('仓库树仍在发现时不显示空态', () => {
		assert.equal(workspaceEmptyOf({ hasWorkspace: true, treeLoading: true, selectedNode: null, workspaceIsRepo: false }), null);
	});

	t.test('工作区根本身是仓库时不显示空态', () => {
		assert.equal(workspaceEmptyOf({ hasWorkspace: true, treeLoading: false, selectedNode: null, workspaceIsRepo: true }), null);
	});

	t.test('选中未检出的子模块时给出初始化入口', () => {
		const empty = workspaceEmptyOf({ hasWorkspace: true, treeLoading: false, selectedNode: node('submodule', false), workspaceIsRepo: false });
		assert.equal(empty?.actionKind, 'init-submodule');
		assert.equal(empty?.action, '初始化子模块');
		assert.equal(empty?.path, '/ws/sub');
	});

	t.test('选中已检出的子模块时照常渲染', () => {
		assert.equal(workspaceEmptyOf({ hasWorkspace: true, treeLoading: false, selectedNode: node('submodule', true), workspaceIsRepo: false }), null);
	});

	t.test('选中已删除的工作树时说明原因且不给动作', () => {
		const empty = workspaceEmptyOf({ hasWorkspace: true, treeLoading: false, selectedNode: node('worktree', false), workspaceIsRepo: false });
		assert.equal(empty?.actionKind, 'none');
		assert.equal(empty?.action, null);
		assert.match(empty?.title ?? '', /不在磁盘上/);
	});

	t.test('没有工作区的会话不显示空态', () => {
		assert.equal(workspaceEmptyOf({ hasWorkspace: false, treeLoading: false, selectedNode: null, workspaceIsRepo: false }), null);
	});
});
