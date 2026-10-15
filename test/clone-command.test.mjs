/**
 * 终端克隆命令构造与终端执行的测试。
 *
 * 命令一行一个，覆盖地址形态、拒绝条件与引号规则；终端执行用替身验证开页、等待可写与超时。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneTerminalCommand, repositoryNameOf } from '../src/client/git/clone-command.ts';

/** 一个可观察替身：手动触发订阅者。 */
function observableOf(initial) {
	let value = initial;
	const listeners = new Set();
	return {
		getSnapshot: () => value,
		subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		set: (next) => { value = next; for (const listener of [...listeners]) listener(); },
	};
}

/**
 * 构造侧边栏与终端替身。
 *
 * `writable` 为 false 时新页永不变成可写，用于验证等待超时。
 */
function terminalDouble({ writable = true, openTabThrows = false } = {}) {
	const openTabs = observableOf([]);
	const state = observableOf({ writable: false });
	const written = [];
	return {
		written,
		deps: {
			sidebarRight: {
				openTabs,
				openTab: () => {
					if (openTabThrows) throw new Error('no session on screen');
					openTabs.set([{ sessionId: 's1', tabId: 't1', kind: 'terminal', contentId: 'c1' }]);
					if (writable) setTimeout(() => state.set({ writable: true }), 0);
				},
			},
			terminals: {
				view: () => ({ state, write: (data) => { written.push(data); } }),
			},
		},
	};
}

test('克隆命令只依赖 git -C 与引号包裹的地址', () => {
	assert.equal(
		cloneTerminalCommand('C:\\work\\repos', 'https://github.com/owner/repo.git'),
		'git -C "C:\\work\\repos" clone -- "https://github.com/owner/repo.git"',
	);
	assert.equal(
		cloneTerminalCommand('/home/u/repos/', 'git@github.com:owner/repo.git'),
		'git -C "/home/u/repos" clone -- "git@github.com:owner/repo.git"',
	);
});

test('仓库名取地址末段并去掉 .git 后缀', () => {
	assert.equal(repositoryNameOf('https://github.com/owner/repo.git'), 'repo');
	assert.equal(repositoryNameOf('git@github.com:owner/repo.git'), 'repo');
	assert.equal(repositoryNameOf('ssh://git@github.com/owner/repo'), 'repo');
	assert.equal(repositoryNameOf('https://github.com'), '');
	assert.equal(repositoryNameOf(''), '');
});

test('空地址、选项式地址与无法转义的字符都拒绝', () => {
	assert.equal(cloneTerminalCommand('C:\\repos', ''), null);
	assert.equal(cloneTerminalCommand('C:\\repos', '--upload-pack=evil'), null);
	assert.equal(cloneTerminalCommand('', 'https://github.com/owner/repo.git'), null);
	assert.equal(cloneTerminalCommand('C:\\re$pos', 'https://github.com/owner/repo.git'), null);
	assert.equal(cloneTerminalCommand('C:\\repos', 'https://github.com/owner/re$po.git'), null);
	assert.equal(cloneTerminalCommand('C:\\repos', 'https://github.com/owner/repo.git'), 'git -C "C:\\repos" clone -- "https://github.com/owner/repo.git"');
});

test('终端就绪后写入命令并回车', async () => {
	const { written, deps } = terminalDouble();
	const { runInTerminal } = await import('../src/client/git/terminal-run.ts');
	assert.equal(await runInTerminal(deps, 's1', 'git -C "C:\\repos" clone -- "u"'), true);
	assert.deepEqual(written, ['git -C "C:\\repos" clone -- "u"\r']);
});

test('打开终端页失败或一直不可写时返回 false', async () => {
	const { runInTerminal } = await import('../src/client/git/terminal-run.ts');
	assert.equal(await runInTerminal({ sidebarRight: undefined, terminals: undefined }, 's1', 'git clone x'), false);
	const throwing = terminalDouble({ openTabThrows: true });
	assert.equal(await runInTerminal(throwing.deps, 's1', 'git clone x'), false);
});
