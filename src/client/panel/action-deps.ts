/**
 * 面板各动作 hook 共用的依赖面。
 *
 * 面板把「执行并刷新」「带进度执行」「失败原因」「结果告知」以稳定引用注入各 hook，
 * 各 hook 只声明自己要用的部分，因此这里集中定义它们的形状。
 */
import type { ToastTone } from './toast.ts';
import type { BusyScope, PanelRun } from '../shared/types.ts';

/** 各动作 hook 共用的依赖面。 */
export interface PanelActionDeps {
	/** 面板的 `run`：执行一次操作并按影响面刷新。 */
	readonly run: PanelRun;
	/** 带进度条执行一次不刷新的调用；失败时返回 null。 */
	readonly withProgress: <T>(scope: BusyScope, operation: () => Promise<T>) => Promise<T | null>;
	/**
	 * 失败或操作无法进行的原因，弹窗呈现且正文可复制。
	 *
	 * 动作未被尝试（缺少依赖、未登录、当前分支不可删）同样属于此面：用户要看到的是原因与下一步。
	 */
	readonly notify: (message: string) => Promise<void>;
	/**
	 * 动作结果或状态告知，顶部轻量提示，不打断操作。
	 *
	 * @param message - 提示文本。
	 * @param tone - `success` 用于已完成的结果，`info` 用于需要用户继续处理的状态。
	 */
	readonly announce: (message: string, tone?: ToastTone) => Promise<void>;
}
