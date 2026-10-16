/**
 * 工作树与子模块补齐的路径占用登记。
 *
 * 补齐按仓库路径去重：同一路径不重复下发。占用分两种状态——在途与已完成。失败或**取消**时必须
 * 释放在途占用，否则该路径此后既不会被下发、也不在已完成集合里，工作树与子模块永久不出现。
 *
 * 空结果与失败会触发重试；重试按路径计数，连续失败达到上限后把该路径当作「没有工作树与子模块」
 * 记入已完成，不再重试。上限是兜底：宿主判据与发现层不一致（例如链接工作树的 `.git` 是文件）
 * 时，路径会一直留在树上而宿主一直返回空，没有上限即形成无休止的请求。
 *
 * 纯数据结构，无 React 依赖，可直接单测。
 */

/**
 * 同一路径连续失败的次数上限。
 *
 * 取值在「容忍瞬时失败」与「不一致时尽快收敛」之间折中：宿主短暂不可用（连续几次请求失败）不应
 * 让工作树永久消失，而宿主判据与发现层不一致时又不能无休止重试。
 */
export const ENRICH_FAILURE_LIMIT = 5;

/** 路径占用登记。 */
export interface EnrichClaims {
	/** 该路径是否已下发（在途或已完成）。 */
	has(path: string): boolean;
	/** 标记一批路径进入在途。 */
	begin(paths: readonly string[]): void;
	/** 一批路径补齐成功：移出在途、记入已完成，并清零失败计数。 */
	settle(paths: readonly string[]): void;
	/** 一批路径失败或被取消：移出在途，使其可再次下发。 */
	release(paths: readonly string[]): void;
	/**
	 * 一批路径得到空结果或失败：累计连续失败次数。
	 *
	 * 达到 {@link ENRICH_FAILURE_LIMIT} 的路径转入已完成（不再下发、不再重试）。
	 *
	 * @param paths - 本批路径。
	 * @returns 是否还有路径需要重试。
	 */
	fail(paths: readonly string[]): boolean;
	/** 一批路径已不在树上：连同已完成记录一并删除，位置再次出现时重新补齐。 */
	forget(paths: readonly string[]): void;
	/** 清空全部登记；重新扫描时调用。 */
	clear(): void;
	/** 已登记的全部路径（在途与已完成）。 */
	keys(): string[];
	/** 在途路径数。 */
	readonly inFlightSize: number;
	/** 已完成路径数。 */
	readonly settledSize: number;
}

/**
 * 建立一份路径占用登记。
 *
 * @returns 登记实例。
 */
export function createEnrichClaims(): EnrichClaims {
	const settled = new Set<string>();
	const inFlight = new Set<string>();
	const failures = new Map<string, number>();
	return {
		has(path) {
			return settled.has(path) || inFlight.has(path);
		},
		begin(paths) {
			for (const path of paths) inFlight.add(path);
		},
		settle(paths) {
			for (const path of paths) {
				inFlight.delete(path);
				settled.add(path);
				failures.delete(path);
			}
		},
		release(paths) {
			for (const path of paths) inFlight.delete(path);
		},
		fail(paths) {
			let retryable = false;
			for (const path of paths) {
				inFlight.delete(path);
				const count = (failures.get(path) ?? 0) + 1;
				if (count >= ENRICH_FAILURE_LIMIT) {
					// 到上限：按「没有工作树与子模块」处理，此后不再下发。
					failures.delete(path);
					settled.add(path);
					continue;
				}
				failures.set(path, count);
				retryable = true;
			}
			return retryable;
		},
		forget(paths) {
			for (const path of paths) {
				inFlight.delete(path);
				settled.delete(path);
				failures.delete(path);
			}
		},
		clear() {
			settled.clear();
			inFlight.clear();
			failures.clear();
		},
		keys() {
			return [...new Set([...settled, ...inFlight])];
		},
		get inFlightSize() {
			return inFlight.size;
		},
		get settledSize() {
			return settled.size;
		},
	};
}
