/**
 * 差异页的视图选择：左右并排与自动换行。
 *
 * 选择按页地址记在模块作用域，因此切到别的侧栏页再切回同一文件时仍是上次的选择；
 * 不随组件卸载丢失，也不依赖页签保留挂载。
 */

/** 一个差异页的视图选择。 */
export interface DiffViewChoice {
	/** 左右并排；单侧改动时 FileDiff 仍会退回单列。 */
	readonly split: boolean;
	/** 自动换行。 */
	readonly wrap: boolean;
}

/** 默认选择：左右并排、自动换行。 */
const DEFAULT_CHOICE: DiffViewChoice = { split: true, wrap: true };

/** 按页地址记录的选择；地址相同即同一文件的同一次比较。 */
const choices = new Map<string, DiffViewChoice>();

/**
 * 读取一个差异页的视图选择。
 *
 * @param address - 差异页的资源地址。
 * @returns 记录的选择；没有记录时返回默认选择。
 */
export function readDiffView(address: string): DiffViewChoice {
	return choices.get(address) ?? DEFAULT_CHOICE;
}

/**
 * 记录一个差异页的视图选择。
 *
 * @param address - 差异页的资源地址。
 * @param choice - 新的选择。
 * @returns 无。
 */
export function writeDiffView(address: string, choice: DiffViewChoice): void {
	choices.set(address, choice);
}
