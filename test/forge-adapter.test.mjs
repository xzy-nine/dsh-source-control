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
 * 轮询等待一个条件成立。
 *
 * 渲染分多个轮次落地（观察器回执 → 状态更新 → 行落到 DOM），固定延时时长在慢机器上
 * 会偶发拿到中间态。等条件本身成立，结果与机器速度无关。
 *
 * @param predicate - 条件。
 * @param what - 条件描述，超时时用来说明等的是什么。
 * @param timeoutMs - 最长等待时间。
 * @returns 条件成立时结束。
 */
async function waitFor(predicate, what, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`等待超时：${what}`);
}

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
		// 在无 IntersectionObserver 的全局下创建，观察器立即回执；行在随后的渲染轮次里才落到 DOM，
		// 因此等它出现而不是等固定时长——CI 机器更慢，固定时长会偶发拿到未绘制的占位盒。
		const reach = adapter.createSectionReach();
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
		await waitFor(() => document.querySelector('[data-old-line], [data-new-line]') !== null, 'diff lines');

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

/** 一份冲突差异：新侧是工作区全文，带三行冲突标记。 */
const CONFLICT_DIFF = {
	path: 'conflict.txt',
	oldText: 'base\n',
	newText: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n',
	binary: false,
	conflict: true,
	conflictKind: 'both-modified',
	conflictStages: { base: true, ours: true, theirs: true },
	hunks: [
		{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 5, lines: ['-base', '+<<<<<<< HEAD', '+ours', '+=======', '+theirs', '+>>>>>>> side'] },
	],
};

test('冲突文件的状态按冲突种类判定', () => {
	assert.equal(adapter.statusOf(CONFLICT_DIFF), 'modified');
	// 双方都删的冲突两侧都没有内容：不能读成新增。
	assert.equal(adapter.statusOf({ ...CONFLICT_DIFF, oldText: null, newText: null, conflictKind: 'both-deleted' }), 'deleted');
});
/** 一段两处冲突的全文：用来证明「按段」而不是「整文件」处理。 */
const TWO_SECTION_TEXT = [
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

test('jsdom 里渲染逐段左右对照：每段中间都有动作，点击回投该段下标', { skip }, async () => {
	const view = clientModule;
	assert.ok(view !== undefined, '分栏视图必须从产物里导出，供测试与页面复用');
	const calls = [];
	const allCalls = [];
	const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
	const saved = new Map(['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']
		.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	const setGlobal = (key, value) => { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
	setGlobal('window', dom.window);
	setGlobal('document', dom.window.document);
	setGlobal('navigator', dom.window.navigator);
	setGlobal('HTMLElement', dom.window.HTMLElement);
	setGlobal('Element', dom.window.Element);
	setGlobal('Node', dom.window.Node);
	setGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
	setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
	try {
		const React = await import(pathToFileURL(join(root, 'node_modules', 'react', 'index.js')).href);
		const { createRoot } = await import(pathToFileURL(join(root, 'node_modules', 'react-dom', 'client.js')).href);
		const reactRoot = createRoot(document.getElementById('root'));
		reactRoot.render(React.createElement(clientModule.ConflictView, {
			text: TWO_SECTION_TEXT,
			wrap: true,
			busy: false,
			onResolveSection: (index, side) => { calls.push([index, side]); },
			onResolveAll: (side) => { allCalls.push(side); },
		}));
		await waitFor(() => document.querySelector('[data-sc-section]') !== null, 'section rows');

		const sections = [...document.querySelectorAll('[data-sc-section]')];
		assert.equal(sections.length, 2, '两处冲突各自成段');

		// 每段中间五个动作：左 / 右 / 合 / 基 / 删。
		const firstActions = [...sections[0].querySelectorAll('[data-sc-section-action]')].map((node) => node.getAttribute('data-sc-section-action'));
		assert.deepEqual(firstActions, ['ours', 'theirs', 'both', 'base', 'none'], '中间一列是本段的动作');

		// 段落两侧各显示自己那一侧的内容。
		const html = document.getElementById('root').innerHTML;
		assert.match(html, /line2-OURS/);
		assert.match(html, /line2-THEIRS/);
		assert.ok(!html.includes('<<<<<<<'), '标记行不直接画出来');
		assert.match(html, /line1/, '冲突之外的普通行照常显示');

		// 点第一段的「取对方」，回投的是第 0 段。
		sections[0].querySelector('[data-sc-section-action="theirs"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		assert.deepEqual(calls, [[0, 'theirs']]);

		// 点第二段的「取我方」，回投第 1 段：证明动作按段而非按文件。
		sections[1].querySelector('[data-sc-section-action="ours"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		assert.deepEqual(calls, [[0, 'theirs'], [1, 'ours']]);

		// 顶部「全部取我方」是整文件入口。
		const allButton = [...document.querySelectorAll('button')].find((node) => node.textContent === '全部取我方');
		assert.ok(allButton !== undefined, '整文件入口仍在');
		allButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		assert.deepEqual(allCalls, ['ours']);

		await reactRoot.unmount();
	} finally {
		for (const [key, descriptor] of saved) {
			if (descriptor === undefined) delete globalThis[key];
			else Object.defineProperty(globalThis, key, descriptor);
		}
		dom.window.close();
	}
});

test('没有冲突标记时给出已解决说明', { skip }, async () => {
	const view = clientModule;
	const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
	const saved = new Map(['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']
		.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	const setGlobal = (key, value) => { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
	setGlobal('window', dom.window);
	setGlobal('document', dom.window.document);
	setGlobal('navigator', dom.window.navigator);
	setGlobal('HTMLElement', dom.window.HTMLElement);
	setGlobal('Element', dom.window.Element);
	setGlobal('Node', dom.window.Node);
	setGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
	setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
	try {
		const React = await import(pathToFileURL(join(root, 'node_modules', 'react', 'index.js')).href);
		const { createRoot } = await import(pathToFileURL(join(root, 'node_modules', 'react-dom', 'client.js')).href);
		const reactRoot = createRoot(document.getElementById('root'));
		reactRoot.render(React.createElement(clientModule.ConflictView, {
			text: 'a\nb\n', wrap: true, busy: false, onResolveSection: () => {}, onResolveAll: () => {},
		}));
		await waitFor(() => document.querySelector('[data-sc-conflict-view]') !== null, 'conflict view');
		assert.match(document.getElementById('root').textContent, /已没有冲突标记/);
		await reactRoot.unmount();
	} finally {
		for (const [key, descriptor] of saved) {
			if (descriptor === undefined) delete globalThis[key];
			else Object.defineProperty(globalThis, key, descriptor);
		}
		dom.window.close();
	}
});