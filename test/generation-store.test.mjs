/**
 * AI 生成任务的归属与上屏契约。
 *
 * 判据取自事故：在仓库 A 生成提交信息、生成中切到子模块，结果写进了子模块的提交框。根因是
 * 生成状态活在组件实例里，换仓库即换实例。这里守护三条：任务按发起仓库登记、结果只交付一次、
 * 上屏要同时满足「属于当前仓库 + 生成已结束 + 提交框在屏幕上 + 草稿已读完」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	appendGeneration, beginGeneration, clearGeneration, endGeneration, generationStateOf,
	noteGenerationStats, resetGenerationsForTests, subscribeGeneration, takeGenerationText, warnGeneration,
} from '../src/client/panel/generation-store.ts';
import { canLandGeneration } from '../src/client/panel/generation-landing.ts';
import { parallel } from './harness.mjs';

/** 每个用例前后清空登记，避免互相看见对方的仓库键。 */
function fresh(t) {
	resetGenerationsForTests();
	t.after(() => { resetGenerationsForTests(); });
}

parallel('生成任务归属', (t) => {
	t.test('生成只写发起时的仓库，不写当前活跃的另一个', (t) => {
		fresh(t);
		const repoA = '/repo/a';
		const submodule = '/repo/a/sub';
		beginGeneration(repoA);
		appendGeneration(repoA, 'feat: 改 A');
		// 生成期间切到子模块：子模块的登记仍是空的，A 的文本还在。
		assert.equal(generationStateOf(submodule).text, '', '子模块不应收到 A 的文本');
		assert.equal(generationStateOf(submodule).busy, false, '子模块不应显示生成中');
		assert.equal(generationStateOf(repoA).text, 'feat: 改 A');
	});

	t.test('生成中切换仓库不中断：结束后结果仍在发起仓库', (t) => {
		fresh(t);
		beginGeneration('/repo/a');
		appendGeneration('/repo/a', 'feat: 一');
		appendGeneration('/repo/a', 'feat: 二');
		endGeneration('/repo/a');
		assert.equal(generationStateOf('/repo/a').busy, false);
		assert.equal(generationStateOf('/repo/a').text, 'feat: 一feat: 二');
	});

	t.test('结果只交付一次，切回不会重复写', (t) => {
		fresh(t);
		beginGeneration('/repo/a');
		appendGeneration('/repo/a', 'feat: 改 A');
		endGeneration('/repo/a');
		assert.equal(takeGenerationText('/repo/a'), 'feat: 改 A');
		assert.equal(takeGenerationText('/repo/a'), null, '第二次取走应已清空');
	});

	t.test('进行中的任务不交付', (t) => {
		fresh(t);
		beginGeneration('/repo/a');
		appendGeneration('/repo/a', '半截');
		assert.equal(takeGenerationText('/repo/a'), null);
		assert.equal(generationStateOf('/repo/a').text, '半截', '仍在生成时文本保留');
	});

	t.test('告警与统计同样按仓库归属', (t) => {
		fresh(t);
		beginGeneration('/repo/a');
		warnGeneration('/repo/a', '模型未配置');
		noteGenerationStats('/repo/a', { tokens: 12 });
		assert.equal(generationStateOf('/repo/a').warning, '模型未配置');
		assert.deepEqual(generationStateOf('/repo/a').stats, { tokens: 12 });
		assert.equal(generationStateOf('/repo/b').warning, '', '别的仓库不受影响');
	});

	t.test('路径写法不同视为同一仓库', (t) => {
		fresh(t);
		beginGeneration('E:\\Repo\\A');
		appendGeneration('e:/repo/a/', 'x');
		assert.equal(generationStateOf('E:\\Repo\\A').text, 'x');
	});

	t.test('订阅者在状态变化时收到通知，取消后不再收到', (t) => {
		fresh(t);
		let calls = 0;
		const unsubscribe = subscribeGeneration('/repo/a', () => { calls += 1; });
		beginGeneration('/repo/a');
		appendGeneration('/repo/a', 'x');
		assert.equal(calls, 2);
		unsubscribe();
		endGeneration('/repo/a');
		assert.equal(calls, 2, '取消订阅后不再收到');
	});

	t.test('清空登记后回到空状态', (t) => {
		fresh(t);
		beginGeneration('/repo/a');
		clearGeneration('/repo/a');
		assert.deepEqual(generationStateOf('/repo/a'), { text: '', busy: false, warning: '', stats: null });
	});
});

parallel('生成结果上屏判据', (t) => {
	/** 一份全部满足的输入。 */
	const ok = { generationRepo: '/repo/a', activeRepo: '/repo/a', busy: false, hasText: true, onScreen: true, draftReady: true };

	t.test('全部满足时上屏', () => {
		assert.equal(canLandGeneration(ok), true);
	});

	t.test('结果属于别的仓库时不上屏', () => {
		assert.equal(canLandGeneration({ ...ok, generationRepo: '/repo/a', activeRepo: '/repo/a/sub' }), false);
	});

	t.test('仍在生成时不上屏', () => {
		assert.equal(canLandGeneration({ ...ok, busy: true }), false);
	});

	t.test('没有文本时不上屏', () => {
		assert.equal(canLandGeneration({ ...ok, hasText: false }), false);
	});

	t.test('提交框不在屏幕上时不上屏（侧栏页关闭或会话被切走）', () => {
		assert.equal(canLandGeneration({ ...ok, onScreen: false }), false);
	});

	t.test('草稿未读回时不上屏，避免覆盖刚切换过来的草稿', () => {
		assert.equal(canLandGeneration({ ...ok, draftReady: false }), false);
	});

	t.test('未选中仓库时不上屏', () => {
		assert.equal(canLandGeneration({ ...ok, activeRepo: null }), false);
	});
});
