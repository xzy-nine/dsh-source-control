/**
 * 客户端产物冒烟：在模拟的浏览器环境与 ModuleLoader 下加载 lib/client.js，
 * 校验包络、外部模块请求与 apply 注册行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** jsdom 的 JSDOM 构造；包无法加载时为 null（仅样式表契约需要它）。 */
let JSDOM = null;
try {
	({ JSDOM } = await import('jsdom'));
} catch {
	JSDOM = null;
}
const skipJsdom = JSDOM === null ? '未安装 jsdom，跳过产物样式表契约' : false;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bundlePath = join(root, 'lib', 'client.js');

/** 造一个最小的 React 替身：只记录 createElement 的调用。 */
function makeReact() {
	const created = [];
	const React = {
		createElement: (...args) => ({ __element: true, args, created: created.push(args) }),
		useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
		useEffect: () => {},
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
		useRef: (init) => ({ current: init ?? null }),
		// 真实 React 的 memo 返回组件；冒烟只关心调用形态，原样返回。
		memo: (component) => component,
		Fragment: Symbol('Fragment'),
	};
	return React;
}

/**
 * 在模拟环境里加载产物。
 *
 * @returns 记录到的外部模块请求与注册信息。
 */
function loadBundle() {
	const source = readFileSync(bundlePath, 'utf8');
	const requested = [];
	const registrations = [];
	let captured = null;
	const react = makeReact();
	const primitives = new Proxy({}, {
		get: (_target, name) => {
			if (name === '__esModule') return false;
			return function Stub() { return null; };
		},
	});
	const load = ({ id, factory }) => {
		registrations.push(id);
		captured = factory((name) => {
			requested.push(name);
			if (name === 'react') return { ...react, default: react };
			if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') };
			if (name === 'react-dom/client') return { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
			if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
			throw new Error(`未预期的外部模块请求：${name}`);
		});
	};
	globalThis.window = { __ModuleLoader__: { load } };
	globalThis.document = {
		getElementById: () => null,
		createElement: () => ({
			style: {}, classList: { add: () => {}, remove: () => {} },
			// 样式的归属标记经 setAttribute 写入。
			setAttribute: () => {},
			appendChild: () => {}, remove: () => {}, replaceWith: () => {},
		}),
		head: { appendChild: () => {} },
		body: { appendChild: () => {}, removeChild: () => {} },
	};
	globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
	globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
	// Node 的 navigator 是只读取值器，须用 defineProperty 覆盖。
	Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true, writable: true });
	// eslint-disable-next-line no-eval
	const module = { exports: {} };
	new Function('module', 'exports', 'window', 'document', source)(module, module.exports, globalThis.window, globalThis.document);
	return { requested, registrations, client: captured ?? module.exports };
}

test('产物包络注册为包名并只请求外部平台模块', () => {
	const { requested, registrations } = loadBundle();
	assert.deepEqual(registrations, ['dsh-source-control']);
	for (const name of requested) {
		assert.ok(
			['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives'].includes(name),
			`产物请求了未外部化的模块：${name}`,
		);
	}
	assert.ok(requested.includes('react'), '产物应请求 react');
	assert.ok(requested.includes('@deepseek-ai/dsh-client-ui-primitives'), '产物应请求 ui-primitives');
});

test('apply 注册右侧栏页类型与 header 入口', () => {
	const { client } = loadBundle();
	assert.equal(typeof client.apply, 'function', '入口应导出 apply');
	assert.deepEqual(client.inject, ['sessions', 'slots', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.session']);
	const registered = [];
	const effects = [];
	const slots = {
		inject: (seat, register) => { registered.push(seat); return register(); },
		register: (spec) => ({ spec }),
	};
	const rightTabs = { register: (spec) => { registered.push(spec.id); return spec; } };
	const ctx = {
		slots,
		sidebarRightTabs: rightTabs,
		sidebarRight: { openTab: () => {} },
		effect: (fn) => { effects.push(fn); fn(); },
	};
	client.apply(ctx);
	assert.ok(effects.length > 0, 'apply 必须通过 ctx.effect 注册');
	assert.ok(registered.includes('dsh-source-control/panel'), '应注册面板页类型');
	assert.ok(registered.includes('dsh-source-control/diff'), '应注册差异页类型');
	assert.ok(registered.includes('sidebar.right.pane.tab'), '应注册侧栏正文席位');
	assert.ok(registered.includes('sidebar.right.pane.tab.title'), '应注册侧栏标题席位');
	assert.ok(registered.includes('conversation.session.header.utilities'), '应注册 header 入口');
});

test('产物样式表在就地替换后保留，且每次求值写入当前 CSS', { skip: skipJsdom }, () => {
	// 模块系统的就地替换顺序是「执行新脚本 → 移除 style[data-plugin=包名] → 材料化工厂」；
	// 产物样式表不标记归属，因此不会被清理带走，且再次求值会整份替换旧表。
	const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
	const { window } = dom;
	window.__ModuleLoader__ = { load: () => {} };
	const source = readFileSync(bundlePath, 'utf8');
	const run = () => {
		const module = { exports: {} };
		new Function('module', 'exports', 'window', 'document', source)(module, module.exports, window, window.document);
	};
	run();
	const first = window.document.getElementById('dsh-source-control-module-style');
	assert.ok(first !== null, '产物应注入内联样式表');
	for (const element of [...window.document.querySelectorAll('style[data-plugin]')]) element.remove();
	assert.equal(window.document.getElementById('dsh-source-control-module-style'), first, '样式表不应被模块系统的清理带走');
	run();
	const second = window.document.getElementById('dsh-source-control-module-style');
	assert.notEqual(second, first, '再次求值应整份替换旧样式表');
	assert.equal(window.document.querySelectorAll('style').length, 1, '替换后只保留一份样式表');
});
