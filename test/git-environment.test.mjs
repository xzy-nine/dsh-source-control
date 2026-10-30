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

/** 语言变量名：git 的提示文本语言由这三项决定。 */
const LANGUAGE_KEYS = ['LANGUAGE', 'LC_ALL', 'LANG'];

/**
 * 在指定的语言变量下执行一段断言，随后恢复父进程取值。
 *
 * @param values - 本次执行期间的语言变量；键缺省表示删除该变量。
 * @param run - 断言体。
 * @returns 无。
 */
function withLanguageEnv(values, run) {
	const saved = LANGUAGE_KEYS.map((key) => [key, process.env[key]]);
	try {
		for (const key of LANGUAGE_KEYS) {
			if (values[key] === undefined) delete process.env[key];
			else process.env[key] = values[key];
		}
		run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test('输出语言固定为英文', () => {
	// 父进程未给出语言变量时补英文；测试先清空，避免继承运行环境的取值。
	withLanguageEnv({}, () => {
		const env = gitEnvironment(true);
		assert.equal(env.LANGUAGE, 'en');
		assert.equal(env.LC_ALL, 'en_US.UTF-8');
		assert.equal(env.LANG, 'en_US.UTF-8');
	});
});

test('父进程已给出的语言设置保留', () => {
	withLanguageEnv({ LANGUAGE: 'zh_CN', LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' }, () => {
		const env = gitEnvironment(true);
		assert.equal(env.LANGUAGE, 'zh_CN');
		assert.equal(env.LC_ALL, 'zh_CN.UTF-8');
		assert.equal(env.LANG, 'zh_CN.UTF-8');
	});
});

test('凭据交互与分页始终禁用', () => {
	for (const readOnly of [true, false]) {
		const env = gitEnvironment(readOnly);
		assert.equal(env.GIT_TERMINAL_PROMPT, '0');
		assert.equal(env.GIT_PAGER, 'cat');
		assert.equal(env.GIT_EDITOR, 'true');
	}
});
