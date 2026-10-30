/**
 * 执行层子进程环境：只读命令的可选锁开关、固定输出语言、写命令不受影响。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importHostModule } from './lib-import.mjs';

const { gitEnvironment } = await importHostModule('source-control/working-tree.js');

test('只读命令设 GIT_OPTIONAL_LOCKS=0，写命令不设', () => {
	assert.equal(gitEnvironment(true).GIT_OPTIONAL_LOCKS, '0');
	assert.equal(gitEnvironment(false).GIT_OPTIONAL_LOCKS, undefined);
	assert.equal(gitEnvironment().GIT_OPTIONAL_LOCKS, undefined, '缺省按写命令处理');
});

test('输出语言固定为英文', () => {
	const env = gitEnvironment(true);
	assert.equal(env.LANGUAGE, 'en');
	assert.equal(env.LC_ALL, 'en_US.UTF-8');
	assert.equal(env.LANG, 'en_US.UTF-8');
});

test('父进程已给出的语言设置保留', () => {
	const keys = ['LANGUAGE', 'LC_ALL', 'LANG'];
	const saved = keys.map((key) => [key, process.env[key]]);
	try {
		process.env.LANGUAGE = 'zh_CN';
		process.env.LC_ALL = 'zh_CN.UTF-8';
		process.env.LANG = 'zh_CN.UTF-8';
		const env = gitEnvironment(true);
		assert.equal(env.LANGUAGE, 'zh_CN');
		assert.equal(env.LC_ALL, 'zh_CN.UTF-8');
		assert.equal(env.LANG, 'zh_CN.UTF-8');
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test('凭据交互与分页始终禁用', () => {
	for (const readOnly of [true, false]) {
		const env = gitEnvironment(readOnly);
		assert.equal(env.GIT_TERMINAL_PROMPT, '0');
		assert.equal(env.GIT_PAGER, 'cat');
		assert.equal(env.GIT_EDITOR, 'true');
	}
});
