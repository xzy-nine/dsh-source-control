/**
 * 忽略规则纯函数测试：路径规范化、规则写法、去重与追加。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	appendIgnoreRule, hasIgnoreRule, ignoreEntriesOf, ignoreRuleOf, isIgnorableTarget, normalizeIgnoreTarget,
} from '../src/source-control/ignore-rules.ts';

test('目标路径规范化为相对仓库根的形式', () => {
	assert.equal(normalizeIgnoreTarget('./src/app.ts'), 'src/app.ts');
	assert.equal(normalizeIgnoreTarget('/src/app.ts'), 'src/app.ts');
	assert.equal(normalizeIgnoreTarget('src\\app.ts'), 'src/app.ts');
	assert.equal(normalizeIgnoreTarget('src/dist/'), 'src/dist');
});

test('规则锚定到忽略文件所在目录，目录带尾斜杠', () => {
	assert.equal(ignoreRuleOf('app.ts', false), '/app.ts');
	assert.equal(ignoreRuleOf('dist', true), '/dist/');
	assert.equal(ignoreRuleOf('', false), '');
});

test('已有规则与注释区分开', () => {
	const content = '# 依赖\n/node_modules/\n\n/dist/\n';
	assert.equal(hasIgnoreRule(content, '/dist/'), true);
	assert.equal(hasIgnoreRule(content, '/build/'), false);
	assert.deepEqual(ignoreEntriesOf(content), ['/node_modules/', '/dist/']);
});

test('追加规则时补齐末尾换行且独占一行', () => {
	assert.equal(appendIgnoreRule('', '/dist/'), '/dist/\n');
	assert.equal(appendIgnoreRule('# 依赖\n', '/dist/'), '# 依赖\n/dist/\n');
	assert.equal(appendIgnoreRule('# 依赖', '/dist/'), '# 依赖\n/dist/\n');
});

test('仓库之外的路径不可写入', () => {
	assert.equal(isIgnorableTarget('src/app.ts'), true);
	assert.equal(isIgnorableTarget(''), false);
	assert.equal(isIgnorableTarget('..'), false);
	assert.equal(isIgnorableTarget('../outside.ts'), false);
	assert.equal(isIgnorableTarget('src/../../outside.ts'), false);
});
