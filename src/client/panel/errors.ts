/**
 * 面板状态辅助：把错误文本写进面板状态。
 */
import type { Dispatch, SetStateAction } from 'react';
import { errorText } from '../../shared/error-text.ts';
import type { PanelState } from '../shared/types.ts';

/**
 * 把错误文本显示在面板上。
 *
 * @param setState - 状态更新。
 * @param error - 错误文本；null 表示清除。
 * @returns 无。
 */
export function reportError(setState: Dispatch<SetStateAction<PanelState>>, error: string | null): void {
	setState((previous) => ({ ...previous, error }));
}

/**
 * 把捕获到的失败值写进面板。
 *
 * @param setState - 状态更新。
 * @param error - 捕获到的失败值。
 * @returns 无。
 */
export function reportCaught(setState: Dispatch<SetStateAction<PanelState>>, error: unknown): void {
	reportError(setState, errorText(error));
}

/** 一次刷新失败要收回哪些分区。 */
export interface RefreshFailureScope {
	/** 是否收图形区的提交图分区。 */
	readonly graph: boolean;
	/** 是否收更改区的条目分区。 */
	readonly entries: boolean;
}

/**
 * 把一次取数失败写进面板：只收回失败涉及的分区，错误照常上报。
 *
 * 取数失败后停在 loading 会让分区一直显示占位，而占位没有重试入口。收回范围必须与失败
 * 的那一路一致：只重取快照的那一路不动图形区，否则一次快照失败会把仍在运行的提交图
 * 标成已结束，用户看到空图且没有重试入口。
 *
 * @param setState - 状态更新。
 * @param settle - 清除后台刷新登记。
 * @param scope - 要收回的分区。
 * @param error - 抛出的值。
 * @returns 无。
 */
export function reportRefreshFailure(
	setState: Dispatch<SetStateAction<PanelState>>,
	settle: (previous: PanelState) => PanelState,
	scope: RefreshFailureScope,
	error: unknown,
): void {
	setState((previous) => ({
		...settle(previous),
		phase: scope.graph ? 'ready' : previous.phase,
		entriesPhase: scope.entries ? 'ready' : previous.entriesPhase,
	}));
	reportCaught(setState, error);
}
