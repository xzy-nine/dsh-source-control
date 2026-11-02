/**
 * 面板各动作 hook 共用的依赖面。
 *
 * 面板把「执行并刷新」「带进度执行」「轻量提示」三件事以稳定引用注入各 hook，
 * 各 hook 只声明自己要用的部分，因此这里集中定义它们的形状。
 */
import type { BusyScope, PanelRun } from '../shared/types.ts';

/** 各动作 hook 共用的依赖面。 */
export interface PanelActionDeps {
	/** 面板的 `run`：执行一次操作并按影响面刷新。 */
	readonly run: PanelRun;
	/** 带进度条执行一次不刷新的调用；失败时返回 null。 */
	readonly withProgress: <T>(scope: BusyScope, operation: () => Promise<T>) => Promise<T | null>;
	/** 轻量提示。 */
	readonly notify: (message: string) => Promise<void>;
}
