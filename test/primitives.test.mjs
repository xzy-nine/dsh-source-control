/**
 * 校验客户端从 ui-primitives 导入的每个名字都真实存在。
 *
 * 背景：ui-primitives 的产品图标导出名带 `Regular` / `Medium` 权重后缀，
 * 写成裸名会得到 undefined，React 渲染时不报编译错误、只在运行时抛
 * 「元素类型无效」并让整个侧栏页变空白。此测试把这类拼写错误挡在构建前。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const clientDir = join(root, 'src', 'client');

/** ui-primitives 在源码检出中的位置；profile 安装版没有源码，此时跳过。 */
const PRIMITIVES_INDEX = 'E:/GitHubCode/02DSH/deepseek-harness/packages/client/ui-primitives/src/index.ts';
const PRIMITIVES_ICONS = 'E:/GitHubCode/02DSH/deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';

/** 收集 ui-primitives 的导出名（含星号再导出的图标）。 */
function primitivesExports() {
	const names = new Set();
	const indexSource = readFileSync(PRIMITIVES_INDEX, 'utf8');
	for (const match of indexSource.matchAll(/export\s*\{([^}]+)\}/g)) {
		for (const piece of match[1].split(',')) {
			const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
			if (name !== undefined && name !== '') names.add(name);
		}
	}
	if (indexSource.includes("export * from './icons/index.tsx'")) {
		const iconsSource = readFileSync(PRIMITIVES_ICONS, 'utf8');
		for (const match of iconsSource.matchAll(/export const ([A-Za-z0-9_]+)/g)) names.add(match[1]);
	}
	return names;
}

/** 取一个客户端文件里从 ui-primitives 导入的名字。 */
function importedNames(file) {
	const source = readFileSync(join(clientDir, file), 'utf8');
	const names = [];
	for (const block of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'@deepseek-ai\/dsh-client-ui-primitives'/g)) {
		for (const piece of block[1].split(',')) {
			const name = piece.trim();
			if (name !== '') names.push(name);
		}
	}
	return names;
}

const available = existsSync(PRIMITIVES_INDEX) && existsSync(PRIMITIVES_ICONS);

test('ui-primitives 导入名全部存在', { skip: !available && '未找到 ui-primitives 源码检出' }, () => {
	const exported = primitivesExports();
	assert.ok(exported.size > 100, `导出表过小（${exported.size}），可能解析出错`);
	for (const file of ['index.js', 'panel.js', 'graph.js', 'api.js', 'lanes.js', 'styles.js']) {
		if (!existsSync(join(clientDir, file))) continue;
		for (const name of importedNames(file)) {
			assert.ok(exported.has(name), `${file} 导入了不存在的导出名：${name}`);
		}
	}
});

test('图标导出名带权重后缀', { skip: !available && '未找到 ui-primitives 源码检出' }, () => {
	const exported = primitivesExports();
	// 产品图标一律以 Regular 或 Medium 结尾；裸名不存在，正是初版写错的地方。
	assert.ok(exported.has('IconBranchOutlineRegular'));
	assert.ok(!exported.has('IconBranchOutline'), '裸图标名不应存在，若上游改名需同步本测试');
});
