/**
 * 面板状态辅助：把错误文本写进面板状态。
 */
import type { Dispatch, SetStateAction } from 'react';
import type { PanelState } from '../types.ts';

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
