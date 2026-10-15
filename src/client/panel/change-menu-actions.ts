/**
 * 变更区右键菜单的数据源层：读取 change-menu-actions.json，补上未给出的字段并给出类型。
 *
 * JSON 是操作元数据与菜单名称的唯一数据源；本层只做形状整理（通用标题、按目标的标题覆盖）
 * 与类型声明，不含任何行为。菜单项由 change-menu.ts 按 id 绑定处理函数后构建。
 */
import source from './change-menu-actions.json' with { type: 'json' };

/** 菜单目标：文件夹行、文件行、分组标题行。 */
export type ChangeMenuTarget = 'folder' | 'file' | 'group';

/** 一项操作的元数据：JSON 条目补齐缺省后的形状。 */
export interface ChangeMenuActionMeta {
	/** 稳定标识，既是处理函数的键，也供测试断言各目标的操作集合。 */
	readonly id: string;
	/** 适用的菜单目标；菜单按目标过滤。 */
	readonly targets: readonly ChangeMenuTarget[];
	/**
	 * 所在分组：相邻两项分组不同时插一条分隔线。
	 *
	 * 取值为语义名（如 `edit`、`ignore`），只用于比较是否相同。
	 */
	readonly groupFor: Partial<Record<ChangeMenuTarget, string>>;
	/** 通用菜单名称。 */
	readonly title: string;
	/** 新增文件时的名称；JSON 未给出时用 title。 */
	readonly newTitle: string;
	/** 按目标覆盖的名称；未给出的目标用 title。 */
	readonly titles: Partial<Record<ChangeMenuTarget, string>>;
	/** 是否是危险操作。 */
	readonly danger: boolean;
}

/**
 * 取一项操作在某个目标下的分组名。
 *
 * @param meta - 操作元数据。
 * @param target - 菜单目标。
 * @returns 分组名。
 */
export function groupOf(meta: ChangeMenuActionMeta, target: ChangeMenuTarget): string {
	return meta.groupFor[target] ?? '';
}

/**
 * 取一项操作在某个目标下的菜单名称。
 *
 * @param meta - 操作元数据。
 * @param target - 菜单目标。
 * @returns 名称模板；含 `{count}` 占位符时由调用方代入。
 */
export function titleOf(meta: ChangeMenuActionMeta, target: ChangeMenuTarget): string {
	return meta.titles[target] ?? meta.title;
}

/** 注册表元数据；数组顺序即三个目标菜单里的呈现顺序。 */
export const CHANGE_MENU_ACTIONS: readonly ChangeMenuActionMeta[] = source.actions.map((action) => {
	// JSON 里的目标是普通字符串，这里收窄成目标联合类型。
	const targets = action.targets.filter((target): target is ChangeMenuTarget => target === 'folder' || target === 'file' || target === 'group');
	const groupFor: Partial<Record<ChangeMenuTarget, string>> = {};
	for (const target of targets) groupFor[target] = (action.groupByTarget ?? {})[target] ?? action.group;
	return {
		id: action.id,
		targets,
		groupFor,
		title: action.title,
		newTitle: action.newTitle ?? action.title,
		titles: action.titles ?? {},
		danger: action.danger === true,
	};
});
