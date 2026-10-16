/**
 * 一批工作树与子模块补齐的执行与结局判定。
 *
 * 补齐请求有三种结局，各自的后续动作不同：
 * - 成功写入：占用转为已完成，不重试；
 * - 被取消：只释放占用，不重试（effect 会重跑，届时重新下发）；
 * - 空结果或失败：释放占用**并**驱动重试，否则该批路径此后不再下发，工作树与子模块永久不出现。
 *
 * 本模块不依赖 React，`use-repos.ts` 的补齐 effect 直接调用 {@link runEnrichBatch}，因此
 * 「结局 -> 动作」的判据可被单测直接覆盖。
 */
import type { RepoNode } from '../shared/types.ts';
import type { EnrichClaims } from './enrich-claims.ts';

/** 一批补齐的执行依赖。 */
export interface EnrichBatchDeps {
	/** 向宿主取这一批仓库的工作树与子模块。 */
	readonly fetchEnriched: (paths: readonly string[]) => Promise<readonly RepoNode[]>;
	/** 路径占用登记。 */
	readonly claims: EnrichClaims;
	/** 本轮是否已被取消。 */
	readonly isCancelled: () => boolean;
	/** 写入结果：入参为本批路径与宿主回投的节点。 */
	readonly write: (paths: readonly string[], enriched: readonly RepoNode[]) => void;
	/** 请求重试：递增重试序号以驱动下一轮空闲回调。 */
	readonly requestRetry: () => void;
}

/** 一批补齐的结局。 */
export type EnrichBatchOutcome = 'settled' | 'cancelled' | 'empty' | 'failed';

/**
 * 执行一批补齐并按其结局处理占用。
 *
 * @param paths - 本批仓库路径。
 * @param deps - 见 {@link EnrichBatchDeps}。
 * @returns 本批结局。
 */
export async function runEnrichBatch(paths: readonly string[], deps: EnrichBatchDeps): Promise<EnrichBatchOutcome> {
	deps.claims.begin(paths);
	let settled = false;
	try {
		const enriched = await deps.fetchEnriched(paths);
		if (deps.isCancelled()) return 'cancelled';
		if (enriched.length === 0) {
			/*
			 * 空结果同样要重试：宿主按「是否仍是仓库」过滤，整批失效时不重试就永久停摆。
			 * 但重试按路径计数，连续失败到上限后不再重试，避免宿主判据与发现层不一致时无休止请求。
			 */
			if (deps.claims.fail(paths)) deps.requestRetry();
			return 'empty';
		}
		deps.write(paths, enriched);
		deps.claims.settle(paths);
		settled = true;
		return 'settled';
	} catch {
		if (deps.claims.fail(paths)) deps.requestRetry();
		return 'failed';
	} finally {
		// 取消与未到上限的失败都要释放占用，使其可再次下发；到上限的路径已转入已完成。
		if (!settled) deps.claims.release(paths);
	}
}
