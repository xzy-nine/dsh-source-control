/**
 * 右键菜单的屏幕边缘避让：把菜单放进视口内。
 *
 * 与 DOM 无关的纯计算，尺寸由调用方实测后传入（菜单高度取决于菜单项数量与换行，
 * 无法预先估算），因此可以单测。
 */

/** 菜单与视口边缘之间的最小间距。 */
export const MENU_MARGIN = 8;

/** 一级与二级菜单之间的间距。 */
export const SUBMENU_GAP = 4;

/** 菜单落点。 */
export interface MenuPlacement {
	/** 距视口左边的像素。 */
	readonly left: number;
	/** 距视口顶边的像素。 */
	readonly top: number;
}

/** 尺寸。 */
export interface Size {
	readonly width: number;
	readonly height: number;
}

/**
 * 把一级菜单放进视口。
 *
 * 优先落在指针右下方；右/下侧放不下时贴边，下方确实放不下而上方放得下时翻到指针上方。
 * 菜单比视口还大时贴左上角，超出部分由视口裁掉，而不是让菜单整体移出屏幕。
 *
 * @param anchor - 指针坐标。
 * @param size - 菜单实测尺寸。
 * @param viewport - 视口尺寸。
 * @param margin - 与视口边缘的最小间距。
 * @returns 菜单落点。
 */
export function placeMenu(
	anchor: { readonly x: number; readonly y: number },
	size: Size,
	viewport: Size,
	margin: number = MENU_MARGIN,
): MenuPlacement {
	const maxLeft = viewport.width - size.width - margin;
	const maxTop = viewport.height - size.height - margin;
	// 下方放不下、且上方放得下时翻到指针上方。
	const flipUp = anchor.y + size.height > viewport.height - margin && anchor.y - size.height >= margin;
	const top = flipUp ? anchor.y - size.height : anchor.y;
	return {
		left: Math.max(margin, Math.min(anchor.x, maxLeft)),
		top: Math.max(margin, Math.min(top, maxTop)),
	};
}

/**
 * 把二级菜单放进视口。
 *
 * 默认贴在父菜单右侧、与触发项顶端对齐；右侧放不下时翻到父菜单左侧。纵向同样贴边。
 *
 * @param parent - 父菜单落点与宽度。
 * @param itemTop - 触发项在父菜单内的纵向偏移。
 * @param size - 二级菜单实测尺寸。
 * @param viewport - 视口尺寸。
 * @param margin - 与视口边缘的最小间距。
 * @returns 二级菜单落点。
 */
export function placeSubmenu(
	parent: { readonly left: number; readonly top: number; readonly width: number },
	itemTop: number,
	size: Size,
	viewport: Size,
	margin: number = MENU_MARGIN,
): MenuPlacement {
	const fitsRight = parent.left + parent.width + SUBMENU_GAP + size.width <= viewport.width - margin;
	const preferredLeft = fitsRight
		? parent.left + parent.width + SUBMENU_GAP
		: parent.left - size.width - SUBMENU_GAP;
	const maxTop = viewport.height - size.height - margin;
	return {
		left: Math.max(margin, Math.min(preferredLeft, viewport.width - size.width - margin)),
		top: Math.max(margin, Math.min(parent.top + itemTop, maxTop)),
	};
}
