/**
 * 面板状态辅助：把错误文本写进面板状态。
 */
import type { Dispatch, SetStateAction } from 'react';
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
	reportError(setState, error instanceof Error ? error.message : String(error));
}

/**
 * 把一次取数失败写进面板：相位收回到已结束，错误照常上报。
 *
 * 取数失败后停在 loading 会让更改区与图形区一直显示占位，而占位没有重试入口；两路刷新
 * 因此共用这一条收尾。
 *
 * @param setState - 状态更新。
 * @param settle - 清除后台刷新登记。
 * @param error - 抛出的值。
 * @returns 无。
 */
export function reportRefreshFailure(
	setState: Dispatch<SetStateAction<PanelState>>,
	settle: (previous: PanelState) => PanelState,
	error: unknown,
): void {
	setState((previous) => ({ ...settle(previous), phase: 'ready', entriesPhase: 'ready' }));
	reportCaught(setState, error);
}
