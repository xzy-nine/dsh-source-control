/**
 * 拖动选区的交互测试：按下 → 划过若干行 → 松开，区间必须保持，不能塌回起始行。
 *
 * 这条用例守着一次真实回归：松开时若按起始行落定，拖动过程中的高亮正确、一松手区间
 * 就退回单行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { JSDOM } = await import('jsdom');

/**
 * 平台模块的测试替身。
 *
 * @returns 平台模块表。
 */
async function platformModules() {
	const React = await import(pathToFileURL(join(root, 'node_modules', 'react', 'index.js')).href);
	const { createRoot } = await import(pathToFileURL(join(root, 'node_modules', 'react-dom', 'client.js')).href);
	const reactDom = await import(pathToFileURL(join(root, 'node_modules', 'react-dom', 'index.js')).href);
	const jsxRuntime = await import(pathToFileURL(join(root, 'node_modules', 'react', 'jsx-runtime.js')).href);
	const Stub = (props) => React.createElement('div', null, props?.children ?? null);
	const icon = () => React.createElement('span', null);
	const primitives = new Proxy({
		Button: (p) => React.createElement('button', { onClick: p.onClick, disabled: p.disabled }, p.children),
		Tag: Stub, Tooltip: (p) => React.createElement('span', null, p.children), Menu: Stub, MenuItemButton: Stub,
		PathLabel: Stub, FileTypeIcon: Stub, FoldToggle: Stub, CodeToolbar: Stub,
		useCodeHighlighter: () => () => undefined, languageForPath: () => undefined,
		relativeTime: () => '', writeClipboard: async () => true,
	}, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^Icon/.test(k) ? icon : Stub) });
	return {
		react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': reactDom,
		'react-dom/client': { createRoot },
		'@deepseek-ai/dsh-client-ui-primitives': primitives,
		'@deepseek-ai/dsh-client-store': { defineStore: () => ({}), createSnapshotStore: (v) => ({ getSnapshot: () => v, set: () => {}, subscribe: () => () => {} }) },
		zod: await import(pathToFileURL(join(root, 'node_modules', 'zod', 'index.js')).href),
	};
}

/**
 * 从构建产物实例化本插件的浏览器半边。
 *
 * @returns 模块导出的对象。
 */
async function loadClientModule() {
	const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
	const regs = [];
	globalThis.window = { __ModuleLoader__: { load: (r) => { regs.push(r); } } };
	try { new Function(bundle)(); } finally { delete globalThis.window; }
	const registration = regs.find((r) => r.id === 'dsh-source-control');
	assert.ok(registration !== undefined, 'lib/client.js 必须注册本插件');
	const platform = await platformModules();
	const require = (spec) => {
		if (!(spec in platform)) throw new Error(`测试的平台模块表缺少 ${spec}`);
		return platform[spec];
	};
	require.async = async (s) => require(s);
	require.asset = (reference) => reference;
	return registration.factory(require);
}

const clientModule = await loadClientModule();
const adapter = clientModule.__forgeAdapter;

/** 一个 hunk 覆盖第 10 到 20 行，便于验证跨 hunk 的拖动。 */
const TEXT_DIFF = {
	path: 'src/app.ts',
	oldText: 'a\nb\nc\nd\n',
	newText: 'a\nb\nc\nd\ne\nf\ng\n',
	binary: false,
	hunks: [{
		oldStart: 10, oldLines: 4, newStart: 10, newLines: 7,
		lines: [' a', ' b', ' c', '-d', '+d2', '+e', '+f', '+g'],
	}],
};

test('松开鼠标后区间保持，不塌回起始行', async () => {
	const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
	const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'getComputedStyle',
		'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'PointerEvent', 'MouseEvent', 'Event'];
	const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	const setGlobal = (key, value) => {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	};
	for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'PointerEvent', 'MouseEvent', 'Event']) {
		setGlobal(key, dom.window[key]);
	}
	setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
	setGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
	setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
	setGlobal('IntersectionObserver', undefined);

	try {
		const React = await import(pathToFileURL(join(root, 'node_modules', 'react', 'index.js')).href);
		const { createRoot } = await import(pathToFileURL(join(root, 'node_modules', 'react-dom', 'client.js')).href);
		const reactRoot = createRoot(document.getElementById('root'));
		reactRoot.render(React.createElement(adapter.ForgeDiffView, {
			path: 'src/app.ts',
			content: TEXT_DIFF,
			scope: { kind: 'worktree', staged: false },
			split: false,
			wrap: true,
			state: { expanded: true, revealed: false, open: new Set() },
			setState: () => {},
			reach: adapter.createSectionReach(),
			addToInput: () => true,
		}));
		await new Promise((resolve) => setTimeout(resolve, 150));

		const rows = [...document.querySelectorAll('[data-diff-line]')];
		assert.ok(rows.length >= 3, `行应已绘制，实际 ${rows.length}`);
		const [first, , third] = rows;

		first.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 1 }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		third.dispatchEvent(new dom.window.PointerEvent('pointerover', { bubbles: true, buttons: 1, pointerId: 1 }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		// 拖动过程中应有多行高亮。
		assert.equal(document.querySelectorAll('[data-sc-range]').length, 3, '拖动中应选中三行');
		window.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, buttons: 0, pointerId: 1 }));
		await new Promise((resolve) => setTimeout(resolve, 60));

		// 松开后区间必须保持三行，而不是退回一行。
		assert.equal(document.querySelectorAll('[data-sc-range]').length, 3, '松开后区间应保持三行');

		// forge 的评论框给出区间，行号跨越首尾。
		const composer = document.querySelector('[data-forge-comment]');
		assert.ok(composer !== null, '应弹出 forge 的评论框');
		assert.equal(composer.getAttribute('data-forge-comment'), 'R10-12', '评论框应显示跨多行的区间');

		// 评论框按文档流紧跟文件段，不应用 flex 挤到底部。
		const host = document.querySelector('[data-sc-host]');
		assert.ok(host !== null, '外层应带标记以便断言布局');
		assert.equal(host.firstElementChild?.hasAttribute('data-forge-diff-file') ?? false, true, '第一个子元素应是文件段');
		assert.ok(host.contains(composer), '评论框应在外层之内、紧跟文件段');
		await reactRoot.unmount();
	} finally {
		for (const [key, descriptor] of saved) {
			if (descriptor === undefined) delete globalThis[key];
			else Object.defineProperty(globalThis, key, descriptor);
		}
		dom.window.close();
	}
});
