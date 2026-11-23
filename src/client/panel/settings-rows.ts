/**
 * 设置面板的行级通用组件：分区标题、开关行、整数行、下拉行。
 */
import React from 'react';
import { Checkbox, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives';
import { Dropdown, type DropdownValueProps } from '../ui/dropdown.ts';
import css from '../css/settings.module.css';
import { cx } from '../css/cx.ts';

/**
 * 一个分区标题。
 *
 * @param props.title - 标题。
 * @param props.anchor - 分区锚点 id；给出后设置面板可滚动定位到此分区。
 * @returns 分区元素。
 */
export function Section({ title, anchor, children }: {
	title: string;
	anchor?: string;
	children?: React.ReactNode;
}): React.ReactElement {
	return React.createElement(
		'div',
		{ className: css.setSection, id: anchor, 'data-set-anchor': anchor },
		React.createElement('div', { className: css.setSectionTitle }, title),
		children,
	);
}

/**
 * 一个开关行。
 *
 * Checkbox 自身携带文案且根元素是 `<label>`，因此这里用 `div` 作行容器、不另加文案节点：
 * 再套一层 `<label>` 会形成嵌套，重复显示文案并让点击行为异常。
 *
 * @param props.label - 文案。
 * @param props.checked - 状态。
 * @param props.onChange - 变更回调。
 * @returns 行元素。
 */
export function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }): React.ReactElement {
	return React.createElement(
		'div',
		{ className: cx(css.setRow, css.setRowInline) },
		React.createElement(Checkbox, { checked, onChange, label }),
	);
}

/**
 * 一个整数输入行。
 *
 * 输入期间保留草稿文本，失焦时收拢到区间并写回；非法输入回退到当前值。
 *
 * @param props.label - 文案。
 * @param props.value - 当前值。
 * @param props.min - 允许的最小值。
 * @param props.max - 允许的最大值。
 * @param props.onChange - 写回回调。
 * @returns 行元素。
 */
export function NumberRow({ label, value, min, max, onChange }: {
	label: string;
	value: number;
	min: number;
	max: number;
	onChange: (next: number) => void;
}): React.ReactElement {
	const [draft, setDraft] = React.useState(String(value));
	React.useEffect(() => { setDraft(String(value)); }, [value]);
	const commit = (text: string): void => {
		const parsed = Number.parseInt(text, 10);
		if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
		onChange(Math.min(max, Math.max(min, parsed)));
	};
	return textRow(label, React.createElement(Input, {
		value: draft, type: 'number', min, max,
		onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value); },
		onBlur: (event: React.FocusEvent<HTMLInputElement>) => { commit(event.target.value); },
	}));
}

/**
 * 行内文字标签加控件的设置行。
 *
 * @param label - 行标签。
 * @param control - 控件元素。
 * @returns 行元素。
 */
function textRow(label: string, control: React.ReactElement): React.ReactElement {
	return React.createElement(SettingRow, { label, labelClass: css.setRowText, control });
}
/**
 * 表单外壳：按字段顺序竖排。
 *
 * @param children - 表单内容。
 * @returns 表单元素。
 */
export function formShell(...children: React.ReactNode[]): React.ReactElement {
	return React.createElement('div', { className: css.setForm }, ...children);
}
/**
 * 表单底部的动作行。
 *
 * @param actions - 按钮元素，按给出顺序排列。
 * @returns 动作行元素。
 */
export function formActions(actions: readonly React.ReactElement[]): React.ReactElement {
	return React.createElement('div', { className: css.setFormActions }, ...actions);
}

/**
 * 设置行：行内标签 + 控件。
 *
 * @param label - 行标签。
 * @param labelClass - 标签的类名；下拉行与分段行各自的样式。
 * @param control - 控件元素。
 * @returns 行元素。
 */
export function SettingRow({ label, labelClass, control }: {
	label: string;
	labelClass: string;
	control: React.ReactElement;
}): React.ReactElement {
	return React.createElement(
		'div',
		{ className: css.setRow },
		React.createElement('span', { className: labelClass }, label),
		control,
	);
}

/**
 * 表单里的一行输入框：块状标签 + 输入控件。
 *
 * 标签在上，输入框占满一行。
 *
 * @param label - 行标签。
 * @param placeholder - 输入框占位提示。
 * @param value - 当前值。
 * @param onChange - 变更回调。
 * @returns 表单行元素。
 */
export function FieldBlock({ label, placeholder, value, onChange }: {
	label: string;
	placeholder: string;
	value: string;
	onChange: (next: string) => void;
}): React.ReactElement {
	return React.createElement('label', { className: css.setRowBlock },
		React.createElement('span', { className: css.setRowText }, label),
		React.createElement(Input, {
			value,
			placeholder,
			onChange: (event: React.ChangeEvent<HTMLInputElement>) => { onChange(event.target.value); },
		}),
	);
}

/**
 * 一个下拉行。
 *
 * @param props.label - 文案。
 * @param props.options - 选项。
 * @param props.value - 当前值。
 * @param props.onChange - 变更回调。
 * @returns 行元素。
 */
export function SelectRow({ label, ...choice }: { label: string } & DropdownValueProps): React.ReactElement {
	return textRow(label, React.createElement(SegmentedControl, { ...choice, id: `ggg-set-${label}`, label }));
}

/**
 * 下拉选择行：行内标签 + 共享下拉控件。
 *
 * @param props.label - 行标签。
 * @param props.options - 选项。
 * @param props.value - 当前值。
 * @param props.onChange - 变更回调。
 * @returns 行元素。
 */
export function DropdownRow({ label, ...choice }: { label: string } & DropdownValueProps): React.ReactElement {
	return React.createElement(SettingRow, { label, labelClass: css.setLabel, control: React.createElement(Dropdown, choice) });
}