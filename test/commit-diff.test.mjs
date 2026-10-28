/**
 * 提交与工作区条目的逐字段比对：用 `node --test` 运行。
 *
 * 覆盖刷新短路所依赖的判据：哪些字段变化必须判不等，哪些展示字段变化不影响判等。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	commitsEqual, commitsListEqual, entriesEqual, logCommitCountOf, mergeCommits, mergeEntries,
	remotesListEqual, uncommittedParentOf, withUncommittedCount,
} from '../src/client/panel/commit-diff.ts';

/** 构造一条带全部比对字段的提交。 */
const commit = (overrides = {}) => ({
	hash: 'a1', parents: ['p1', 'p2'], heads: ['main'], tags: [{ name: 'v1', annotated: true }],
	remotes: [{ name: 'origin/main', remote: 'origin' }], stash: { selector: 'refs/stash@{0}' },
	message: 'msg', author: 'author', email: 'a@b.c', date: 1700000000,
	...overrides,
});

/** 构造一个工作区条目。 */
const entry = (overrides = {}) => ({ path: 'a.txt', origPath: null, index: ' ', worktree: 'M', ...overrides });

test('日志记录计数：未提交伪提交行不计入', () => {
	assert.equal(logCommitCountOf([]), 0);
	assert.equal(logCommitCountOf([commit()]), 1);
	// 未提交伪提交行总在最前，计数时跳过。
	assert.equal(logCommitCountOf([commit({ hash: '*' }), commit(), commit({ hash: 'b2' })]), 2);
});

test('完全相同的两条提交判等', () => {
	assert.equal(commitsEqual(commit(), commit()), true);
});

test('hash 变化判不等', () => {
	assert.equal(commitsEqual(commit(), commit({ hash: 'b2' })), false);
});

test('parents 变化判不等，且顺序敏感', () => {
	assert.equal(commitsEqual(commit(), commit({ parents: ['p1'] })), false);
	assert.equal(commitsEqual(commit(), commit({ parents: ['p2', 'p1'] })), false);
});

test('heads 变化判不等，且顺序敏感', () => {
	assert.equal(commitsEqual(commit(), commit({ heads: ['main', 'feature'] })), false);
	assert.equal(commitsEqual(commit({ heads: ['a', 'b'] }), commit({ heads: ['b', 'a'] })), false);
});

test('tags 按 name 与 annotated 比对', () => {
	assert.equal(commitsEqual(commit(), commit({ tags: [{ name: 'v2', annotated: true }] })), false);
	assert.equal(commitsEqual(commit(), commit({ tags: [{ name: 'v1', annotated: false }] })), false);
	assert.equal(commitsEqual(commit(), commit({ tags: [] })), false);
});

test('remotes 按 name 与 remote 比对', () => {
	assert.equal(commitsEqual(commit(), commit({ remotes: [{ name: 'origin/dev', remote: 'origin' }] })), false);
	assert.equal(commitsEqual(commit(), commit({ remotes: [{ name: 'origin/main', remote: 'upstream' }] })), false);
	assert.equal(commitsEqual(commit(), commit({ remotes: [] })), false);
});

test('stash 两侧 null 判等，selector 不同判不等，一侧有判不等', () => {
	assert.equal(commitsEqual(commit({ stash: null }), commit({ stash: null })), true);
	assert.equal(commitsEqual(commit({ stash: undefined }), commit({ stash: null })), true);
	assert.equal(commitsEqual(commit(), commit({ stash: { selector: 'refs/stash@{1}' } })), false);
	assert.equal(commitsEqual(commit(), commit({ stash: null })), false);
	assert.equal(commitsEqual(commit({ stash: null }), commit()), false);
});

test('展示字段不影响判等', () => {
	assert.equal(commitsEqual(commit(), commit({ message: 'other', author: 'b', email: 'x@y.z', date: 1 })), true);
});

test('缺失的可选字段按空处理', () => {
	const bare = { hash: 'a1' };
	assert.equal(commitsEqual(bare, { hash: 'a1', parents: [], heads: [], tags: [], remotes: [], stash: null }), true);
});

test('提交列表：长度不同判不等，逐条比对', () => {
	const list = [commit(), commit({ hash: 'b2' })];
	assert.equal(commitsListEqual(list, list), true);
	assert.equal(commitsListEqual(list, [commit()]), false);
	assert.equal(commitsListEqual(list, [commit(), commit()]), false);
	assert.equal(commitsListEqual([], []), true);
});

test('提交列表：同一引用直接判等', () => {
	const list = [commit()];
	assert.equal(commitsListEqual(list, list), true);
});

test('远程列表：name / url / pushUrl 各自变化判不等', () => {
	const list = [{ name: 'origin', url: 'https://example.com/o.git', pushUrl: null }];
	assert.equal(remotesListEqual(list, [{ name: 'origin', url: 'https://example.com/o.git', pushUrl: null }]), true);
	assert.equal(remotesListEqual(list, [{ name: 'upstream', url: 'https://example.com/o.git', pushUrl: null }]), false);
	assert.equal(remotesListEqual(list, [{ name: 'origin', url: 'https://example.com/u.git', pushUrl: null }]), false);
	assert.equal(remotesListEqual(list, [{ name: 'origin', url: 'https://example.com/o.git', pushUrl: 'git@x:o' }]), false);
	assert.equal(remotesListEqual(list, []), false);
});

test('工作区条目：四个字段各自变化判不等', () => {
	const list = [entry(), entry({ path: 'b.txt', worktree: ' ' })];
	assert.equal(entriesEqual(list, [entry(), entry({ path: 'b.txt', worktree: ' ' })]), true);
	assert.equal(entriesEqual(list, [entry({ path: 'c.txt' }), entry({ path: 'b.txt', worktree: ' ' })]), false);
	assert.equal(entriesEqual(list, [entry({ index: 'M' }), entry({ path: 'b.txt', worktree: ' ' })]), false);
	assert.equal(entriesEqual(list, [entry({ worktree: ' ' }), entry({ path: 'b.txt', worktree: ' ' })]), false);
	assert.equal(entriesEqual(list, [entry({ origPath: 'z.txt' }), entry({ path: 'b.txt', worktree: ' ' })]), false);
});

test('工作区条目：顺序变化判不等，长度不同判不等', () => {
	const first = entry({ path: 'a.txt' });
	const second = entry({ path: 'b.txt' });
	assert.equal(entriesEqual([first, second], [second, first]), false);
	assert.equal(entriesEqual([first], [first, second]), false);
	assert.equal(entriesEqual([], []), true);
});

test('工作区条目：origPath 的 null 与缺失等价', () => {
	assert.equal(entriesEqual([{ path: 'a.txt', index: ' ', worktree: 'M' }], [entry({ origPath: null })]), true);
});

test('伪提交行：条目数变化时改写文案，未变时保持原引用', () => {
	const plain = commit({ hash: 'c1' });
	const uncommitted = { hash: '*', parents: ['c1'], heads: [], tags: [], remotes: [], stash: null, message: 'Uncommitted Changes (2)' };
	const list = [uncommitted, plain];

	// 数量未变：原引用返回，不触发重渲染。
	assert.equal(withUncommittedCount(list, 2, 'c1'), list);
	// 数量变化：改写文案，其余行保持原引用。
	const changed = withUncommittedCount(list, 5, 'c1');
	assert.equal(changed[0].message, 'Uncommitted Changes (5)');
	assert.equal(changed[1], plain);
	assert.notEqual(changed, list);
});

test('伪提交行：条目清空时去掉该行', () => {
	const uncommitted = { hash: '*', parents: ['c1'], heads: [], tags: [], remotes: [], stash: null, message: 'Uncommitted Changes (1)' };
	const plain = commit({ hash: 'c1' });
	assert.deepEqual(withUncommittedCount([uncommitted, plain], 0, 'c1'), [plain]);
	// 本就没有该行时原样返回。
	const list = [plain];
	assert.equal(withUncommittedCount(list, 0, 'c1'), list);
});

test('伪提交行：条目数由零变正时补出该行', () => {
	const plain = commit({ hash: 'c1' });
	const list = [plain];
	const added = withUncommittedCount(list, 3, 'c1');
	assert.equal(added.length, 2);
	assert.equal(added[0].hash, '*');
	assert.deepEqual(added[0].parents, ['c1']);
	assert.equal(added[0].message, 'Uncommitted Changes (3)');
	// 原有提交保持原引用。
	assert.equal(added[1], plain);
	// 没有 HEAD 时无法给出父提交，保持原样。
	assert.equal(withUncommittedCount(list, 3, null), list);
});

test('伪提交行：已有该行时补出逻辑不重复插入', () => {
	const uncommitted = { hash: '*', parents: ['c1'], heads: [], tags: [], remotes: [], stash: null, message: 'Uncommitted Changes (1)' };
	const plain = commit({ hash: 'c1' });
	const list = [uncommitted, plain];
	const next = withUncommittedCount(list, 4, 'c1');
	assert.equal(next.length, 2);
	assert.equal(next[0].message, 'Uncommitted Changes (4)');
});

test('伪提交行的父提交必须已在列表中，否则不补出该行', () => {
	const plain = commit({ hash: 'c1' });
	const list = [plain];

	// 在列表中：可作为父提交。
	assert.equal(uncommittedParentOf(list, 'c1'), 'c1');
	// 不在列表中（快照与列表读自不同时刻）：不可作为父提交，补出会让泳道断线。
	assert.equal(uncommittedParentOf(list, 'moved'), null);
	assert.equal(uncommittedParentOf(list, null), null);
	assert.equal(uncommittedParentOf(list, undefined), null);
	assert.equal(uncommittedParentOf(list, ''), null);

	// 判据与补出联动：父提交不可用时保持原列表引用。
	assert.equal(withUncommittedCount(list, 3, uncommittedParentOf(list, 'moved')), list);
	assert.notEqual(withUncommittedCount(list, 3, uncommittedParentOf(list, 'c1')), list);
});

test('mergeCommits：未变化的提交复用上一份的对象，变化的替换', () => {
	const previous = [commit({ hash: 'c3' }), commit({ hash: 'c2' }), commit({ hash: 'c1' })];
	const changedC2 = commit({ hash: 'c2', heads: ['dev'] });
	const next = [commit({ hash: 'c4' }), previous[0], changedC2, previous[2]];
	const merged = mergeCommits(previous, next);
	assert.notEqual(merged, next, '总是返回新数组');
	assert.deepEqual(merged.map((item) => item.hash), ['c4', 'c3', 'c2', 'c1'], '顺序取新列表');
	assert.equal(merged[0], next[0], '新出现的提交用新对象');
	assert.equal(merged[1], previous[0], '未变化的提交复用上一份');
	assert.equal(merged[2], changedC2, '变化的提交用新对象');
	assert.equal(merged[3], previous[2]);
});

test('mergeCommits：上一份为空时返回新列表的副本', () => {
	const next = [commit()];
	const merged = mergeCommits([], next);
	assert.deepEqual(merged, next);
	assert.notEqual(merged, next);
});

test('mergeEntries：按路径复用，四字段全等才算未变', () => {
	const previous = [entry({ path: 'a.txt' }), entry({ path: 'b.txt', index: 'M', worktree: ' ' })];
	const changed = entry({ path: 'a.txt', worktree: 'A' });
	const sameStaged = entry({ path: 'b.txt', index: 'M', worktree: ' ' });
	const next = [changed, sameStaged, entry({ path: 'c.txt', index: '?', worktree: '?' })];
	const merged = mergeEntries(previous, next);
	assert.notEqual(merged, next, '总是返回新数组');
	assert.equal(merged[0], next[0], '状态变化的条目用新对象');
	assert.equal(merged[1], previous[1], '未变化的条目复用上一份');
	assert.equal(merged[2], next[2], '新条目用新对象');
});

test('mergeEntries：重命名的条目按当前路径与原型路径成键', () => {
	const renamed = entry({ path: 'new.txt', origPath: 'old.txt', index: 'R', worktree: ' ' });
	const same = entry({ path: 'new.txt', origPath: 'old.txt', index: 'R', worktree: ' ' });
	const merged = mergeEntries([renamed], [same]);
	assert.equal(merged[0], renamed, '两条路径都相同才复用');
});
