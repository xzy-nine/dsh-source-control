/**
 * 差异文件资源地址的测试：用 `node --test` 运行。
 *
 * 覆盖绝对路径拼接、相对路径按仓库根换算，以及工作树场景下地址不被宿主二次拼接。
 */
import assert from 'node:assert/strict';
import { parallel } from './harness.mjs';
import {
	DIFF_TITLE_TEXT, diffFileAddress, gitDiffAddress, gitDiffRequest, gitDiffTitle, parseGitDiffAddress,
} from '../src/client/diff/resource-path.ts';

const PREFIX = 'dsh-resource://file/session/';


/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('差异资源地址', (t) => {
	t.test('相对路径按仓库根拼成绝对路径', () => {
		const address = diffFileAddress('s1', 'E:/repo', 'src/a.ts');
		assert.equal(address, `${PREFIX}s1/E:/repo/src/a.ts`);
	});

	t.test('已是绝对路径的入参原样保留', () => {
		const address = diffFileAddress('s1', 'E:/repo', 'E:/other/b.ts');
		assert.equal(address, `${PREFIX}s1/E:/other/b.ts`);
	});

	t.test('Windows 反斜杠仓库根统一为斜杠', () => {
		const address = diffFileAddress('s1', 'E:\\repo\\', 'src\\a.ts');
		assert.equal(address, `${PREFIX}s1/E:/repo/src/a.ts`);
	});

	t.test('路径始终为绝对形式，宿主不会再次拼接工作区根', () => {
		// 会话工作区根与仓库根不同（选中链接工作树）时，相对路径会被宿主按自己的根再拼一次。
		const repoRoot = 'E:/main/.agents/worktrees/refactor/god-class-split';
		const address = diffFileAddress('s1', repoRoot, 'src/a.ts');
		const path = address.slice(`${PREFIX}s1/`.length);
		assert.ok(path.startsWith('E:/'), '地址中的路径应为绝对路径');
		assert.equal(path, `${repoRoot}/src/a.ts`, '仓库根只出现一次');
	});

	t.test('空文件路径返回 null', () => {
		assert.equal(diffFileAddress('s1', 'E:/repo', ''), null);
	});

	t.test('路径段中的特殊字符被转义，盘符冒号保留', () => {
		const address = diffFileAddress('s1', 'E:/repo', 'a b/c#d.ts');
		assert.equal(address, `${PREFIX}s1/E:/repo/a%20b/c%23d.ts`);
	});

	t.test('UNC 路径按绝对路径处理', () => {
		// 前缀自带一个斜杠，UNC 的前导双斜杠因此接在其后。
		const address = diffFileAddress('s1', 'E:/repo', '//server/share/a.ts');
		assert.equal(address, `${PREFIX}s1///server/share/a.ts`);
	});

	const DIFF_PREFIX = 'dsh-resource://git-diff/session/';

	t.test('工作区作用域的地址只带作用域段', () => {
		assert.equal(gitDiffAddress('s1', { kind: 'worktree', staged: false }), `${DIFF_PREFIX}s1/*`);
		assert.equal(gitDiffAddress('s1', { kind: 'worktree', staged: true }), `${DIFF_PREFIX}s1/index`);
	});

	t.test('提交与两提交对比各自成地址', () => {
		assert.equal(gitDiffAddress('s1', { kind: 'commit', hash: 'abc1234' }), `${DIFF_PREFIX}s1/abc1234`);
		assert.equal(gitDiffAddress('s1', { kind: 'compare', baseHash: 'aaa1111', hash: 'bbb2222' }), `${DIFF_PREFIX}s1/aaa1111..bbb2222`);
	});

	t.test('作用域可往返解析', () => {
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

	t.test('同一作用域下不同文件共用一个地址', () => {
		// 文件走导航参数，因此地址与文件无关：这是下拉框就地切换的前提。
		const a = gitDiffAddress('s1', { kind: 'worktree', staged: false });
		const b = gitDiffAddress('s1', { kind: 'worktree', staged: false });
		assert.equal(a, b);
	});

	t.test('旧格式地址把路径带回 legacyPath', () => {
		const parsed = parseGitDiffAddress(`${DIFF_PREFIX}s1/*/src/a.ts`);
		assert.deepEqual(parsed.scope, { kind: 'worktree', staged: false });
		assert.equal(parsed.legacyPath, 'src/a.ts');
	});

	t.test('页标题给作用域而不是文件名', () => {
		// 断言取同一份文案表：被守护的是「标题按作用域选模板」与短哈希截断，不是文案内容。
		assert.equal(gitDiffTitle({ kind: 'worktree', staged: false }), DIFF_TITLE_TEXT.worktree);
		assert.equal(gitDiffTitle({ kind: 'worktree', staged: true }), DIFF_TITLE_TEXT.staged);
		assert.equal(
			gitDiffTitle({ kind: 'commit', hash: 'abcdef1234' }),
			DIFF_TITLE_TEXT.commit.replace('{hash}', 'abcdef1'),
		);
		assert.equal(
			gitDiffTitle({ kind: 'compare', baseHash: 'aaa1111', hash: 'bbb2222' }),
			DIFF_TITLE_TEXT.compare.replace('{base}', 'aaa1111').replace('{hash}', 'bbb2222'),
		);
	});

	t.test('非 git-diff 前缀的地址解析为 null', () => {
		assert.equal(parseGitDiffAddress('dsh-resource://file/session/s1/a.ts'), null);
		assert.equal(parseGitDiffAddress(''), null);
		assert.equal(parseGitDiffAddress(undefined), null);
	});

	t.test('缺作用域段的地址解析为 null', () => {
		assert.equal(parseGitDiffAddress('dsh-resource://git-diff/session/s1'), null);
		assert.equal(parseGitDiffAddress('dsh-resource://git-diff/session/s1/'), null);
	});
	t.test('工作区作用域换算为 commitHash 与 staged', () => {
		assert.deepEqual(gitDiffRequest({ kind: 'worktree', staged: false }), { commitHash: '*', staged: false, baseHash: '' });
		assert.deepEqual(gitDiffRequest({ kind: 'worktree', staged: true }), { commitHash: '*', staged: true, baseHash: '' });
	});

	t.test('暂存区的作用域写法不当作提交哈希', () => {
		// 地址里写作 index，命令参数必须仍是 commitHash '*' 加 staged：
		// 把作用域写法直接当哈希传给后端会读不到差异。
		const request = gitDiffRequest(parseGitDiffAddress(gitDiffAddress('s1', { kind: 'worktree', staged: true })).scope);
		assert.equal(request.commitHash, '*');
		assert.equal(request.staged, true);
	});

	t.test('提交作用域换算为哈希且不取暂存区', () => {
		assert.deepEqual(gitDiffRequest({ kind: 'commit', hash: 'abc1234' }), { commitHash: 'abc1234', staged: false, baseHash: '' });
	});

	t.test('两提交对比把旧侧哈希单独给出', () => {
		assert.deepEqual(gitDiffRequest({ kind: 'compare', baseHash: 'aaa1111', hash: 'bbb2222' }), {
			commitHash: 'bbb2222', staged: false, baseHash: 'aaa1111',
		});
	});

	t.test('每个作用域换算后都能取到差异：commitHash 恒非空', () => {
		for (const scope of [
			{ kind: 'worktree', staged: false },
			{ kind: 'worktree', staged: true },
			{ kind: 'commit', hash: 'abc1234' },
			{ kind: 'compare', baseHash: 'aaa1111', hash: 'bbb2222' },
		]) {
			assert.notEqual(gitDiffRequest(scope).commitHash, '', '取数坐标必须有 commitHash');
		}
	});
});
