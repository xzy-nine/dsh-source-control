/**
 * 宿主 API 客户端的错误处理。
 *
 * 两条约定：非 2xx 响应体里的 `error` 文本优先于状态码（宿主在 400 时同样回传它）；
 * 签名声明「返回错误文本」的函数必须把文本交给调用方，而不是内部抛出后让返回值恒为 null。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callApi, callApiRaw, pushUpstream, resetToCommit } from '../src/client/api/index.ts';

/**
 * 以给定的响应替换全局 fetch 跑一次调用。
 *
 * @param response - 伪造的响应。
 * @param run - 实际发起的调用。
 * @returns 调用结果或抛出的错误。
 */
async function withFetch(response, run = () => callApi('/repo', { command: 'x' })) {
	const original = globalThis.fetch;
	globalThis.fetch = async () => response;
	try {
		return { value: await run() };
	} catch (error) {
		return { error };
	} finally {
		globalThis.fetch = original;
	}
}

/** 构造一个响应替身。 */
function makeResponse(ok, status, text) {
	return { ok, status, text: async () => text };
}

test('400 响应体里的错误文本被采用', async () => {
	const result = await withFetch(makeResponse(false, 400, JSON.stringify({ error: '未知命令: no-such-cmd' })));
	assert.match(result.error.message, /未知命令/);
});

test('错误文本优先于状态码', async () => {
	const result = await withFetch(makeResponse(false, 500, JSON.stringify({ error: 'git 执行失败' })));
	assert.equal(result.error.message, 'git 执行失败');
});

test('响应体无错误文本时退回状态码', async () => {
	const result = await withFetch(makeResponse(false, 502, ''));
	assert.match(result.error.message, /502/);
});

test('非 JSON 响应体不中断错误处理', async () => {
	const result = await withFetch(makeResponse(false, 500, '<html>bad gateway</html>'));
	assert.match(result.error.message, /500/);
});

test('200 响应正常返回载荷', async () => {
	const result = await withFetch(makeResponse(true, 200, JSON.stringify({ command: 'x', value: 1 })));
	assert.deepEqual(result.value, { command: 'x', value: 1 });
});

test('200 响应里的错误文本仍抛出', async () => {
	const result = await withFetch(makeResponse(true, 200, JSON.stringify({ command: 'x', error: '操作失败' })));
	assert.equal(result.error.message, '操作失败');
});

test('callApiRaw 把错误文本留在返回值里', async () => {
	const result = await withFetch(
		makeResponse(true, 200, JSON.stringify({ command: 'x', error: '原始错误' })),
		() => callApiRaw('/repo', { command: 'x' }),
	);
	assert.equal(result.value.error, '原始错误');
});

test('callApiRaw 在非 2xx 且无错误文本时补状态码', async () => {
	const result = await withFetch(makeResponse(false, 502, ''), () => callApiRaw('/repo', { command: 'x' }));
	assert.match(result.value.error, /502/);
});

test('返回错误文本的封装函数把文本交给调用方而非抛出', async () => {
	// 这些函数的签名声明「错误文本，无错误时返回 null」；若内部走抛错版本，返回值恒为
	// null，需要按错误内容分支的调用方会静默失效。
	const upstream = await withFetch(
		makeResponse(true, 200, JSON.stringify({ error: 'fatal: No configured push destination.' })),
		() => pushUpstream('/repo'),
	);
	assert.equal(upstream.value, 'fatal: No configured push destination.');

	const reset = await withFetch(
		makeResponse(true, 200, JSON.stringify({ error: '重置失败' })),
		() => resetToCommit('/repo', 'abc'),
	);
	assert.equal(reset.value, '重置失败');
});
