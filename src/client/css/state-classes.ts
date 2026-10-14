/**
 * 由 JS 动态切换、并与样式共用的全局名字。
 *
 * 这些名字不能随 CSS 模块作用域化：`menuTarget` 要加在分属不同模块的元素上，
 * `submenuFlip` 是给宿主 Menu 原语渲染出来的 DOM 用的。样式侧写同一份字面量。
 */

/** 右键菜单打开时高亮目标行。 */
export const MENU_TARGET_CLASS = 'ggg-menu-target';

/** 二级菜单展开方向的令牌（`left` / `down`），存在期间才翻转宿主原语的方向。 */
export const SUBMENU_FLIP_ATTR = 'data-dsh-source-control-submenu';
