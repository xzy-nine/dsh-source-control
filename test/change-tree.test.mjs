/**
 * 变更文件树的测试。
 *
 * 规则：从最早分叉的公共目录开始显示。根到该目录之间每级都只有一个子目录，逐级展开
 * 只会得到一串没有信息量的层级，因此合并成一行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeRowsOf } from '../src/client/panel/change-tree.ts';

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
