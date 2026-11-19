
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource, extractCommentBlocks, newViolations, markerReason, PROSE_RULES, MARKER_WITHOUT_REASON } from '../scripts/comment-prose.ts';

const TICK = String.fromCharCode(96);

/** 取一组命中的规则标识。 */
function rulesOf(source, file = 'x.ts') {
	return scanSource(file, source).map((violation) => violation.rule);
}

test('抽取：字符串、正则与模板字面量里的注释定界符不算注释', () => {
	const source = [
		'const a = "// 旧版";',
		"const b = '/* 旧版 */';",
		'const c = /\\/\\/ 旧版/;',
		'const d = ' + TICK + 'x' + '$' + '{ "旧版" }' + TICK + ';',
		'// 真正旧版',
	].join('\n');
	assert.deepEqual(rulesOf(source), ['change-narration']);
});

test('抽取：JSX 文本里的 // 不是注释，插值与属性里的真注释保留', () => {
	assert.deepEqual(rulesOf('const el = <div>// 旧版</div>;\n', 'x.tsx'), []);
	assert.deepEqual(rulesOf('const el = <div>{/* 旧版 */}</div>;\n', 'x.tsx'), ['change-narration']);
	assert.deepEqual(rulesOf('const el = <div title="// 旧版">a</div>;\n', 'x.tsx'), []);
});

test('抽取：相邻行注释合并成一段，空行与代码切断分段', () => {
	const blocks = extractCommentBlocks('x.ts', '// 一\n// 二\n\nconst a = 1\n// 三\n');
	assert.deepEqual(blocks.map((block) => block.lines.map((line) => line.line)), [[1, 2], [5]]);
});

test('抽取：块注释的行号从起始行开始逐行递增', () => {
	const blocks = extractCommentBlocks('x.ts', '\n/* 甲\n 乙 */\nconst a = 1;\n');
	assert.deepEqual(blocks.map((block) => block.lines.map((line) => line.line)), [[2, 3]]);
});

test('命中：八类规则各自拦下对应词形', () => {
	assert.deepEqual(rulesOf('// 旧版把草稿写在宿主'), ['change-narration']);
	assert.deepEqual(rulesOf('// 本 PR 调整了取数顺序'), ['session-scope']);
	assert.deepEqual(rulesOf('// 评审指出这里要判空'), ['review-audience']);
	assert.deepEqual(rulesOf('// 见 (decision 7)'), ['dead-session-ref']);
	assert.deepEqual(rulesOf('// 第二步读取提交图'), ['step-narration']);
	assert.deepEqual(rulesOf('// TODO 补上缓存失效'), ['planning-residue']);
	assert.deepEqual(rulesOf('// 我认为这里不会为空'), ['author-voice']);
	assert.deepEqual(rulesOf('// 宿主能力都经 seam'), ['decorative-metaphor']);
});

test('命中：宽口径拦下可能属于解释性的写法', () => {
	const suspects = [
		'// 该值不再写入',
		'// 迁移后统一由宿主落盘',
		'// 本次会话内单调递增',
		'// 先取快照再合并',
		'// 暂时无法监视',
		'// 实际上这里不会并发',
	];
	for (const line of suspects) assert.notDeepEqual(rulesOf(line), [], line);
});

test('命中：带归属的待办与纯行为描述放行', () => {
	const allowed = [
		'// 读取提交图，空仓库返回空数组',
		'// TODO(#1470): 补上缓存失效',
	];
	for (const line of allowed) assert.deepEqual(rulesOf(line), [], line);
});

test('命中：位置描述里的「之前」同样拦下，靠标记豁免', () => {
	// 宽口径的代价是误伤；这类命中用 prose-ok 就地豁免，而不是把词形从规则里删掉。
	const line = '// 首个 hunk 之前是文件头，与 hunk 无关';
	assert.deepEqual(rulesOf(line), ['change-narration']);
	assert.deepEqual(rulesOf(line + ' prose-ok: 描述文件头位置'), []);
});

test('豁免：带理由的标记让整段跳过', () => {
	const source = '// 旧版键前缀，需搬到宿主\n// prose-ok: 兄弟字段已用 version 命名\nconst a = 1';
	assert.deepEqual(rulesOf(source), []);
});

test('豁免：理由为空时不做豁免，标记与原有命中一并报出', () => {
	const source = '// 旧版键前缀\n// prose-ok:\nconst a = 1';
	assert.deepEqual(rulesOf(source), ['change-narration', MARKER_WITHOUT_REASON]);
});

test('豁免：块注释里的标记同样作用于整段', () => {
	const source = '/* 此前落在宿主的草稿\n * prose-ok: 迁移代码必须读旧键 */\nexport const a = 1';
	assert.deepEqual(rulesOf(source), []);
});

test('标记解析：全角冒号与理由前后的空白', () => {
	assert.equal(markerReason(' prose-ok： 实测上限 '), '实测上限');
	assert.equal(markerReason(' prose-ok:'), '');
	assert.equal(markerReason(' 没有标记 '), null);
});

test('基线：按次数核销，复制出来的第二处仍是新命中', () => {
	const violations = scanSource('x.ts', '// 旧版键\n// 旧版键\n');
	assert.equal(violations.length, 2);
	const baseline = [['x.ts', 'change-narration', violations[0].text]];
	assert.equal(newViolations(violations, baseline).length, 1);
});

test('规则表：标识唯一且都有说明', () => {
	const ids = PROSE_RULES.map((rule) => rule.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const rule of PROSE_RULES) assert.notEqual(rule.summary.trim(), '', rule.id);
});
