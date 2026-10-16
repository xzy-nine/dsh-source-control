/**
 * 变更文件树的测试。
 *
 * 规则：从最早分叉的公共目录开始显示。根到该目录之间每级都只有一个子目录，逐级展开
 * 只会得到一串没有信息量的层级，因此合并成一行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { absolutePathOf, changeRowsOf } from '../src/client/panel/change-tree.ts';

/** 造一个条目。 */
const entry = (path) => ({ path });

/** 取行的展示路径序列：文件夹用其完整 path 加 `▸` 前缀。 */
const shape = (rows) => rows.map((row) => (row.kind === 'folder' ? `▸${row.path}` : row.entry.path));

test('单链合并为一行，不再逐级展开', () => {
	// 旧行为会输出 ▸src ▸src/client ▸src/client/panel 三行，再是文件。
	const rows = changeRowsOf([entry('src/client/panel/a.ts'), entry('src/client/panel/b.ts')], new Set());
	assert.deepEqual(shape(rows), ['▸src/client/panel', 'src/client/panel/a.ts', 'src/client/panel/b.ts']);
	assert.equal(rows[0].name, 'src/client/panel', '合并行显示整条链');
	assert.equal(rows[0].depth, 1, '合并行在最外层');
	assert.equal(rows[0].count, 2, '合并行应统计全部后代文件');
	assert.equal(rows[1].depth, 2, '文件在合并行下一层');
});

test('分叉处停下：公共目录保留，其下不再合并', () => {
	// src 下有两个子目录，已分叉，因此 src 自成一行。
	const rows = changeRowsOf([entry('src/client/a.ts'), entry('src/server/b.ts')], new Set());
	assert.deepEqual(shape(rows), ['▸src', '▸src/client', 'src/client/a.ts', '▸src/server', 'src/server/b.ts']);
	assert.equal(rows[0].name, 'src');
	assert.equal(rows[1].name, 'client', '分叉层显示单段名');
});

test('跨顶层目录时每条链各自合并', () => {
	// 公共目录是根，但仍不应逐级展开 src 这条空链。
	const rows = changeRowsOf([entry('src/client/panel/a.ts'), entry('test/b.mjs')], new Set());
	assert.deepEqual(shape(rows), ['▸src/client/panel', 'src/client/panel/a.ts', '▸test', 'test/b.mjs']);
});

test('目录自身还有文件时不合并，避免藏起同层文件', () => {
	// 文件排在其层级的子目录之后（既有排序：先目录后文件）。
	const rows = changeRowsOf([entry('src/a.ts'), entry('src/client/b.ts')], new Set());
	assert.deepEqual(shape(rows), ['▸src', '▸src/client', 'src/client/b.ts', 'src/a.ts']);
	assert.equal(rows[0].name, 'src', 'src 自身有文件，不应被并入子目录');
});

test('根目录下的文件直接成行', () => {
	const rows = changeRowsOf([entry('a.ts'), entry('b.ts')], new Set());
	assert.deepEqual(shape(rows), ['a.ts', 'b.ts']);
	assert.equal(rows[0].depth, 1);
});

test('单个深层文件只保留一条合并行', () => {
	const rows = changeRowsOf([entry('src/client/panel/a.ts')], new Set());
	assert.deepEqual(shape(rows), ['▸src/client/panel', 'src/client/panel/a.ts']);
});

test('折叠合并行时只留该行', () => {
	const paths = [entry('src/client/panel/a.ts'), entry('src/client/panel/b.ts')];
	const rows = changeRowsOf(paths, new Set(['src/client/panel']));
	assert.deepEqual(shape(rows), ['▸src/client/panel']);
	assert.equal(rows[0].open, false);
});

test('同级目录按名称排序，文件排在目录之后', () => {
	const rows = changeRowsOf([entry('b/x.ts'), entry('a/y.ts')], new Set());
	assert.deepEqual(shape(rows), ['▸a', 'a/y.ts', '▸b', 'b/x.ts']);
});

test('条目为空时不产生任何行', () => {
	assert.deepEqual(changeRowsOf([], new Set()), []);
});

test('复制路径给出绝对路径', () => {
	// 菜单里的路径相对仓库根；复制时拼上仓库根，便于直接粘进终端或编辑器。
	assert.equal(absolutePathOf('E:\\repo', 'src/a.ts'), 'E:\\repo\\src\\a.ts', 'Windows 用原生分隔符');
	assert.equal(absolutePathOf('E:/repo', 'src/a.ts'), 'E:/repo/src/a.ts', '仓库根用斜杠时沿用');
	assert.equal(absolutePathOf('E:/repo/', 'src/a.ts'), 'E:/repo/src/a.ts', '尾斜杠不重复');
	assert.equal(absolutePathOf('/home/me/repo', 'src/a.ts'), '/home/me/repo/src/a.ts', 'POSIX');
	// 目录行的路径同样按仓库根拼接。
	assert.equal(absolutePathOf('E:\\repo', 'src/client'), 'E:\\repo\\src\\client');
	// 反斜杠形态的相对路径也归一为仓库根的分隔符。
	assert.equal(absolutePathOf('E:\\repo', 'src\\a.ts'), 'E:\\repo\\src\\a.ts');
});

test('已是绝对路径的目标原样复制', () => {
	// 本地排除文件在 .git 目录内，客户端持有的就是绝对路径。
	assert.equal(absolutePathOf('E:\\repo', 'E:\\repo\\.git\\info\\exclude'), 'E:\\repo\\.git\\info\\exclude');
	assert.equal(absolutePathOf('E:/repo', 'D:/other/a.ts'), 'D:/other/a.ts', '跨盘符原样');
	assert.equal(absolutePathOf('/home/me/repo', '/etc/hosts'), '/etc/hosts');
	// UNC 路径（双反斜杠开头）原样返回，不再拼一次仓库根。
	assert.equal(absolutePathOf('E:\\repo', '\\\\server\\share\\a.ts'), '\\\\server\\share\\a.ts');
	assert.equal(absolutePathOf('/home/me/repo', '\\\\server\\share'), '\\\\server\\share');
	// 仓库根未知时无从拼接，原样给出。
	assert.equal(absolutePathOf('', 'src/a.ts'), 'src/a.ts');
});
