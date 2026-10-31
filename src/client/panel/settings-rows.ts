/**
 * 设置面板的行级通用组件：分区标题、开关行、整数行、下拉行。
 */
import React from 'react';
import { Checkbox, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives';
import { Dropdown } from '../ui/dropdown.ts';
import css from '../css/settings.module.css';
import { cx } from '../css/cx.ts';

/**
 * 一个分区标题。
 *
 * @param props.title - 标题。
 * @returns 分区元素。
 */
export function Section({ title, children }: { title: string; children?: React.ReactNode }): React.ReactElement {
	return React.createElement(
		'div',
		{ className: css.setSection },
		React.createElement('div', { className: css.setSectionTitle }, title),
		children,
	);
}

/**
 * 一个开关行。
 *
 * Checkbox 自身携带文案且根元素是 `<label>`，因此这里用 `div` 作行容器、不再另加文案节点：
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
	return React.createElement(
		'div',
		{ className: css.setRow },
		React.createElement('span', { className: css.setRowText }, label),
		React.createElement(Input, {
			value: draft, type: 'number', min, max,
			onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value); },
			onBlur: (event: React.FocusEvent<HTMLInputElement>) => { commit(event.target.value); },
		}),
	);
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
 * 一个下拉行。
 *
 * @param props.label - 文案。
 * @param props.options - 选项。
 * @param props.value - 当前值。
 * @param props.onChange - 变更回调。
 * @returns 行元素。
 */
export function SelectRow({ label, options, value, onChange }: {
	label: string;
	options: ReadonlyArray<{ value: string; label: string; title?: string }>;
	value: string;
	onChange: (next: string) => void;
}): React.ReactElement {
	return React.createElement(SettingRow, {
		label,
		labelClass: css.setRowText,
		control: React.createElement(SegmentedControl, { id: `ggg-set-${label}`, label, value, onChange, options }),
	});
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
export function DropdownRow({ label, options, value, onChange }: {
	label: string;
	options: ReadonlyArray<{ value: string; label: string }>;
	value: string;
	onChange: (next: string) => void;
}): React.ReactElement {
	return React.createElement(SettingRow, {
		label,
		labelClass: css.setLabel,
		control: React.createElement(Dropdown, { options, value, onChange }),
	});
}