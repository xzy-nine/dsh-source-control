/**
 * 右键菜单的数据源层：读取 menu-actions.json，补上未给出的字段并给出类型。
 *
 * JSON 是元数据与菜单名称的唯一数据源；本层只做形状整理（缺省回退到 title）与类型声明，
 * 不含任何行为。处理函数在 commit-menu.ts 里按 id 绑定；新增一项操作 = JSON 加一条 +
 * 那里补一个同 id 的处理函数。
 */
import source from './menu-actions.json' with { type: 'json' };

/** 一项操作的元数据：JSON 条目补齐缺省后的形状。 */
export interface MenuActionMeta {
	/** 稳定标识，既是处理函数的键，也供提交菜单按序引用。 */
	readonly id: string;
	/** 适用的引用类型；引用菜单据此过滤。 */
	readonly refTypes: readonly string[];
	/**
	 * 在提交行菜单中的呈现方式。
	 *
	 * `tag` 表示该操作作用于提交上的标签；省略表示不在提交行菜单中出现（贮藏等只在
	 * 对应引用上才有目标，储藏行右键会被识别为它的贮藏引用，同样走引用菜单）。
	 */
	readonly commitTarget?: 'tag';
	/** 菜单项名称；含占位符时由调用方代入。 */
	readonly title: string;
	/** 提交行菜单里的名称；JSON 未给出时与 title 相同。 */
	readonly commitTitle: string;
	/** 提交行菜单里二级子项的名称模板；JSON 未给出时与 title 相同。 */
	readonly commitItemTitle: string;
	/** 尖端为当前分支时的名称模板；JSON 未给出时与 title 相同。 */
	readonly commitCurrentTitle: string;
	/** 尖端为远程分支时的名称模板；JSON 未给出时与 title 相同。 */
	readonly commitRemoteTitle: string;
	/** 是否是危险操作。 */
	readonly danger: boolean;
}

/**
 * 提交行菜单里与注册表无关的固定文案。
 *
 * 键与 JSON 的 commitMenuTexts 一致；少一个键会在编译期报错。
 */
export interface CommitMenuTexts {
	readonly openOnGitHub: string;
	readonly checkoutDetached: string;
	readonly createBranch: string;
	readonly createTag: string;
	readonly cherrypick: string;
	readonly cherrypickHint: string;
	readonly revert: string;
	readonly revertHint: string;
	readonly resetHere: string;
	readonly resetSoft: string;
	readonly resetSoftHint: string;
	readonly resetMixed: string;
	readonly resetMixedHint: string;
	readonly resetHard: string;
	readonly resetHardHint: string;
	readonly copyHash: string;
	readonly copyMessage: string;
}

/** 注册表元数据；数组顺序即提交菜单与引用菜单中的呈现顺序。 */
export const MENU_ACTIONS: readonly MenuActionMeta[] = source.actions.map((action) => ({
	id: action.id,
	refTypes: action.refTypes,
	commitTarget: action.commitTarget === 'tag' ? 'tag' : undefined,
	title: action.title,
	commitTitle: action.commitTitle ?? action.title,
	commitItemTitle: action.commitItemTitle ?? action.title,
	commitCurrentTitle: action.commitCurrentTitle ?? action.title,
	commitRemoteTitle: action.commitRemoteTitle ?? action.title,
	danger: action.danger === true,
}));

/** 提交行菜单里与注册表无关的固定文案。 */
export const COMMIT_MENU: CommitMenuTexts = source.commitMenuTexts;

/**
 * 代入菜单名称模板里的占位符。
 *
 * @param template - 含 `{name}` 占位符的名称模板。
 * @param values - 占位符取值。
 * @returns 代入后的文本。
 */
export function fillText(template: string, values: Record<string, string>): string {
	let text = template;
	for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(value);
	return text;
}
