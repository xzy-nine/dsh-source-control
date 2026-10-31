/**
 * 差异文件资源地址的测试：用 `node --test` 运行。
 *
 * 覆盖绝对路径拼接、相对路径按仓库根换算，以及工作树场景下地址不被宿主二次拼接。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffFileAddress } from '../src/client/diff/resource-path.ts';

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
