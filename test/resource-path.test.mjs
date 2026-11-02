/**
 * 差异文件资源地址的测试：用 `node --test` 运行。
 *
 * 覆盖绝对路径拼接、相对路径按仓库根换算，以及工作树场景下地址不被宿主二次拼接。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffFileAddress, gitDiffAddress, gitDiffRequest, gitDiffTitle, parseGitDiffAddress } from '../src/client/diff/resource-path.ts';

const PREFIX = 'dsh-resource://file/session/';

test('相对路径按仓库根拼成绝对路径', () => {
	const address = diffFileAddress('s1', 'E:/repo', 'src/a.ts');
	assert.equal(address, `${PREFIX}s1/E:/repo/src/a.ts`);
});

test('已是绝对路径的入参原样保留', () => {
	const address = diffFileAddress('s1', 'E:/repo', 'E:/other/b.ts');
	assert.equal(address, `${PREFIX}s1/E:/other/b.ts`);
});

test('Windows 反斜杠仓库根统一为斜杠', () => {
	const address = diffFileAddress('s1', 'E:\\repo\\', 'src\\a.ts');
	assert.equal(address, `${PREFIX}s1/E:/repo/src/a.ts`);
});

test('路径始终为绝对形式，宿主不会再次拼接工作区根', () => {
	// 会话工作区根与仓库根不同（选中链接工作树）时，相对路径会被宿主按自己的根再拼一次。
	const repoRoot = 'E:/main/.agents/worktrees/refactor/god-class-split';
	const address = diffFileAddress('s1', repoRoot, 'src/a.ts');
	const path = address.slice(`${PREFIX}s1/`.length);
	assert.ok(path.startsWith('E:/'), '地址中的路径应为绝对路径');
	assert.equal(path, `${repoRoot}/src/a.ts`, '仓库根只出现一次');
});

test('空文件路径返回 null', () => {
	assert.equal(diffFileAddress('s1', 'E:/repo', ''), null);
});

test('路径段中的特殊字符被转义，盘符冒号保留', () => {
	const address = diffFileAddress('s1', 'E:/repo', 'a b/c#d.ts');
	assert.equal(address, `${PREFIX}s1/E:/repo/a%20b/c%23d.ts`);
});

test('UNC 路径按绝对路径处理', () => {
	// 前缀自带一个斜杠，UNC 的前导双斜杠因此接在其后。
	const address = diffFileAddress('s1', 'E:/repo', '//server/share/a.ts');
	assert.equal(address, `${PREFIX}s1///server/share/a.ts`);
});

const DIFF_PREFIX = 'dsh-resource://git-diff/session/';

test('工作区作用域的地址只带作用域段', () => {
	assert.equal(gitDiffAddress('s1', { kind: 'worktree', staged: false }), `${DIFF_PREFIX}s1/*`);
	assert.equal(gitDiffAddress('s1', { kind: 'worktree', staged: true }), `${DIFF_PREFIX}s1/index`);
});

test('提交与两提交对比各自成地址', () => {
	assert.equal(gitDiffAddress('s1', { kind: 'commit', hash: 'abc1234' }), `${DIFF_PREFIX}s1/abc1234`);
	assert.equal(gitDiffAddress('s1', { kind: 'compare', baseHash: 'aaa1111', hash: 'bbb2222' }), `${DIFF_PREFIX}s1/aaa1111..bbb2222`);
});

test('作用域可往返解析', () => {
	const cases = [
		{ kind: 'worktree', staged: false },
		{ kind: 'worktree', staged: true },
		{ kind: 'commit', hash: 'abc1234' },
		{ kind: 'compare', baseHash: 'aaa1111', hash: 'bbb2222' },
	];
	for (const scope of cases) {
		const parsed = parseGitDiffAddress(gitDiffAddress('s1', scope));
		assert.equal(parsed.sessionId, 's1');
		assert.deepEqual(parsed.scope, scope);
		assert.equal(parsed.legacyPath, '', '新格式不带路径');
	}
});

test('同一作用域下不同文件共用一个地址', () => {
	// 文件走导航参数，因此地址与文件无关：这是下拉框就地切换的前提。
	const a = gitDiffAddress('s1', { kind: 'worktree', staged: false });
	const b = gitDiffAddress('s1', { kind: 'worktree', staged: false });
	assert.equal(a, b);
});

test('旧格式地址把路径带回 legacyPath', () => {
	const parsed = parseGitDiffAddress(`${DIFF_PREFIX}s1/*/src/a.ts`);
	assert.deepEqual(parsed.scope, { kind: 'worktree', staged: false });
	assert.equal(parsed.legacyPath, 'src/a.ts');
});

test('页标题给作用域而不是文件名', () => {
	assert.equal(gitDiffTitle({ kind: 'worktree', staged: false }), '更改');
	assert.equal(gitDiffTitle({ kind: 'worktree', staged: true }), '暂存的更改');
	assert.equal(gitDiffTitle({ kind: 'commit', hash: 'abcdef1234' }), '提交 abcdef1');
	assert.equal(gitDiffTitle({ kind: 'compare', baseHash: 'aaa1111', hash: 'bbb2222' }), '对比 aaa1111 → bbb2222');
});

test('非 git-diff 前缀的地址解析为 null', () => {
	assert.equal(parseGitDiffAddress('dsh-resource://file/session/s1/a.ts'), null);
	assert.equal(parseGitDiffAddress(''), null);
	assert.equal(parseGitDiffAddress(undefined), null);
});

test('缺作用域段的地址解析为 null', () => {
	assert.equal(parseGitDiffAddress('dsh-resource://git-diff/session/s1'), null);
	assert.equal(parseGitDiffAddress('dsh-resource://git-diff/session/s1/'), null);
});
test('工作区作用域换算为 commitHash 与 staged', () => {
	assert.deepEqual(gitDiffRequest({ kind: 'worktree', staged: false }), { commitHash: '*', staged: false, baseHash: '' });
	assert.deepEqual(gitDiffRequest({ kind: 'worktree', staged: true }), { commitHash: '*', staged: true, baseHash: '' });
});

test('暂存区的作用域写法不当作提交哈希', () => {
	// 地址里写作 index，命令参数必须仍是 commitHash '*' 加 staged：
	// 把作用域写法直接当哈希传给后端会读不到差异。
	const request = gitDiffRequest(parseGitDiffAddress(gitDiffAddress('s1', { kind: 'worktree', staged: true })).scope);
	assert.equal(request.commitHash, '*');
	assert.equal(request.staged, true);
});

test('提交作用域换算为哈希且不取暂存区', () => {
	assert.deepEqual(gitDiffRequest({ kind: 'commit', hash: 'abc1234' }), { commitHash: 'abc1234', staged: false, baseHash: '' });
});

test('两提交对比把旧侧哈希单独给出', () => {
	assert.deepEqual(gitDiffRequest({ kind: 'compare', baseHash: 'aaa1111', hash: 'bbb2222' }), {
		commitHash: 'bbb2222', staged: false, baseHash: 'aaa1111',
	});
});

test('每个作用域换算后都能取到差异：commitHash 恒非空', () => {
	for (const scope of [
		{ kind: 'worktree', staged: false },
		{ kind: 'worktree', staged: true },
		{ kind: 'commit', hash: 'abc1234' },
		{ kind: 'compare', baseHash: 'aaa1111', hash: 'bbb2222' },
	]) {
		assert.notEqual(gitDiffRequest(scope).commitHash, '', '取数坐标必须有 commitHash');
	}
});
