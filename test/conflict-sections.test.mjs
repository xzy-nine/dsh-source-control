/**
 * 冲突分段与补丁块切分的纯函数测试。
 *
 * 冲突按 `<<<<<<< … >>>>>>>` 切段、补丁按 `@@` 切块：两者都是「只处理命中区间」的
 * 判据，所以逐段取一侧与逐块暂存能互不影响。
 */
import assert from 'node:assert/strict';
import { parallel } from './harness.mjs';
import { splitConflict, sideLinesOf } from '../src/shared/conflict-sections.ts';
import { parsePatch, patchOf } from '../src/shared/patch-hunks.ts';

/** 一段两处冲突的文本。 */
const TWO_SECTIONS = [
	'line1',
	'<<<<<<< HEAD',
	'line2-OURS',
	'=======',
	'line2-THEIRS',
	'>>>>>>> side',
	'line3',
	'<<<<<<< HEAD',
	'line10-OURS',
	'=======',
	'line10-THEIRS',
	'>>>>>>> side',
	'line12',
	'',
].join('\n');

/** 一份两块的补丁。 */
const TWO_HUNKS = [
	'diff --git a/f.txt b/f.txt',
	'index aaa..bbb 100644',
	'--- a/f.txt',
	'+++ b/f.txt',
	'@@ -1,5 +1,5 @@',
	' line1',
	'-line2',
	'+line2-X',
	' line3',
	' line4',
	'@@ -15,6 +15,6 @@ line14',
	' line15',
	'-line18',
	'+line18-Y',
	' line19',
	'',
].join('\n');

/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('冲突分段与补丁块', (t) => {
	t.test('按标记切出各段，两侧内容与标签正确', () => {
		const split = splitConflict(TWO_SECTIONS);
		assert.equal(split.sections.length, 2);
		assert.deepEqual(split.sections[0].ours.lines, ['line2-OURS']);
		assert.deepEqual(split.sections[0].theirs.lines, ['line2-THEIRS']);
		assert.equal(split.sections[0].ours.label, 'HEAD');
		assert.equal(split.sections[0].theirs.label, 'side');
		assert.deepEqual(split.sections[1].ours.lines, ['line10-OURS']);
	});

	t.test('冲突之外的行保留为普通段', () => {
		const split = splitConflict(TWO_SECTIONS);
		const commons = split.commons.flatMap((item) => item.lines);
		assert.deepEqual(commons, ['line1', 'line3', 'line12']);
	});

	t.test('行号指向标记行', () => {
		const split = splitConflict(TWO_SECTIONS);
		assert.equal(split.sections[0].startLine, 2, '起始标记在第 2 行');
		assert.equal(split.sections[0].endLine, 6, '结束标记在第 6 行');
		assert.equal(split.sections[1].startLine, 8);
	});

	t.test('没有标记时不算冲突', () => {
		const split = splitConflict('a\nb\n');
		assert.equal(split.hasMarkers, false);
		assert.equal(split.sections.length, 0);
		assert.deepEqual(split.commons[0].lines, ['a', 'b']);
	});

	t.test('标记不完整时按普通行处理，不整份失败', () => {
		// 只有起始标记、没有分隔与结束：整份内容退回普通行，不能被当成一处冲突。
		const split = splitConflict('<<<<<<< HEAD\na\nb\n');
		assert.equal(split.sections.length, 0);
		assert.deepEqual(split.commons[0].lines, ['<<<<<<< HEAD', 'a', 'b']);
	});

	t.test('diff3 风格的三方标记读得出基线', () => {
		const text = ['<<<<<<< HEAD', 'ours', '||||||| base', 'base', '=======', 'theirs', '>>>>>>> side', ''].join('\n');
		const split = splitConflict(text);
		assert.deepEqual(split.sections[0].base, ['base']);
		assert.deepEqual(split.sections[0].ours.lines, ['ours']);
		assert.deepEqual(split.sections[0].theirs.lines, ['theirs']);
	});

	t.test('取一侧内容', () => {
		const section = splitConflict(TWO_SECTIONS).sections[0];
		assert.deepEqual(sideLinesOf(section, 'ours'), ['line2-OURS']);
		assert.deepEqual(sideLinesOf(section, 'theirs'), ['line2-THEIRS']);
	});

	t.test('补丁切成文件头与各块', () => {
		const patch = parsePatch(TWO_HUNKS);
		assert.equal(patch.hunks.length, 2);
		assert.match(patch.header, /^diff --git/);
		assert.equal(patch.hunks[0].oldStart, 1);
		assert.equal(patch.hunks[0].newLines, 5);
		assert.equal(patch.hunks[1].oldStart, 15);
	});

	t.test('按块重放：只留选中的块', () => {
		const patch = parsePatch(TWO_HUNKS);
		const only = patchOf(patch, [0]);
		assert.ok(only.includes('line2-X'), '选中的块要在');
		assert.ok(!only.includes('line18-Y'), '未选中的块不能带上');
		assert.ok(only.endsWith('\n'), '补丁必须以换行结束，否则 git 判成 corrupt');
		const none = patchOf(patch, []);
		assert.equal(none, '', '没有选中块时不产出补丁');
	});

	t.test('二进制差异没有块', () => {
		const binary = 'diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n';
		assert.equal(parsePatch(binary).hunks.length, 0);
	});
});
