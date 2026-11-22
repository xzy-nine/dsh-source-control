/**
 * 提交与推送的钩子勾选：一处声明，菜单与远程同步两处依赖面都取它。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

/** 钩子勾选的三项。 */
export interface HookSelection {
	/** 推送钩子是否激活。 */
	readonly pushHookActive: boolean;
	/** 是否运行钩子。 */
	readonly runHooks: boolean;
	/** 操作结束复位钩子勾选。 */
	readonly setRunHooks: (next: boolean) => void;
}
