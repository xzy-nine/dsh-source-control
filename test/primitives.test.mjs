/**
 * 客户端跨文件契约：ui-primitives 导出名、CSS 模块类名映射、菜单注册表与门禁接线。
 *
 * 这些判据只能看源码结构与数据源：导入名不存在时 React 不报编译错误，只在运行时抛
 * 「元素类型无效」并让整页空白；类名映射缺失时视图无样式。导出名取自 devDependencies
 * 里固定版本的 `.d.ts`，本机与 CI 都能执行。
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parallel } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const clientDir = join(root, 'src', 'client');
const panelDir = join(clientDir, 'panel');
const cssDir = join(clientDir, 'css');

/** 右键菜单全部源码：装配在 commit-menu.ts，处理函数按域在 panel/menu/ 下。 */
function menuSources() {
	const files = ['commit-menu.ts', ...readdirSync(join(panelDir, 'menu')).filter((name) => name.endsWith('.ts')).map((name) => join('menu', name))];
	return files.map((name) => readFileSync(join(panelDir, name), 'utf8'));
}

/**
 * ui-primitives 的类型声明位置。
 *
 * 取 devDependencies 里固定的那一份安装产物：本仓库与 CI 都装同一版本，导出名以它为准。
 * 源码检出只在开发机的上级目录里才有，按它断言会让 CI 上静默跳过。
 */
const PRIMITIVES_TYPES = join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'types');
const PRIMITIVES_INDEX = join(PRIMITIVES_TYPES, 'index.d.ts');
const PRIMITIVES_ICONS = join(PRIMITIVES_TYPES, 'icons', 'index.d.ts');

/** 客户端全部源码文件（递归含各子目录）。 */
function clientFiles() {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
		}
	};
	walk(clientDir);
	return files;
}

/** 收集 ui-primitives 的导出名（含 `export type` 与星号再导出的图标）。 */
function primitivesExports() {
	const names = new Set();
	const indexSource = readFileSync(PRIMITIVES_INDEX, 'utf8');
	for (const match of indexSource.matchAll(/export\s*(?:type\s*)?\{([^}]+)\}/g)) {
		for (const piece of match[1].split(',')) {
			const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
			if (name !== undefined && name !== '') names.add(name);
		}
	}
	if (indexSource.includes("export * from './icons/index.tsx'")) {
		const iconsSource = readFileSync(PRIMITIVES_ICONS, 'utf8');
		for (const match of iconsSource.matchAll(/export declare (?:const|function) ([A-Za-z0-9_]+)/g)) names.add(match[1]);
	}
	return names;
}

/** 取一个客户端文件里从 ui-primitives 导入的名字。 */
function importedNames(file) {
	const source = readFileSync(file, 'utf8');
	const names = [];
	for (const block of source.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'@deepseek-ai\/dsh-client-ui-primitives'/g)) {
		for (const piece of block[1].split(',')) {
			const name = piece.trim().replace(/^type\s+/, '');
			if (name !== '') names.push(name);
		}
	}
	return names;
}

/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('客户端跨文件契约', (t) => {
	t.test('ui-primitives 导入名全部存在', () => {
		const exported = primitivesExports();
		assert.ok(exported.size > 100, `导出表过小（${exported.size}），可能解析出错`);
		for (const file of clientFiles()) {
			for (const name of importedNames(file)) {
				assert.ok(exported.has(name), `${file} 导入了不存在的导出名：${name}`);
			}
		}
	});

	t.test('图标导出名带权重后缀', () => {
		const exported = primitivesExports();
		assert.ok(exported.has('IconBranchOutlineRegular'));
		assert.ok(!exported.has('IconBranchOutline'), '裸图标名不应存在，若上游改名需同步本测试');
	});

	t.test('样式经 CSS 模块引用且类名全部有映射', () => {
		const defined = new Map();
		for (const file of readdirSync(cssDir).filter((name) => name.endsWith('.module.css'))) {
			const source = readFileSync(join(cssDir, file), 'utf8');
			const names = new Set();
			for (const match of source.matchAll(/\.([A-Za-z][\w-]*)/g)) names.add(match[1]);
			defined.set(file, names);
		}
		const total = [...defined.values()].reduce((count, names) => count + names.size, 0);
		assert.ok(total > 100, `样式类名过少（${total}），可能解析出错`);

		for (const file of clientFiles()) {
			const source = readFileSync(file, 'utf8');
			const aliasToModule = new Map();
			for (const match of source.matchAll(/import\s+(\w+)\s+from\s+'[^']*\/([\w-]+)\.module\.css'/g)) {
				aliasToModule.set(match[1], `${match[2]}.module.css`);
			}
			if (aliasToModule.size === 0) continue;
			const body = source.split('\n').filter((line) => !/^\s*import\b/.test(line)).join('\n');
			for (const match of body.matchAll(/\b(\w+)\.([A-Za-z][\w]*)\b/g)) {
				const module = aliasToModule.get(match[1]);
				if (module === undefined) continue;
				assert.ok(
					defined.get(module)?.has(match[2]),
					`${file} 引用了 ${module} 里不存在的类名：${match[1]}.${match[2]}`,
				);
			}
		}
	});

	t.test('动态切换的状态类不经模块作用域', () => {
		const state = readFileSync(join(cssDir, 'state-classes.ts'), 'utf8');
		const name = /MENU_TARGET_CLASS = '([^']+)'/.exec(state)?.[1];
		assert.ok(name !== undefined && name !== '', '应给出状态类名');
		for (const module of ['changes.module.css', 'graph.module.css']) {
			assert.match(
				readFileSync(join(cssDir, module), 'utf8'),
				new RegExp(`:global\\(\\.${name}\\)`),
				`${module} 应以 :global 引用状态类`,
			);
		}
	});

	t.test('构建脚本把 CSS 模块的样式内联进包', () => {
		const script = readFileSync(join(root, 'scripts', 'build-client.mjs'), 'utf8');
		assert.match(script, /'\.css': 'local-css'/, 'CSS 应作为模块处理');
		assert.match(script, /endsWith\('\.css'\)/, '应收集 esbuild 产出的样式');
		assert.match(script, /dsh-source-control-module-style/, '应把样式内联为一段 style');
		assert.match(script, /jsx: 'automatic'/, '复制的视图使用自动 JSX 运行时');
	});

	t.test('菜单注册表与处理函数一一对应', () => {
		const menu = menuSources().join('\n');
		const { actions } = JSON.parse(readFileSync(join(panelDir, 'menu-actions.json'), 'utf8'));
		assert.ok(Array.isArray(actions) && actions.length > 0, '注册表数据源应有操作');
		for (const action of actions) {
			assert.ok(Array.isArray(action.refTypes) && action.refTypes.length > 0, `${action.id} 应声明适用的引用类型`);
			assert.ok(typeof action.title === 'string' && action.title !== '', `${action.id} 应有菜单名称`);
			assert.match(menu, new RegExp(`${action.id}: \\(ctx, meta\\) =>`), `${action.id} 应有对应的处理函数`);
		}
		assert.ok(existsSync(join(panelDir, 'commit-menu.ts')), '应导出提交菜单');
	});

	t.test('门禁失败时提示先读对应规则页', () => {
		const hint = readFileSync(join(root, 'scripts', 'gate-hint.ts'), 'utf8');
		assert.match(hint, /GATE_RULES/, '应登记各门禁的规则正家');
		assert.match(hint, /Docs\/AGENTS\.md/, '文档门禁应指向 Docs/AGENTS.md');
		for (const gate of ['verify-doc-budgets', 'verify-md-wrap', 'verify-md-links']) {
			assert.match(readFileSync(join(root, 'scripts', `${gate}.ts`), 'utf8'), /gateHint\(/, `${gate} 应输出规则提示`);
		}
		for (const hook of ['pre-commit', 'pre-push']) {
			assert.match(readFileSync(join(root, '.githooks', hook), 'utf8'), /verify-all\.ts/, `${hook} 应跑文档门禁`);
		}
	});
});
