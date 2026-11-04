/**
 * 差异页的视图选择：左右并排与自动换行。
 *
 * 选择是面板设置的一部分，与其它视图开关同源、随设置持久化到宿主，因此刷新与换浏览器都保留。
 * 本模块只做「设置 ↔ 视图选择」的纯映射，不持有状态。
 */
import type { Settings } from '../shared/types.ts';

/** 一个差异页的视图选择。 */
export interface DiffViewChoice {
	/** 左右并排；单侧改动时 FileDiff 仍会退回单列。 */
	readonly split: boolean;
	/** 自动换行。 */
	readonly wrap: boolean;
}

/** 默认选择：左右并排、自动换行。 */
export const DEFAULT_DIFF_VIEW: DiffViewChoice = { split: true, wrap: true };

/**
 * 从设置里取差异页的视图选择。
 *
 * @param settings - 面板设置；尚未预取时为 null。
 * @returns 视图选择；设置不可用时为默认选择。
 */
export function diffViewOf(settings: Settings | null): DiffViewChoice {
	if (settings === null) return DEFAULT_DIFF_VIEW;
	return {
		split: typeof settings.diffSplit === 'boolean' ? settings.diffSplit : DEFAULT_DIFF_VIEW.split,
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
		...(patch.split === undefined ? {} : { diffSplit: patch.split }),
		...(patch.wrap === undefined ? {} : { diffWrap: patch.wrap }),
	};
}
