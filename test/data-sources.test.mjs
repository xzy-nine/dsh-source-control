/**
 * JSON 数据源的形状校验：右键菜单元数据与 AI 提交提示词。
 *
 * 两个数据源都由手写薄层直接读入（见 panel/menu-actions.ts、source-control/ai-commit-prompts.ts），
 * 缺键、空值、占位符写错在类型层看不出来，因此在这里挡住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** 读取一个 JSON 数据源。 */
function readJson(...segments) {
	return JSON.parse(readFileSync(join(root, ...segments), 'utf8'));
}

test('右键菜单元数据每项都有 id、标题与引用类型', () => {
	const { actions, commitMenuTexts } = readJson('src', 'client', 'panel', 'menu-actions.json');
	assert.ok(Array.isArray(actions) && actions.length > 0, 'actions 应为非空数组');

	const ids = new Set();
	for (const [at, action] of actions.entries()) {
		const where = `第 ${at + 1} 项`;
		assert.equal(typeof action.id, 'string', `${where}的 id 应为字符串`);
		assert.ok(action.id !== '', `${where}的 id 不应为空`);
		assert.ok(!ids.has(action.id), `id 重复：${action.id}`);
		ids.add(action.id);
		assert.ok(typeof action.title === 'string' && action.title !== '', `${action.id} 应有菜单名称`);
		assert.ok(Array.isArray(action.refTypes) && action.refTypes.length > 0, `${action.id} 应声明适用的引用类型`);
		assert.ok(action.refTypes.every((type) => typeof type === 'string' && type !== ''), `${action.id} 的 refTypes 应为非空字符串`);
		if (action.commitTarget !== undefined) assert.equal(action.commitTarget, 'tag', `${action.id} 的 commitTarget 只支持 tag`);
		if (action.danger !== undefined) assert.equal(typeof action.danger, 'boolean', `${action.id} 的 danger 应为布尔值`);
		for (const key of ['commitTitle', 'commitItemTitle', 'commitCurrentTitle', 'commitRemoteTitle']) {
			if (action[key] === undefined) continue;
			assert.ok(typeof action[key] === 'string' && action[key] !== '', `${action.id} 的 ${key} 不应为空`);
		}
	}

	assert.ok(commitMenuTexts !== null && typeof commitMenuTexts === 'object', 'commitMenuTexts 应为对象');
	for (const [key, text] of Object.entries(commitMenuTexts)) {
		assert.ok(typeof text === 'string' && text !== '', `固定文案 ${key} 不应为空`);
	}
});

test('菜单名称里的占位符只有 name', () => {
	const { actions, commitMenuTexts } = readJson('src', 'client', 'panel', 'menu-actions.json');
	const texts = [...actions.flatMap((action) => [action.title, action.commitTitle, action.commitItemTitle, action.commitCurrentTitle, action.commitRemoteTitle]), ...Object.values(commitMenuTexts)];
	for (const text of texts) {
		if (typeof text !== 'string') continue;
		for (const [placeholder] of text.matchAll(/\{[^}]*\}/g)) {
			assert.equal(placeholder, '{name}', `未知占位符 ${placeholder}：${text}`);
		}
	}
});

test('AI 提交提示词四段齐全且占位符可用', () => {
	const prompts = readJson('src', 'source-control', 'ai-commit-prompts.json');
	for (const key of ['system', 'language', 'request', 'requestAmend']) {
		assert.ok(typeof prompts[key] === 'string' && prompts[key].trim() !== '', `提示词 ${key} 应为非空字符串`);
	}
	assert.ok(prompts.language.includes('{language}'), '语言指令应含 {language} 占位符，否则代入无处可落');
	assert.ok(prompts.request.includes('{diff}'), '普通请求模板应含 {diff} 占位符');
	assert.ok(prompts.requestAmend.includes('{diff}'), '修补提交的请求模板应含 {diff} 占位符');
	// 语言为（含）时点与不指定时分别成立：不指定语言不追加。
	assert.ok(!prompts.system.includes('{'), '系统提示词不应含占位符');
});

test('变更区菜单元数据每项都有 id、标题与适用目标', () => {
	const { actions } = readJson('src', 'client', 'panel', 'change-menu-actions.json');
	assert.ok(Array.isArray(actions) && actions.length > 0, 'actions 应为非空数组');

	const targets = ['folder', 'file', 'group'];
	const ids = new Set();
	for (const [at, action] of actions.entries()) {
		const where = `第 ${at + 1} 项`;
		assert.equal(typeof action.id, 'string', `${where}的 id 应为字符串`);
		assert.ok(action.id !== '', `${where}的 id 不应为空`);
		assert.ok(!ids.has(action.id), `id 重复：${action.id}`);
		ids.add(action.id);
		assert.ok(typeof action.title === 'string' && action.title !== '', `${action.id} 应有菜单名称`);
		assert.ok(typeof action.group === 'string' && action.group !== '', `${action.id} 应声明所在分组`);
		assert.ok(Array.isArray(action.targets) && action.targets.length > 0, `${action.id} 应声明适用目标`);
		assert.ok(action.targets.every((target) => targets.includes(target)), `${action.id} 的 targets 只支持 ${targets.join(' / ')}`);
		if (action.danger !== undefined) assert.equal(typeof action.danger, 'boolean', `${action.id} 的 danger 应为布尔值`);
		for (const [target, text] of Object.entries(action.titles ?? {})) {
			assert.ok(targets.includes(target), `${action.id} 的 titles 出现未知目标：${target}`);
			assert.ok(typeof text === 'string' && text !== '', `${action.id} 的 ${target} 标题不应为空`);
		}
		for (const target of Object.keys(action.groupByTarget ?? {})) {
			assert.ok(action.targets.includes(target), `${action.id} 的 groupByTarget 覆盖了不适用目标：${target}`);
		}
	}

	// 三个目标都应有暂存与丢弃：曾因各自手写菜单而漏掉文件夹行的丢弃。
	for (const target of targets) {
		const applicable = actions.filter((action) => action.targets.includes(target)).map((action) => action.id);
		assert.ok(applicable.includes('stage'), `${target} 菜单应有暂存`);
		assert.ok(applicable.includes('discard'), `${target} 菜单应有丢弃`);
		assert.ok(applicable.includes('unstage'), `${target} 菜单应有取消暂存`);
	}
});

test('变更区菜单名称的占位符只有 count', () => {
	const { actions } = readJson('src', 'client', 'panel', 'change-menu-actions.json');
	const texts = actions.flatMap((action) => [action.title, ...Object.values(action.titles ?? {})]);
	for (const text of texts) {
		if (typeof text !== 'string') continue;
		for (const [placeholder] of text.matchAll(/\{[^}]*\}/g)) {
			assert.equal(placeholder, '{count}', `未知占位符 ${placeholder}：${text}`);
		}
	}
});
