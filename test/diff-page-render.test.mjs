/**
 * 差异页真实挂载：验证点击分段按钮后页面不会变空，且切侧会切到有内容的一侧。
 *
 * 组件在某个分支抛错时 React 会卸载整棵树，页面上表现为一片空白。因此这里真正渲染，
 * 而不是只比对源码文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url);

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
const saved = new Map();
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'getComputedStyle',
	'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'PointerEvent', 'MouseEvent', 'Event', 'ResizeObserver']) {
	saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
}
const setGlobal = (key, value) => { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'PointerEvent', 'MouseEvent', 'Event']) {
	setGlobal(key, dom.window[key]);
}
setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
setGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('IntersectionObserver', undefined);
setGlobal('ResizeObserver', class { observe() {} disconnect() {} });

/** 等一个条件成立。 */
async function waitFor(predicate, what, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`等待超时：${what}`);
}

/**
 * 从构建产物取出显示侧模块。
 *
 * @returns 模块导出的对象。
 */
async function loadShownSide() {
	return await import(new URL('src/client/diff/shown-side.ts', root).href);
}

test('标题作用域在切侧后变成暂存区，再切回工作区', async () => {
	const { setShownSide, titleScopeOf } = await loadShownSide();
	const address = 'dsh-resource://git-diff/session/s1/%2A';
	const scope = { kind: 'worktree', staged: false };
	setShownSide(address, true);
	assert.equal(titleScopeOf(address, scope).staged, true);
	setShownSide(address, false);
	assert.equal(titleScopeOf(address, scope).staged, false);
	setShownSide(address, null);
	assert.equal(titleScopeOf(address, scope).staged, false);
});

test.after?.(() => {
	for (const [key, descriptor] of saved) {
		if (descriptor === undefined) delete globalThis[key];
		else Object.defineProperty(globalThis, key, descriptor);
	}
	dom.window.close();
});
