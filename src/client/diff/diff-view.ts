/**
 * 差异页的视图选择：只保留自动换行。
 *
 * 左右并排是差异页唯一的布局：中间要站一列分段暂存按钮，单列布局没有这条接缝，
 * 因此不再提供切换。换行选择是面板设置的一部分，与其它视图开关同源、随设置持久化
 * 到宿主，因此刷新与换浏览器都保留。本模块只做「设置 ↔ 视图选择」的纯映射，不持有状态。
 */
import type { Settings } from '../shared/types.ts';

/** 一个差异页的视图选择。 */
export interface DiffViewChoice {
	/** 自动换行。 */
	readonly wrap: boolean;
}

/** 默认选择：自动换行。 */
export const DEFAULT_DIFF_VIEW: DiffViewChoice = { wrap: true };

/**
 * 从设置里取差异页的视图选择。
 *
 * @param settings - 面板设置；尚未预取时为 null。
 * @returns 视图选择；设置不可用时为默认选择。
 */
export function diffViewOf(settings: Settings | null): DiffViewChoice {
	if (settings === null) return DEFAULT_DIFF_VIEW;
	return {
		wrap: typeof settings.diffWrap === 'boolean' ? settings.diffWrap : DEFAULT_DIFF_VIEW.wrap,
	};
}

/**
 * 在设置里改一项视图选择。
 *
 * @param settings - 当前设置。
 * @param patch - 要改的项。
 * @returns 新的设置对象。
 */
export function withDiffView(settings: Settings, patch: Partial<DiffViewChoice>): Settings {
	return {
		...settings,
		...(patch.wrap === undefined ? {} : { diffWrap: patch.wrap }),
	};
}
