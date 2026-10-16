/**
 * 补齐占用的路径登记与一批补齐的结局处理：失败与取消都必须释放，空结果还必须驱动重试。
 *
 * 面板按仓库路径去重下发补齐请求：已登记的路径不再下发。登记分在途与已完成两种状态，
 * 若在途路径在请求被取消时不释放，该路径此后既不下发、也不在已完成集合里，补齐永久停摆。
 *
 * 结局判定由生产函数 `runEnrichBatch` 承担，本测试直接调用它——`use-repos.ts` 的补齐 effect
 * 走的是同一个函数，因此这里的断言覆盖真实路径，而不是复刻一份等价逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnrichClaims, ENRICH_FAILURE_LIMIT } from '../src/client/panel/enrich-claims.ts';
import { runEnrichBatch } from '../src/client/panel/enrich-run.ts';

test('未登记的路径可下发', () => {
	const claims = createEnrichClaims();
	assert.equal(claims.has('/a'), false);
});

test('在途路径不再重复下发', () => {
	const claims = createEnrichClaims();
	claims.begin(['/a']);
	assert.equal(claims.has('/a'), true);
	assert.equal(claims.inFlightSize, 1);
});

test('成功后转入已完成，仍不重复下发', () => {
	const claims = createEnrichClaims();
	claims.begin(['/a']);
	claims.settle(['/a']);
	assert.equal(claims.has('/a'), true);
	assert.equal(claims.inFlightSize, 0);
	assert.equal(claims.settledSize, 1);
});

test('取消释放后路径可再次下发', () => {
	const claims = createEnrichClaims();
	claims.begin(['/a', '/b']);
	claims.release(['/a', '/b']);
	assert.equal(claims.has('/a'), false);
	assert.equal(claims.has('/b'), false);
	assert.equal(claims.inFlightSize, 0);
});

test('释放不影响已完成记录', () => {
	const claims = createEnrichClaims();
	claims.begin(['/a']);
	claims.settle(['/a']);
	claims.begin(['/b']);
	claims.release(['/a', '/b']);
	assert.equal(claims.has('/a'), true);
	assert.equal(claims.has('/b'), false);
});

test('重新扫描清空全部登记', () => {
	const claims = createEnrichClaims();
	claims.begin(['/a']);
	claims.settle(['/a']);
	claims.begin(['/b']);
	claims.clear();
	assert.equal(claims.has('/a'), false);
	assert.equal(claims.has('/b'), false);
	assert.equal(claims.inFlightSize, 0);
	assert.equal(claims.settledSize, 0);
});

test('已不在树上的路径被遗忘后可重新补齐', () => {
	const claims = createEnrichClaims();
	claims.begin(['/a']);
	claims.settle(['/a']);
	claims.forget(['/a']);
	assert.equal(claims.has('/a'), false);
});

test('keys 给出在途与已完成的全部路径且不重复', () => {
	const claims = createEnrichClaims();
	claims.begin(['/a', '/b']);
	claims.settle(['/a']);
	assert.deepEqual(claims.keys().sort(), ['/a', '/b']);
});

test('失败释放后重试一次即收敛（不残留占用）', () => {
	const claims = createEnrichClaims();
	const paths = ['/a', '/b', '/c'];
	claims.begin(paths);
	// 第一批失败。
	claims.release(paths);
	assert.deepEqual(paths.filter((path) => !claims.has(path)), paths);
	// 第二批成功。
	claims.begin(paths);
	claims.settle(paths);
	assert.deepEqual(paths.filter((path) => !claims.has(path)), []);
	assert.equal(claims.inFlightSize, 0);
});

test('四种结局里只有成功保留占用，取消/空结果/异常都必须释放', async () => {
	/**
	 * 用生产函数 `runEnrichBatch` 跑一遍「下发 → 结局」，返回占用状态与重试次数。
	 *
	 * @param kind - 结局类型。
	 * @returns 占用状态与是否请求了重试。
	 */
	const outcome = async (kind) => {
		const claims = createEnrichClaims();
		let retried = 0;
		let written = 0;
		const result = await runEnrichBatch(['/a'], {
			claims,
			isCancelled: () => kind === 'cancel',
			fetchEnriched: async () => {
				if (kind === 'throw') throw new Error('宿主失败');
				if (kind === 'empty') return [];
				return [{ path: '/a', children: [{}] }];
			},
			requestRetry: () => { retried += 1; },
			write: () => { written += 1; },
		});
		return {
			result, has: claims.has('/a'), inFlight: claims.inFlightSize, settled: claims.settledSize, retried, written,
		};
	};

	// 成功：保留占用、写入结果、不重试。
	assert.deepEqual(await outcome('settle'), {
		result: 'settled', has: true, inFlight: 0, settled: 1, retried: 0, written: 1,
	});
	// 取消：释放占用、不重试（effect 重跑时会重新下发）。
	assert.deepEqual(await outcome('cancel'), {
		result: 'cancelled', has: false, inFlight: 0, settled: 0, retried: 0, written: 0,
	});
	// 空结果：释放占用**并**重试，否则该批路径此后不再下发。
	assert.deepEqual(await outcome('empty'), {
		result: 'empty', has: false, inFlight: 0, settled: 0, retried: 1, written: 0,
	});
	// 失败：释放占用并重试。
	assert.deepEqual(await outcome('throw'), {
		result: 'failed', has: false, inFlight: 0, settled: 0, retried: 1, written: 0,
	});
});

test('空结果释放后同一路径可再次下发并补齐（不永久停摆）', async () => {
	const claims = createEnrichClaims();
	let calls = 0;
	const deps = {
		claims,
		isCancelled: () => false,
		requestRetry: () => {},
		write: () => {},
		fetchEnriched: async () => {
			calls += 1;
			return calls === 1 ? [] : [{ path: '/a', children: [{}] }];
		},
	};
	assert.equal(await runEnrichBatch(['/a'], deps), 'empty');
	assert.equal(claims.has('/a'), false, '空结果必须释放占用');
	assert.equal(await runEnrichBatch(['/a'], deps), 'settled');
	assert.equal(claims.has('/a'), true);
	assert.equal(claims.settledSize, 1);
});

test('取消时写入不会被调用', async () => {
	const claims = createEnrichClaims();
	let written = 0;
	const result = await runEnrichBatch(['/a'], {
		claims,
		isCancelled: () => true,
		requestRetry: () => { throw new Error('取消不应请求重试'); },
		write: () => { written += 1; },
		fetchEnriched: async () => [{ path: '/a', children: [{}] }],
	});
	assert.equal(result, 'cancelled');
	assert.equal(written, 0);
	assert.equal(claims.has('/a'), false);
});

test('取消时抛错不累计失败次数、不驱动重试，且释放占用', async () => {
	const claims = createEnrichClaims();
	let retried = 0;
	const result = await runEnrichBatch(['/a'], {
		claims,
		isCancelled: () => true,
		requestRetry: () => { retried += 1; },
		write: () => { throw new Error('取消不应写入'); },
		fetchEnriched: async () => { throw new Error('请求被取消'); },
	});
	assert.equal(result, 'cancelled');
	assert.equal(retried, 0, '取消不应请求重试');
	assert.equal(claims.inFlightSize, 0, '取消必须释放占用');
	assert.equal(claims.settledSize, 0, '取消不应记入已完成');
	assert.equal(claims.has('/a'), false, '释放后该路径可再次下发');
	// 取消未累计失败次数：下一次正常请求一次即补齐。
	const settled = await runEnrichBatch(['/a'], {
		claims,
		isCancelled: () => false,
		requestRetry: () => {},
		write: () => {},
		fetchEnriched: async () => [{ path: '/a', children: [{}] }],
	});
	assert.equal(settled, 'settled');
});

test('失败上限是一个小的正整数（兜底必须能在有限轮内生效）', () => {
	assert.ok(Number.isInteger(ENRICH_FAILURE_LIMIT), '上限必须是整数');
	// 1 与 2 语义合法但产品上不可取：宿主一次瞬时失败就会让工作树消失，因此下限取 3。
	assert.ok(ENRICH_FAILURE_LIMIT >= 3, '上限至少为 3，否则瞬时失败即丢工作树');
	assert.ok(ENRICH_FAILURE_LIMIT <= 10, '上限必须足够小，否则兜底形同虚设');
});

test('瞬时失败在容忍次数内仍会补齐，超过则停止重试', async () => {
	/** 前 failRounds 轮返回空，之后返回成功；返回请求次数与最终是否补齐。 */
	const run = async (failRounds) => {
		const claims = createEnrichClaims();
		let requests = 0;
		const deps = {
			claims,
			isCancelled: () => false,
			requestRetry: () => {},
			write: () => {},
			fetchEnriched: async () => {
				requests += 1;
				return requests <= failRounds ? [] : [{ path: '/a', children: [{}] }];
			},
		};
		for (let round = 0; round < 20; round += 1) {
			const pending = ['/a'].filter((path) => !claims.has(path));
			if (pending.length === 0) break;
			await runEnrichBatch(pending, deps);
		}
		return { requests, children: claims.settledSize };
	};
	// 容忍次数以内：宿主恢复后能补齐。
	assert.deepEqual(await run(ENRICH_FAILURE_LIMIT - 1), { requests: ENRICH_FAILURE_LIMIT, children: 1 });
	// 到上限：停止重试，该路径按无来源处理。
	assert.deepEqual(await run(ENRICH_FAILURE_LIMIT), { requests: ENRICH_FAILURE_LIMIT, children: 1 });
});

test('持续空结果只在失败上限内重试，之后停止下发', async () => {
	const claims = createEnrichClaims();
	let requests = 0;
	let retries = 0;
	const deps = {
		claims,
		isCancelled: () => false,
		requestRetry: () => { retries += 1; },
		write: () => {},
		fetchEnriched: async () => { requests += 1; return []; },
	};
	// 硬边界：不引用上限常量做循环上界，否则把上限调大也测不出来。
	const HARD_LIMIT = 20;
	let rounds = 0;
	while (rounds < HARD_LIMIT) {
		const pending = ['/a'].filter((path) => !claims.has(path));
		if (pending.length === 0) break;
		await runEnrichBatch(pending, deps);
		rounds += 1;
	}
	assert.ok(rounds < HARD_LIMIT, '持续空结果必须在有限轮内停止下发，实际轮数 ' + rounds);
	assert.equal(requests, rounds, '每轮一次请求');
	assert.equal(retries, rounds - 1, '最后一次不再请求重试');
	assert.equal(claims.has('/a'), true, '停止后不再下发');
	assert.equal(claims.settledSize, 1);
	assert.equal(claims.inFlightSize, 0);
});

test('成功一次即清零失败计数', async () => {
	const claims = createEnrichClaims();
	let retries = 0;
	let mode = 'empty';
	const deps = {
		claims,
		isCancelled: () => false,
		requestRetry: () => { retries += 1; },
		write: () => {},
		fetchEnriched: async () => (mode === 'empty' ? [] : [{ path: '/a', children: [{}] }]),
	};
	await runEnrichBatch(['/a'], deps);
	await runEnrichBatch(['/a'], deps);
	mode = 'ok';
	assert.equal(await runEnrichBatch(['/a'], deps), 'settled');
	assert.equal(claims.settledSize, 1);
	// 成功后再失败，计数从头开始：应重新允许重试。
	mode = 'empty';
	claims.release(['/a']);
	assert.equal(await runEnrichBatch(['/a'], deps), 'empty');
	assert.equal(retries, 3, '两次空 + 成功后再空一次 = 3 次重试');
});

test('重新扫描清空失败计数', async () => {
	const claims = createEnrichClaims();
	const deps = { claims, isCancelled: () => false, requestRetry: () => {}, write: () => {}, fetchEnriched: async () => [] };
	await runEnrichBatch(['/a'], deps);
	await runEnrichBatch(['/a'], deps);
	assert.equal(claims.has('/a'), false);
	claims.clear();
	assert.equal(claims.has('/a'), false);
	assert.equal(claims.settledSize, 0);
	// 清空后仍可重试到上限。
	await runEnrichBatch(['/a'], deps);
	assert.equal(claims.has('/a'), false, '清空后计数从零开始');
});
