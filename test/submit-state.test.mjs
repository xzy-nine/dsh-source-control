/**
 * 提交框判据：主按钮的动作、提交可用性与提交按钮的禁用状态。
 *
 * 被测模块无 React 依赖，直接从 `src/` 导入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	commitButtonDisabledOf, canSubmitOf, divergedOf, primaryActionOf,
} from '../src/client/panel/submit-state.ts';

/** 主按钮判据的缺省输入：干净工作区、无领先落后、已发布、未修补、无合并。 */
const PRIMARY_BASE = {
	workAreaEmpty: true, hasRemoteDiff: false, isUnpublishedBranch: false, amend: false, merging: false,
};

test('主按钮：合并中固定为提交', () => {
	// 合并中即使有领先落后与无改动，也不让位给同步或发布。
	assert.equal(primaryActionOf({ ...PRIMARY_BASE, merging: true, hasRemoteDiff: true }), 'commit');
	assert.equal(primaryActionOf({ ...PRIMARY_BASE, merging: true, isUnpublishedBranch: true }), 'commit');
});

test('主按钮：修补期间固定为提交', () => {
	assert.equal(primaryActionOf({ ...PRIMARY_BASE, amend: true, hasRemoteDiff: true }), 'commit');
	assert.equal(primaryActionOf({ ...PRIMARY_BASE, amend: true, isUnpublishedBranch: true }), 'commit');
});

test('主按钮：无改动时按领先落后与是否已发布切换', () => {
	assert.equal(primaryActionOf({ ...PRIMARY_BASE, hasRemoteDiff: true }), 'sync');
	assert.equal(primaryActionOf({ ...PRIMARY_BASE, isUnpublishedBranch: true }), 'publish');
	assert.equal(primaryActionOf(PRIMARY_BASE), 'commit');
});

test('主按钮：有改动时一律提交', () => {
	assert.equal(primaryActionOf({ ...PRIMARY_BASE, workAreaEmpty: false, hasRemoteDiff: true }), 'commit');
	assert.equal(primaryActionOf({ ...PRIMARY_BASE, workAreaEmpty: false, isUnpublishedBranch: true }), 'commit');
});

test('提交可用性：有暂存改动、修补或合并中', () => {
	assert.equal(canSubmitOf({ stagedCount: 1, amend: false, merging: false }), true);
	assert.equal(canSubmitOf({ stagedCount: 0, amend: true, merging: false }), true);
	assert.equal(canSubmitOf({ stagedCount: 0, amend: false, merging: true }), true);
	assert.equal(canSubmitOf({ stagedCount: 0, amend: false, merging: false }), false);
});

test('提交按钮禁用：合并中不因信息为空而禁用', () => {
	const base = { busy: false, canSubmit: true, messageEmpty: false, merging: false };
	assert.equal(commitButtonDisabledOf(base), false);
	assert.equal(commitButtonDisabledOf({ ...base, messageEmpty: true }), true);
	assert.equal(commitButtonDisabledOf({ ...base, messageEmpty: true, merging: true }), false);
	assert.equal(commitButtonDisabledOf({ ...base, busy: true }), true);
	assert.equal(commitButtonDisabledOf({ ...base, canSubmit: false }), true);
});

test('双向分叉：两侧都各有对方没有的提交', () => {
	assert.equal(divergedOf({ ahead: 2, behind: 3 }), true);
	// 只有一侧领先不是分叉：同步按键仍按普通合并/推送处理。
	assert.equal(divergedOf({ ahead: 2, behind: 0 }), false);
	assert.equal(divergedOf({ ahead: 0, behind: 3 }), false);
	assert.equal(divergedOf({ ahead: 0, behind: 0 }), false);
});
