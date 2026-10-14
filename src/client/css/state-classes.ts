/**
 * 由 JS 动态切换的全局状态类名。
 *
 * `menuTarget` 会加在变更行与提交行两种元素上，两者分属不同的 CSS 模块，
 * 因此该状态类不能随模块作用域化：样式里写作 `:global(...)`，此处给出同一份名字。
 */

/** 右键菜单打开时高亮目标行。 */
export const MENU_TARGET_CLASS = 'ggg-menu-target';
