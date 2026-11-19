/**
 * 差异页「当前实际显示哪一侧」的共享快照。
 *
 * 页签标题由注册处按地址算（`title(address)`），它只拿得到地址、读不到页内状态；而一侧
 * 被搬空后页面会就地切到对侧，地址仍是进入时的那一侧。为了让标题跟着显示侧走，页内把
 * 实际显示侧写进这份快照，标题从这里读，读不到再退回地址。
 *
 * 键是差异页地址：同一地址只对应一个页，不同页互不影响。值是 `true` 表示当前显示暂存区
 * 的内容、`false` 表示显示工作区的内容、缺省表示与地址一致。
 */

import type { GitDiffScope } from './resource-path.ts';

const shownSides = new Map<string, boolean>();

/** 订阅者集合：快照变化时通知标题重渲染。 */
const listeners = new Set<() => void>();

/**
 * 记下某个差异页地址当前显示的是哪一侧。
 *
 * @param address - 差异页地址。
 * @param side - 是否显示暂存区的内容；null 表示与地址一致。
 * @returns 无。
 */
export function setShownSide(address: string, side: boolean | null): void {
	if (side === null) shownSides.delete(address);
	else shownSides.set(address, side);
	for (const listener of listeners) listener();
}

/**
 * 读出某个差异页地址当前显示的是哪一侧。
 *
 * @param address - 差异页地址。
 * @returns 暂存区为 true、工作区为 false、与地址一致或未知时为 null。
 */
export function shownSideOf(address: string): boolean | null {
	const side = shownSides.get(address);
	return side === undefined ? null : side;
}

/**
 * 订阅显示侧变化；标题据此重渲染。
 *
 * @param listener - 变化时调用。
 * @returns 取消订阅的函数。
 */
export function subscribeShownSide(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/**
 * 页签标题用的作用域：显示侧覆盖地址里的那一侧。
 *
 * @param address - 差异页地址。
 * @param scope - 地址里的作用域。
 * @returns 标题该写的作用域。
 */
export function titleScopeOf(address: string, scope: GitDiffScope): GitDiffScope {
	if (scope.kind !== 'worktree') return scope;
	const side = shownSideOf(address);
	return side === null ? scope : { kind: 'worktree', staged: side };
}
