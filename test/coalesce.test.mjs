/**
 * 并发合并等待的契约：等到载荷就返回它，超时返回 null 交给调用方自己跑。
 *
 * 判据是「超时不产出结果」：把超时当成载荷会让面板弹出操作失败，而并发到达的都是只读命令，
 * 重跑安全。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parallel } from './harness.mjs';
import { COALESCE_TIMEOUT_MS, waitCoalesced } from '../lib/src/source-control/api/coalesce.js';

parallel('并发合并等待', (t) => {
	t.test('在飞项先完成时返回它的载荷', async () => {
		const payload = { command: 'loadCommits', error: null };
		const result = await waitCoalesced(Promise.resolve(payload), 200);
		assert.equal(result, payload, '应原样返回在飞项的结果');
	});

	t.test('超过等待上限返回 null，由调用方自己执行', async () => {
		const slow = new Promise((resolve) => { setTimeout(() => { resolve({ command: 'x' }); }, 500); });
		const result = await waitCoalesced(slow, 50);
		assert.equal(result, null, '超时不回错误载荷');
	});

	t.test('在飞项晚于超时完成也不改变已返回的 null', async () => {
		let settled = false;
		const slow = new Promise((resolve) => { setTimeout(() => { settled = true; resolve({ ok: true }); }, 120); });
		assert.equal(await waitCoalesced(slow, 30), null);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(settled, true, '在飞项仍然跑完，结果进缓存');
	});

	t.test('默认上限为 30 秒', () => {
		assert.equal(COALESCE_TIMEOUT_MS, 30000);
	});
});
