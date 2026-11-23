/**
 * 差异块切分：把行数过多的 hunk 压到 forge 能一次性展开的规模。
 *
 * forge 的渲染路径按块一次性展开行数组（`rows.push(...hunkRows(hunk))`），展开的实参
 * 个数等于该块的可见行数；超过运行时上限即抛 `RangeError`，整棵正文树随之失败。
 * 切分因此要保证每块的可见行数不超上限，同时让两侧行号与渲染结果与切分前一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { chunkHunks, MAX_HUNK_LINES } = await import('../../src/client/diff/hunk-chunking.ts');

/** 一块全是新增行的差异。 */
function addedHunk(count, start = 1) {
	const lines = [];
	for (let at = 0; at < count; at += 1) lines.push(`+line ${String(start + at)}`);
	return { oldStart: start, oldLines: 0, newStart: start, newLines: count, lines };
}

/**
 * 一块的行按 patch 顺序摊开后的两侧行号。
 *
 * 与渲染路径同一套规则：`+` 只占新侧，`-` 只占旧侧，空格两边都占，`\\` 标记不占。
 *
 * @param hunk - 一块差异。
 * @returns 逐行的两侧行号与种类。
 */
function expand(hunk) {
	let oldNo = hunk.oldStart;
	let newNo = hunk.newStart;
	const rows = [];
	for (const line of hunk.lines) {
		const sign = line.charAt(0);
		if (sign === '+') { rows.push({ kind: 'add', old: null, new: newNo }); newNo += 1; }
		else if (sign === '-') { rows.push({ kind: 'del', old: oldNo, new: null }); oldNo += 1; }
		else if (sign === '\\') rows.push({ kind: 'marker' });
		else { rows.push({ kind: 'context', old: oldNo, new: newNo }); oldNo += 1; newNo += 1; }
	}
	return rows;
}

/** 若干块摊开后去掉标记行的可见行。 */
function visibleRows(chunks) {
	return chunks.flatMap((chunk) => expand(chunk)).filter((row) => row.kind !== 'marker');
}

/** 一块含上下文、删除与新增的差异。 */
const MIXED_HUNK = {
	oldStart: 10, oldLines: 5, newStart: 10, newLines: 6,
	lines: [' keep 10', '-gone 11', '+fresh 11', ' keep 12', ' keep 13', ' keep 14', '+tail 15'],
};

test('未超上限的块内容原样保留，形状换成新对象', () => {
	const chunks = chunkHunks([MIXED_HUNK], 100);
	assert.equal(chunks.length, 1);
	assert.deepEqual(chunks[0], MIXED_HUNK);
	assert.notEqual(chunks[0], MIXED_HUNK, '不把宿主的块对象当成只读类型塞过去');
});

test('超上限的块切成首尾相接的小块', () => {
	const chunks = chunkHunks([addedHunk(10)], 4);
	assert.deepEqual(chunks.map((chunk) => chunk.lines.length), [4, 4, 2]);
	assert.deepEqual(chunks.map((chunk) => chunk.newStart), [1, 5, 9], '新侧行号首尾相接');
	assert.deepEqual(chunks.map((chunk) => chunk.newLines), [4, 4, 2]);
	assert.equal(chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0), 10, '行不丢也不重');
});

test('切分后逐行摊开的新侧行号与切分前一致', () => {
	const original = expand(addedHunk(9));
	const chunks = chunkHunks([addedHunk(9)], 4);
	assert.equal(chunks.length, 3);
	assert.deepEqual(visibleRows(chunks), original, '行号与顺序都不变');
	assert.deepEqual(visibleRows(chunks).map((row) => row.new), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('含删除与上下文的块切分后两侧行号都对得上', () => {
	const wide = {
		oldStart: 1, oldLines: 6, newStart: 1, newLines: 6,
		lines: [' c1', '-o2', '+n2', ' c3', ' c4', '-o5', '+n5', ' c6'],
	};
	const chunks = chunkHunks([wide], 3);
	assert.ok(chunks.length > 1, '需要切分');
	assert.deepEqual(visibleRows(chunks), expand(wide), '两侧行号与切分前逐行一致');
	assert.deepEqual(visibleRows(chunks).map((row) => row.old), [1, 2, null, 3, 4, 5, null, 6]);
	assert.deepEqual(visibleRows(chunks).map((row) => row.new), [1, null, 2, 3, 4, null, 5, 6]);
});

test('每块的可见行数不超过上限', () => {
	const chunks = chunkHunks([addedHunk(23), MIXED_HUNK], 5);
	for (const chunk of chunks) {
		const visible = expand(chunk).filter((row) => row.kind !== 'marker').length;
		assert.ok(visible <= 5, `每块不超过上限，实际 ${String(visible)}`);
	}
	assert.deepEqual(chunks.flatMap((chunk) => expand(chunk)), [...expand(addedHunk(23)), ...expand(MIXED_HUNK)]);
});

test('文件末尾无换行标记留在它前一行的块里', () => {
	const hunk = {
		oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
		lines: [' a', ' b', ' c', '\\ No newline at end of file'],
	};
	const chunks = chunkHunks([hunk], 3);
	assert.equal(chunks.length, 1, '标记不计入上限');
	assert.equal(chunks[0].lines.at(-1), '\\ No newline at end of file', '标记跟着它前一行');
	assert.equal(chunks[0].newLines, 3, '标记不推进两侧行号');
});

test('上限按可见行数计，标记行不占额度', () => {
	const hunk = {
		oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
		lines: [' a', ' b', ' c', '\\ No newline at end of file', '-d'],
	};
	const chunks = chunkHunks([hunk], 3);
	assert.deepEqual(chunks.map((chunk) => chunk.lines.length), [4, 1]);
	assert.deepEqual(visibleRows(chunks), [
		{ kind: 'context', old: 1, new: 1 },
		{ kind: 'context', old: 2, new: 2 },
		{ kind: 'context', old: 3, new: 3 },
		{ kind: 'del', old: 4, new: null },
	]);
});

test('逐个块处理，未超限的块保持单块', () => {
	const chunks = chunkHunks([addedHunk(2), addedHunk(5), addedHunk(1)], 4);
	assert.deepEqual(chunks.map((chunk) => chunk.lines.length), [2, 4, 1, 1]);
});

test('真实规模的块切分后每块都在上限内且行号连续', () => {
	const total = MAX_HUNK_LINES * 3 + 7;
	const chunks = chunkHunks([addedHunk(total)], MAX_HUNK_LINES);
	assert.equal(chunks.length, 4);
	assert.ok(chunks.every((chunk) => chunk.lines.length <= MAX_HUNK_LINES));
	const rows = visibleRows(chunks);
	assert.equal(rows.length, total, '行数与切分前一致');
	assert.equal(rows[0].new, 1);
	assert.equal(rows.at(-1).new, total, '末尾行号不因切分而偏移');
});

test('上限小于 1 时按 1 处理', () => {
	const chunks = chunkHunks([addedHunk(3)], 0);
	assert.deepEqual(chunks.map((chunk) => chunk.lines.length), [1, 1, 1]);
});

test('空输入给空表', () => {
	assert.deepEqual(chunkHunks([], 10), []);
});
