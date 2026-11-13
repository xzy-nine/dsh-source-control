/**
 * forge 差异视图适配层的测试：hunk 映射、行数统计、文件状态，以及渲染产物。
 *
 * 客户端测试从 `src/` 直连 `.ts`，但 Node 的类型剥离不处理 JSX，因此 `.tsx` 适配层
 * 改为从构建产物 `lib/client.js` 取：那里的适配层函数是包内可调用的实现。这样断言
 * 的正是实际会跑的那份代码，而不是另一条编译路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* 本文件的渲染用例各开一个 jsdom 窗口并覆写浏览器全局，因此整文件串行。 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** jsdom 的 JSDOM 构造；包无法加载时为 null。 */
let JSDOM = null;
try {
	({ JSDOM } = await import('jsdom'));
} catch {
	JSDOM = null;
}
const skip = JSDOM === null ? '未安装 jsdom，跳过适配层渲染' : false;

/**
 * 平台模块的测试替身。
 *
 * ui-primitives 的产物会 `import` CSS 文件，Node 无法直接加载；而本文件要断言的是
 * 适配层自己的映射与渲染，不依赖这些控件的外观。因此这里给它一份够用的替身：
 * 每个导出都是一个能渲染的占位组件或纯函数。
 *
 * @returns 平台模块表。
 */
async function platformModules() {
	const React = await import(pathToFileURL(join(root, 'node_modules', 'react', 'index.js')).href);
	const { createRoot } = await import(pathToFileURL(join(root, 'node_modules', 'react-dom', 'client.js')).href);
	const reactDom = await import(pathToFileURL(join(root, 'node_modules', 'react-dom', 'index.js')).href);
	const jsxRuntime = await import(pathToFileURL(join(root, 'node_modules', 'react', 'jsx-runtime.js')).href);
	/** 一个渲染成 div 的占位控件，接受任意 props。 */
	const Stub = (props) => React.createElement('div', null, props?.children ?? null);
	/** 任何图标名都渲染成空的 span。 */
	const icon = () => React.createElement('span', null);
	const primitives = new Proxy({
		Button: Stub,
		Tag: Stub,
		Tooltip: Stub,
		Menu: Stub,
		MenuItemButton: Stub,
		PathLabel: Stub,
		FileTypeIcon: Stub,
		FoldToggle: Stub,
		CodeToolbar: Stub,
		useCodeHighlighter: () => () => undefined,
		languageForPath: () => undefined,
		relativeTime: () => '',
		writeClipboard: async () => true,
	}, {
		get(target, key) {
			if (key in target) return target[key];
			if (typeof key === 'string' && /^Icon/.test(key)) return icon;
			return Stub;
		},
	});
	const store = { defineStore: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }), createSnapshotStore: (v) => ({ getSnapshot: () => v, set: () => {}, subscribe: () => () => {} }) };
	return {
		react: React,
		'react/jsx-runtime': jsxRuntime,
		'react-dom': reactDom,
		'react-dom/client': { createRoot },
		'@deepseek-ai/dsh-client-ui-primitives': primitives,
		'@deepseek-ai/dsh-client-store': store,
		zod: (await import(pathToFileURL(join(root, 'node_modules', 'zod', 'index.js')).href)),
	};
}

/**
 * 从构建产物里取出本插件的模块工厂。
 *
 * `lib/client.js` 是 ModuleLoader 包络：它把工厂交给 `window.__ModuleLoader__.load`。
 * 这里用一个最小的假装载器接住工厂，再喂平台模块替身，即可在 Node 里实例化同一个
 * 模块体——与浏览器里跑的是同一份代码。
 *
 * @returns 模块导出的对象。
 */
async function loadClientModule() {
	const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
	const registrations = [];
	globalThis.window = { __ModuleLoader__: { load: (registration) => { registrations.push(registration); } } };
	try {
		// 包络只做注册，不执行模块体；顶层的样式注入在无 document 时自行返回。
		new Function(bundle)();
	} finally {
		delete globalThis.window;
	}
	const registration = registrations.find((item) => item.id === 'dsh-source-control');
	assert.ok(registration !== undefined, 'lib/client.js 必须注册本插件的模块');
	const platform = await platformModules();
	const require = (spec) => {
		if (!(spec in platform)) throw new Error(`测试的平台模块表缺少 ${spec}`);
		return platform[spec];
	};
	require.async = async (spec) => require(spec);
	require.asset = (reference) => reference;
	return registration.factory(require);
}

const clientModule = await loadClientModule();
const adapter = clientModule.__forgeAdapter;

/** 一份典型的文本比较：一处替换，两侧都有内容。 */
const TEXT_DIFF = {
	path: 'src/app.ts',
	oldText: 'const a = 1\nconst b = 2\nconst c = 3\n',
	newText: 'const a = 1\nconst b = 20\nconst c = 3\nconst d = 4\n',
	binary: false,
	hunks: [
		{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' const a = 1', '-const b = 2', '+const b = 20', ' const c = 3', '+const d = 4'] },
	],
};

test('hunk 形状逐字段映射到 forge', () => {
	assert.ok(adapter !== undefined, '适配层必须从模块里导出，供测试与内部复用');
	const hunks = adapter.toForgeHunks(TEXT_DIFF);
	assert.equal(hunks.length, 1);
	assert.deepEqual(hunks[0], {
		oldStart: 1,
		oldLines: 3,
		newStart: 1,
		newLines: 4,
		lines: TEXT_DIFF.hunks[0].lines,
	});
	assert.notEqual(hunks[0], TEXT_DIFF.hunks[0], '必须换一个对象，不能把宿主的数组当成只读类型塞过去');
});

test('行数统计与宿主 hunk 前缀一致', () => {
	assert.deepEqual(adapter.countLines(TEXT_DIFF), { additions: 2, deletions: 1 });
});

test('二进制差异没有 hunk 时行数为零', () => {
	assert.deepEqual(adapter.countLines({ ...TEXT_DIFF, binary: true, hunks: [] }), { additions: 0, deletions: 0 });
});

test('文件状态按两侧内容判定', () => {
	assert.equal(adapter.statusOf(TEXT_DIFF), 'modified');
	assert.equal(adapter.statusOf({ ...TEXT_DIFF, oldText: null }), 'added');
	assert.equal(adapter.statusOf({ ...TEXT_DIFF, newText: null }), 'deleted');
});

test('文件记录带齐 forge 要求的字段', () => {
	const file = adapter.toForgeFile('src/app.ts', TEXT_DIFF);
	assert.equal(file.path, 'src/app.ts');
	assert.equal(file.previousPath, null);
	assert.equal(file.status, 'modified');
	assert.equal(file.binary, false);
	assert.equal(file.oversized, false);
	assert.equal(file.untracked, false);
	assert.equal(file.additions, 2);
	assert.equal(file.deletions, 1);
	assert.equal(file.hunks.length, 1);
	assert.equal(typeof file.layer, 'string');
	assert.equal(typeof file.digest, 'string');
});

test('评论的终点是输入框，且引用不带代码片段', () => {
	// 选区与拼接见 line-range.test.mjs 与 comment-reference.test.mjs；
	// 这里只确认适配层把它交给 forge 评论框时不再夹带差异片段。
	const source = readFileSync(new URL('../src/client/diff/forge-adapter.tsx', import.meta.url), 'utf8');
	const call = /formatCommentQuote\(([\s\S]*?)\)\)/.exec(source);
	assert.ok(call !== null, '应通过 formatCommentQuote 生成引用');
	assert.ok(!call[1].includes('hunk'), '引用不应把差异片段传给格式化函数');
	assert.match(source, /addToInput/, '应把引用交给输入框');
	assert.match(source, /ReviewComposer/, '评论框用 forge 的原生组件');
});

test('jsdom 里真实渲染 forge 的 DiffFile', { skip }, async () => {
	const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
	const globalKeys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver'];
	const saved = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	/** 用属性描述符覆盖，Node 的 navigator 只有 getter，直接赋值会抛错。 */
	const setGlobal = (key, value) => {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	};
	setGlobal('window', dom.window);
	setGlobal('document', dom.window.document);
	setGlobal('navigator', dom.window.navigator);
	setGlobal('HTMLElement', dom.window.HTMLElement);
	setGlobal('Element', dom.window.Element);
	setGlobal('Node', dom.window.Node);
	setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
	setGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
	setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
	setGlobal('IntersectionObserver', undefined);

	try {
		const React = await import(pathToFileURL(join(root, 'node_modules', 'react', 'index.js')).href);
		const { createRoot } = await import(pathToFileURL(join(root, 'node_modules', 'react-dom', 'client.js')).href);
		const reactRoot = createRoot(document.getElementById('root'));
		// 在无 IntersectionObserver 的全局下创建，观察器会立即回执，行因此被绘制。
		const reach = adapter.createSectionReach();
		await new Promise((resolve, reject) => {
			reactRoot.render(React.createElement(adapter.ForgeDiffView, {
				path: 'src/app.ts',
				content: TEXT_DIFF,
				scope: { kind: 'worktree', staged: false },
				split: false,
				wrap: true,
				state: { expanded: true, revealed: false, open: new Set() },
				setState: () => {},
				reach,
				addToInput: () => true,
			}));
			setTimeout(resolve, 120);
		}).catch((error) => { throw error; });

		const html = document.getElementById('root').innerHTML;
		assert.ok(html.length > 0, '必须渲染出内容');
		assert.match(html, /app\.ts/, '显示文件路径');
		assert.match(html, /const b = 20/, '显示新增行');
		// 已审阅控件（唯一带 data-disabled 的 label）由样式隐藏，DOM 里仍存在但不可见。
		const viewed = document.querySelector('label[data-disabled]');
		assert.ok(viewed !== null, 'forge 的画法仍会渲染该控件，由样式隐藏');
		assert.equal(viewed.querySelector('input[type="checkbox"]')?.disabled, true);
		// 行由本插件接管选择：每行都带行号属性，供选区读出连续区间。
		const numbered = document.querySelectorAll('[data-old-line], [data-new-line]');
		assert.ok(numbered.length > 0, '行应带行号属性，供选区读出区间');
		assert.equal(document.querySelector('[data-review-side]'), null, 'forge 的行号按钮已撤掉，避免两套手势抢指针');
		await reactRoot.unmount();
	} finally {
		for (const [key, descriptor] of saved) {
			if (descriptor === undefined) delete globalThis[key];
			else Object.defineProperty(globalThis, key, descriptor);
		}
		dom.window.close();
	}
});

