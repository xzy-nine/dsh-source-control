/**
 * 自建弹窗基础设施：基于 DSH 的 Modal 封装确认框、输入框、表单与单选。
 *
 * 不使用浏览器原生 confirm / prompt，统一走 DSH 的 dialog 外观。
 * 这些封装以 Promise 返回用户操作结果，调用方用 await 串接即可。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
	Button, Checkbox, Input, Modal, RiskConfirmation, SegmentedControl, SegmentedTabs, type SegmentedTab,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { Dropdown, type DropdownOption } from './ui/dropdown.ts';
import css from './css/dialog.module.css';
import { cx } from './css/cx.ts';

export type { DropdownOption };

/**
 * 在独立 React 根上挂载一个弹窗组件，并在结束时卸载。
 *
 * @param build - 接收 finish(result) 回调，返回要渲染的 React 元素。
 * @returns 用户操作结果。
 */
function runDialog<T>(build: (finish: (result: T) => void) => React.ReactElement): Promise<T> {
	return new Promise((resolve) => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		const finish = (result: T): void => {
			resolve(result);
			requestAnimationFrame(() => {
				root.unmount();
				container.remove();
			});
		};
		root.render(build(finish));
	});
}

/** 确认框选项。 */
export interface ConfirmationOptions {
	readonly title: string;
	readonly message: string;
	readonly confirmLabel?: string;
	readonly cancelLabel?: string;
	readonly danger?: boolean;
}

/**
 * 简单确认框。
 *
 * @param options - 见 {@link ConfirmationOptions}。
 * @returns 用户点确认返回 true，否则 false。
 */
export function showConfirmation({ title, message, confirmLabel = '确认', cancelLabel = '取消', danger = false }: ConfirmationOptions): Promise<boolean> {
	return runDialog<boolean>((finish) => {
		function Content(): React.ReactElement {
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(false),
				title,
				closeLabel: '关闭',
				children: React.createElement('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, message),
				footer: React.createElement(
					React.Fragment,
					null,
					React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => finish(false) }, cancelLabel),
					React.createElement(Button, {
						variant: 'primary', size: 'sm', className: danger ? css.btnDanger : undefined,
						onClick: () => finish(true),
					}, confirmLabel),
				),
			});
		}
		return React.createElement(Content);
	});
}

/** 提示框选项。 */
export interface MessageOptions {
	readonly title: string;
	readonly message: string;
	/** 关闭按钮文案。 */
	readonly closeLabel?: string;
}

/**
 * 仅告知的提示框：只有一个关闭按钮，不做确认。
 *
 * 用于解释某个动作为何不可执行（如删除当前分支），不提供继续路径。
 *
 * @param options - 见 {@link MessageOptions}。
 * @returns 用户关闭后完成。
 */
export function showMessage({ title, message, closeLabel = '知道了' }: MessageOptions): Promise<void> {
	return runDialog<void>((finish) => {
		function Content(): React.ReactElement {
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(),
				title,
				closeLabel: '关闭',
				children: React.createElement('div', { className: css.dialogHint }, message),
				footer: React.createElement(Button, { variant: 'primary', size: 'sm', onClick: () => finish() }, closeLabel),
			});
		}
		return React.createElement(Content);
	});
}

/** 含勾选的确认框选项。 */
export interface CheckboxOptions {
	readonly title: string;
	readonly message: string;
	readonly checkboxLabel: string;
	readonly confirmLabel?: string;
	readonly cancelLabel?: string;
	readonly danger?: boolean;
}

/**
 * 含勾选的确认框：复选框未勾选时确认按钮禁用。
 *
 * @param options - 见 {@link CheckboxOptions}。
 * @returns 用户勾选并确认返回 true，否则 false。
 */
export function showCheckbox({ title, message, checkboxLabel, confirmLabel = '确认', cancelLabel = '取消' }: CheckboxOptions): Promise<boolean> {
	return runDialog<boolean>((finish) => {
		function Content(): React.ReactElement {
			const [acknowledged, setAcknowledged] = React.useState(false);
			return React.createElement(RiskConfirmation, {
				open: true,
				title,
				description: message,
				closeLabel: '关闭',
				cancelLabel,
				confirmLabel,
				acknowledged,
				acknowledgeLabel: checkboxLabel,
				onAcknowledgedChange: setAcknowledged,
				onCancel: () => finish(false),
				onConfirm: () => finish(true),
			});
		}
		return React.createElement(Content);
	});
}

/** 文本输入框选项。 */
export interface TextOptions {
	readonly title: string;
	readonly message?: string;
	readonly label?: string;
	readonly value?: string;
	readonly placeholder?: string;
	readonly confirmLabel?: string;
}

/**
 * 文本输入框。
 *
 * @param options - 见 {@link TextOptions}。
 * @returns 用户确认返回输入文本，取消返回 null。
 */
export function showText({ title, message = '', label = '', value = '', placeholder = '', confirmLabel = '确定' }: TextOptions): Promise<string | null> {
	return runDialog<string | null>((finish) => {
		function Content(): React.ReactElement {
			const [text, setText] = React.useState(value);
			const submit = (): void => { if (text.trim() !== '') finish(text.trim()); };
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(null),
				title,
				closeLabel: '关闭',
				children: React.createElement(
					React.Fragment,
					null,
					message !== '' && React.createElement('div', { className: css.dialogHint }, message),
					label !== '' && React.createElement('label', { className: css.fieldLabel, htmlFor: 'ggg-text-input' }, label),
					React.createElement(Input, {
						id: 'ggg-text-input',
						value: text,
						placeholder,
						onChange: (event: React.ChangeEvent<HTMLInputElement>) => setText(event.target.value),
						// 单行输入框里回车即确认：换行没有意义。
						onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
							if (event.key === 'Enter') { event.preventDefault(); submit(); }
						},
					}),
				),
				footer: React.createElement(
					React.Fragment,
					null,
					React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => finish(null) }, '取消'),
					React.createElement(Button, {
						variant: 'primary', size: 'sm', disabled: text.trim() === '', onClick: submit,
					}, confirmLabel),
				),
			});
		}
		return React.createElement(Content);
	});
}

/** 单选框选项。 */
export interface SelectOptions {
	readonly title: string;
	readonly message?: string;
	readonly options: ReadonlyArray<{ value: string; label: string; title?: string }>;
	readonly value?: string;
	readonly confirmLabel?: string;
}

/**
 * 单选框：在多个互斥选项中选一个。
 *
 * @param options - 见 {@link SelectOptions}。
 * @returns 用户确认返回所选值，取消返回 null。
 */
export function showSelect({ title, message = '', options, value, confirmLabel = '确定' }: SelectOptions): Promise<string | null> {
	return runDialog<string | null>((finish) => {
		function Content(): React.ReactElement {
			const [selected, setSelected] = React.useState(value ?? options[0]?.value ?? '');
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(null),
				title,
				closeLabel: '关闭',
				children: React.createElement(
					React.Fragment,
					null,
					message !== '' && React.createElement('div', { className: css.dialogHint }, message),
					React.createElement(SegmentedControl, {
						id: 'ggg-select',
						label: title,
						value: selected,
						onChange: setSelected,
						options: options.map((option) => ({ value: option.value, label: option.label, title: option.title })),
					}),
				),
				footer: React.createElement(
					React.Fragment,
					null,
					React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => finish(null) }, '取消'),
					React.createElement(Button, {
						variant: 'primary', size: 'sm', onClick: () => finish(selected),
					}, confirmLabel),
				),
			});
		}
		return React.createElement(Content);
	});
}

/** 表单字段的公共属性。 */
interface FormFieldBase {
	readonly name: string;
	readonly label?: string;
	/** 条件显示：返回 false 时该字段不渲染（依据其他字段的当前值判断）。 */
	readonly visibleWhen?: (values: Record<string, unknown>) => boolean;
}

/** 表单字段定义。 */
export type FormField =
	| (FormFieldBase & { readonly type: 'text'; readonly placeholder?: string; readonly value?: string })
	| (FormFieldBase & { readonly type: 'textarea'; readonly placeholder?: string; readonly value?: string })
	| (FormFieldBase & { readonly type: 'checkbox'; readonly value?: boolean })
	| (FormFieldBase & { readonly type: 'select'; readonly value?: string; readonly options: ReadonlyArray<DropdownOption> })
	| (FormFieldBase & { readonly type: 'dropdown'; readonly value?: string; readonly options: ReadonlyArray<DropdownOption> })
	| (FormFieldBase & { readonly type: 'multiselect'; readonly value?: readonly string[]; readonly options: ReadonlyArray<{ value: string; label: string }> });

/** 表单选项。 */
export interface FormOptions {
	readonly title: string;
	readonly message?: string;
	readonly fields: readonly FormField[];
	readonly confirmLabel?: string;
}

/**
 * 表单：支持文本、下拉、单选、勾选与多选项。
 *
 * @param options - 见 {@link FormOptions}。
 * @returns 用户确认返回字段值对象，取消返回 null。
 */
export function showForm({ title, message = '', fields, confirmLabel = '确定' }: FormOptions): Promise<Record<string, unknown> | null> {
	return runDialog<Record<string, unknown> | null>((finish) => {
		function Content(): React.ReactElement {
			const initial: Record<string, unknown> = {};
			for (const field of fields) {
				if (field.type === 'checkbox') initial[field.name] = field.value === true;
				else if (field.type === 'multiselect') initial[field.name] = Array.isArray(field.value) ? [...field.value] : [];
				else initial[field.name] = field.value ?? '';
			}
			const [values, setValues] = React.useState<Record<string, unknown>>(initial);
			const setField = (name: string, value: unknown): void => setValues((previous) => ({ ...previous, [name]: value }));
			const submit = (): void => finish(values);
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(null),
				title,
				closeLabel: '关闭',
				children: React.createElement(
					React.Fragment,
					null,
					message !== '' && React.createElement('div', { className: css.dialogHint }, message),
					...fields.map((field) => buildField(field, values, setField, submit)),
				),
				footer: React.createElement(
					React.Fragment,
					null,
					React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => finish(null) }, '取消'),
					React.createElement(Button, {
						variant: 'primary', size: 'sm', onClick: submit,
					}, confirmLabel),
				),
			});
		}
		return React.createElement(Content);
	});
}

/** 分页表单的一页。 */
export interface FormPage {
	/** 页签值，需唯一。 */
	readonly value: string;
	/** 页签文案。 */
	readonly label: string;
	/** 该页的说明文字。 */
	readonly message?: string;
	/** 该页字段。 */
	readonly fields: readonly FormField[];
}

/** 分页表单选项。 */
export interface TabbedFormOptions {
	readonly title: string;
	/** 页列表，非空。 */
	readonly pages: readonly [FormPage, ...FormPage[]];
	readonly confirmLabel?: string;
}

/**
 * 分页表单：顶部页签切换页面，底部确认返回全部页的字段值。
 *
 * 各页字段共享一份值对象，切换页签不丢失已填内容；返回结果用 `page` 键附带所选页签值，
 * 便于调用方按当前页决定后续动作。
 *
 * @param options - 见 {@link TabbedFormOptions}。
 * @returns 用户确认返回字段值对象（含 `page`），取消返回 null。
 */
/**
 * 分页表单：顶部页签切换页面，底部确认返回当前页的字段值。
 *
 * 各页字段值互相隔离，同名不会串值（如两页各有 `name`）；切换页签保留各自已填内容。
 * 返回结果附带 `page` 表示所选页签，其后是该页的字段值。
 *
 * @param options - 见 {@link TabbedFormOptions}。
 * @returns 用户确认返回当前页的字段值（含 `page`），取消返回 null。
 */
export function showTabbedForm({ title, pages, confirmLabel = '确定' }: TabbedFormOptions): Promise<Record<string, unknown> | null> {
	return runDialog<Record<string, unknown> | null>((finish) => {
		function Content(): React.ReactElement {
			// 每页一份值对象：同名不跨页覆盖。
			const initial: Record<string, Record<string, unknown>> = {};
			for (const page of pages) {
				const pageValues: Record<string, unknown> = {};
				for (const field of page.fields) {
					if (field.type === 'checkbox') pageValues[field.name] = field.value === true;
					else if (field.type === 'multiselect') pageValues[field.name] = Array.isArray(field.value) ? [...field.value] : [];
					else pageValues[field.name] = field.value ?? '';
				}
				initial[page.value] = pageValues;
			}
			const [values, setValues] = React.useState<Record<string, Record<string, unknown>>>(initial);
			const [activeValue, setActiveValue] = React.useState<string>(pages[0].value);
			const active = pages.find((page) => page.value === activeValue) ?? pages[0];
			const activeValues = values[active.value] ?? {};
			const setField = (name: string, value: unknown): void => setValues((previous) => ({
				...previous,
				[active.value]: { ...(previous[active.value] ?? {}), [name]: value },
			}));
			// SegmentedTabs 要求非空元组：首项单独取，其余展开。
			const tabItems: [SegmentedTab, ...SegmentedTab[]] = [
				{ value: pages[0].value, label: pages[0].label, id: `ggg-tab-${pages[0].value}`, panelId: `ggg-panel-${pages[0].value}` },
				...pages.slice(1).map((page) => ({
					value: page.value, label: page.label,
					id: `ggg-tab-${page.value}`, panelId: `ggg-panel-${page.value}`,
				})),
			];
			const submit = (): void => finish({ page: active.value, ...activeValues });
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(null),
				title,
				closeLabel: '关闭',
				children: React.createElement(
					React.Fragment,
					null,
					pages.length > 1 && React.createElement(SegmentedTabs, {
						label: title,
						value: active.value,
						onChange: setActiveValue,
						items: tabItems,
					}),
					active.message !== undefined && active.message !== '' && React.createElement('div', { className: css.dialogHint }, active.message),
					...active.fields.map((field) => buildField(field, activeValues, setField, submit)),
				),
				footer: React.createElement(
					React.Fragment,
					null,
					React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => finish(null) }, '取消'),
					React.createElement(Button, {
						variant: 'primary', size: 'sm',
						onClick: submit,
					}, confirmLabel),
				),
			});
		}
		return React.createElement(Content);
	});
}

/**
 * 下拉字段：字段标签 + 共享下拉控件。
 *
 * @param props.name - 字段名（用于生成 id）。
 * @param props.label - 字段标签。
 * @param props.options - 选项。
 * @param props.value - 当前值。
 * @param props.onChange - 变更回调。
 * @returns 字段元素。
 */
function DropdownField({ name, label, options, value, onChange }: {
	name: string;
	label?: string | undefined;
	options: ReadonlyArray<DropdownOption>;
	value: string;
	onChange: (next: string) => void;
}): React.ReactElement {
	return React.createElement(
		'div',
		{ className: css.field },
		label !== undefined && React.createElement('label', { className: css.fieldLabel }, label),
		React.createElement(Dropdown, { id: `ggg-field-${name}`, options, value, onChange }),
	);
}

/**
 * 构造单个表单字段。
 *
 * @param field - 字段定义。
 * @param values - 当前全部字段值。
 * @param setField - 字段赋值回调。
 * @param onEnter - 末位回车：与点确认按钮同义。
 * @returns 字段元素；条件不满足时返回 null。
 */
function buildField(
	field: FormField,
	values: Record<string, unknown>,
	setField: (name: string, value: unknown) => void,
	onEnter: () => void,
): React.ReactElement | null {
	if (field.visibleWhen !== undefined && !field.visibleWhen(values)) return null;
	const current = values[field.name];
	if (field.type === 'text') {
		return React.createElement(
			'div',
			{ key: field.name, className: css.field },
			field.label !== undefined && React.createElement('label', { className: css.fieldLabel }, field.label),
			React.createElement(Input, {
				value: typeof current === 'string' ? current : '',
				placeholder: field.placeholder ?? '',
				onChange: (event: React.ChangeEvent<HTMLInputElement>) => setField(field.name, event.target.value),
				// 单行字段里回车即确认：该位置没有换行语义。
				onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
					if (event.key === 'Enter') { event.preventDefault(); onEnter(); }
				},
			}),
		);
	}
	if (field.type === 'textarea') {
		return React.createElement(
			'div',
			{ key: field.name, className: css.field },
			field.label !== undefined && React.createElement('label', { className: css.fieldLabel }, field.label),
			React.createElement('textarea', {
				className: css.fieldTextarea,
				value: typeof current === 'string' ? current : '',
				placeholder: field.placeholder ?? '',
				rows: 4,
				onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setField(field.name, event.target.value),
				// 有换行语义的字段：回车确认，Shift+回车插入换行。
				onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
					if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onEnter(); }
				},
			}),
		);
	}
	if (field.type === 'checkbox') {
		// Checkbox 自身携带可见文案且根元素是 `<label>`，文案不再另加节点。
		return React.createElement(
			'div',
			{ key: field.name, className: cx(css.field, css.fieldInline) },
			React.createElement(Checkbox, {
				checked: current === true,
				onChange: (next: boolean) => setField(field.name, next),
				label: field.label ?? '',
			}),
		);
	}
	if (field.type === 'select') {
		return React.createElement(
			'div',
			{ key: field.name, className: css.field },
			field.label !== undefined && React.createElement('label', { className: css.fieldLabel }, field.label),
			React.createElement(SegmentedControl, {
				id: `ggg-field-${field.name}`,
				label: field.label ?? field.name,
				value: typeof current === 'string' ? current : '',
				onChange: (next: string) => setField(field.name, next),
				options: field.options.map((option) => ({ value: option.value, label: option.label, title: option.title })),
			}),
		);
	}
	if (field.type === 'dropdown') {
		return React.createElement(DropdownField, {
			key: field.name,
			name: field.name,
			label: field.label,
			options: field.options,
			value: typeof current === 'string' ? current : '',
			onChange: (next: string) => setField(field.name, next),
		});
	}
	if (field.type === 'multiselect') {
		const selected = Array.isArray(current) ? current as string[] : [];
		return React.createElement(
			'div',
			{ key: field.name, className: css.field },
			field.label !== undefined && React.createElement('label', { className: css.fieldLabel }, field.label),
			...field.options.map((option) => {
				const checked = selected.includes(option.value);
				// Checkbox 自身携带可见文案且根元素是 `<label>`，文案不再另加节点。
				return React.createElement(
					'div',
					{ key: option.value, className: cx(css.field, css.fieldInline) },
					React.createElement(Checkbox, {
						checked,
						onChange: (next: boolean) => {
							const values2 = next
								? [...selected, option.value]
								: selected.filter((item) => item !== option.value);
							setField(field.name, values2);
						},
						label: option.label,
					}),
				);
			}),
		);
	}
	return null;
}
