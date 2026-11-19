/**
 * 变更分组与冲突动作的纯函数测试：分组白名单、七种冲突种类、动作可用性。
 *
 * 判据来自 git 的 `status --porcelain` 两列语义：未合并条目只会是七种组合之一，
 * 而「暂存的更改」与「更改」两组只认各自的普通码，冲突因此不会重复出现。
 */
import assert from 'node:assert/strict';
import { parallel } from './harness.mjs';
import {
	conflictActionsOf, conflictCodeOf, conflictGroupsOf, conflictKindOf,
	indexGroupOf, isUnmerged, stagedCountOf, unresolvedConflictCountOf, worktreeGroupOf,
} from '../src/client/panel/conflicts.ts';
import {
	CONFLICT_KIND_CODE, CONFLICT_KINDS, conflictKindOfPair, hasConflictMarkers,
} from '../src/shared/conflict-kind.ts';

/** 造一个条目。 */
const entry = (path, index, worktree) => ({ path, index, worktree });

/** 七种未合并组合。 */
const UNMERGED = ['UU', 'AA', 'AU', 'UA', 'DU', 'UD', 'DD'];

/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('变更分组与冲突', (t) => {
	t.test('七种未合并组合各自映射到一种冲突种类', () => {
		const kinds = new Set(UNMERGED.map((code) => conflictKindOfPair(code[0], code[1])));
		assert.equal(kinds.size, 7, '七种组合必须落到七种不同的种类');
		for (const kind of kinds) assert.equal(CONFLICT_KIND_CODE[kind] !== undefined, true, '每种种类都要能反推回两列码');
	});

	t.test('普通改动不是冲突', () => {
		for (const [index, worktree] of [['M', ' '], [' ', 'M'], ['?', '?'], ['A', ' '], ['R', ' '], [' ', 'D']]) {
			assert.equal(conflictKindOfPair(index, worktree), null, `${index}${worktree} 不应算冲突`);
		}
		assert.deepEqual(Object.keys(CONFLICT_KINDS).sort(), [...UNMERGED].sort(), '映射表只含七种组合');
	});

	t.test('冲突条目只进合并冲突组，不进暂存与未暂存两组', () => {
		for (const code of UNMERGED) {
			const item = entry('f.txt', code[0], code[1]);
			assert.equal(isUnmerged(item), true, `${code} 应判为未合并`);
			assert.equal(indexGroupOf(item), false, `${code} 不应进「暂存的更改」`);
			assert.equal(worktreeGroupOf(item), false, `${code} 不应进「更改」`);
		}
	});

	t.test('普通条目按白名单落进对应组', () => {
		assert.equal(indexGroupOf(entry('a', 'M', ' ')), true);
		assert.equal(indexGroupOf(entry('a', 'A', ' ')), true);
		assert.equal(worktreeGroupOf(entry('a', ' ', 'M')), true);
		assert.equal(worktreeGroupOf(entry('a', '?', '?')), true);
		assert.equal(indexGroupOf(entry('a', '?', '?')), false, '未跟踪不算已暂存');
		assert.equal(worktreeGroupOf(entry('a', 'M', ' ')), false, '只有索引改动时不算工作区改动');
	});

	t.test('混合列表按组拆开', () => {
		const groups = conflictGroupsOf([
			entry('c.txt', 'U', 'U'),
			entry('s.txt', 'M', ' '),
			entry('w.txt', ' ', 'M'),
			entry('both.txt', 'M', 'M'),
		]);
		assert.deepEqual(groups.conflicts.map((item) => item.path), ['c.txt']);
		assert.deepEqual(groups.staged.map((item) => item.path), ['s.txt', 'both.txt']);
		assert.deepEqual(groups.unstaged.map((item) => item.path), ['w.txt', 'both.txt'], '既有暂存又有工作区改动的条目两组都进');
	});

	t.test('已暂存计数不含未合并条目', () => {
		assert.equal(stagedCountOf([entry('c', 'U', 'U'), entry('s', 'M', ' ')]), 1);
		assert.equal(unresolvedConflictCountOf([entry('c', 'U', 'U'), entry('d', 'A', 'A')]), 2);
	});

	t.test('采用我方/对方按阶段可用，缺一侧时禁用', () => {
		const both = entry('f', 'U', 'U');
		const full = conflictActionsOf(both, { base: true, ours: true, theirs: true });
		assert.deepEqual(full.filter((item) => item.enabled).map((item) => item.action), ['ours', 'theirs', 'markResolved', 'restoreMarkers']);

		const theirsOnly = conflictActionsOf(entry('d', 'D', 'U'), { base: true, ours: false, theirs: true });
		assert.equal(theirsOnly.find((item) => item.action === 'ours'), undefined, '我方已删除时「采用我方」不出现');
		assert.equal(theirsOnly.find((item) => item.action === 'theirs')?.enabled, true);
		assert.equal(theirsOnly.find((item) => item.action === 'delete')?.enabled, true);

		const unknown = conflictActionsOf(both, null);
		assert.deepEqual(unknown.filter((item) => item.enabled).map((item) => item.action), ['markResolved'], '阶段未知时只保留不需要阶段判定的动作');
	});

	t.test('双方都删只留标记已解决', () => {
		const items = conflictActionsOf(entry('f', 'D', 'D'), { base: true, ours: false, theirs: false });
		assert.deepEqual(items.map((item) => item.action), ['markResolved']);
	});

	t.test('状态字符对冲突条目显示两列原码', () => {
		assert.equal(conflictCodeOf(entry('f', 'U', 'U')), 'UU');
		assert.equal(conflictCodeOf(entry('f', 'D', 'U')), 'DU');
		assert.equal(conflictKindOf(entry('f', 'U', 'U')), 'both-modified');
		assert.equal(conflictKindOf(entry('f', 'M', ' ')), null);
	});

	t.test('冲突标记检测认三种标记行', () => {
		assert.equal(hasConflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> side\n'), true);
		assert.equal(hasConflictMarkers('a\n=======\nb\n'), true, '整行七等号即分隔行');
		assert.equal(hasConflictMarkers('a\nb\nc\n'), false);
		assert.equal(hasConflictMarkers('x <<<<<<< 缩进不算\n'), false, '标记行必须行首');
	});
});
