/**
 * 自建弹窗基础设施：基于 DSH 的 Modal 封装确认框、输入框、表单与单选。
 *
 * 不使用浏览器原生 confirm / prompt，统一走 DSH 的 dialog 外观。
 * 这些封装以 Promise 返回用户操作结果，调用方用 await 串接即可。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
	Button, Checkbox, Input, Modal, RiskConfirmation, SegmentedControl,
} from '@deepseek-ai/dsh-client-ui-primitives';

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
						variant: 'primary', size: 'sm', className: danger ? 'ggg-btn-danger' : undefined,
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
				children: React.createElement('div', { className: 'ggg-dialog-hint' }, message),
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
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(null),
				title,
				closeLabel: '关闭',
				children: React.createElement(
					React.Fragment,
					null,
					message !== '' && React.createElement('div', { className: 'ggg-dialog-hint' }, message),
					label !== '' && React.createElement('label', { className: 'ggg-field-label', htmlFor: 'ggg-text-input' }, label),
					React.createElement(Input, {
						id: 'ggg-text-input',
						value: text,
						placeholder,
						onChange: (event: React.ChangeEvent<HTMLInputElement>) => setText(event.target.value),
					}),
				),
				footer: React.createElement(
					React.Fragment,
					null,
					React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => finish(null) }, '取消'),
					React.createElement(Button, {
						variant: 'primary', size: 'sm', disabled: text.trim() === '', onClick: () => finish(text.trim()),
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
					message !== '' && React.createElement('div', { className: 'ggg-dialog-hint' }, message),
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

/** 表单字段定义。 */
export type FormField =
	| { readonly type: 'text'; readonly name: string; readonly label?: string; readonly placeholder?: string; readonly value?: string }
	| { readonly type: 'checkbox'; readonly name: string; readonly label?: string; readonly value?: boolean }
	| { readonly type: 'select'; readonly name: string; readonly label?: string; readonly value?: string; readonly options: ReadonlyArray<{ value: string; label: string; title?: string }> }
	| { readonly type: 'multiselect'; readonly name: string; readonly label?: string; readonly value?: readonly string[]; readonly options: ReadonlyArray<{ value: string; label: string }> };

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
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(null),
				title,
				closeLabel: '关闭',
				children: React.createElement(
					React.Fragment,
					null,
					message !== '' && React.createElement('div', { className: 'ggg-dialog-hint' }, message),
					...fields.map((field) => buildField(field, values, setField)),
				),
				footer: React.createElement(
					React.Fragment,
					null,
					React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => finish(null) }, '取消'),
					React.createElement(Button, {
						variant: 'primary', size: 'sm', onClick: () => finish(values),
					}, confirmLabel),
				),
			});
		}
		return React.createElement(Content);
	});
}

/**
 * 构造单个表单字段。
 *
 * @param field - 字段定义。
 * @param values - 当前全部字段值。
 * @param setField - 字段赋值回调。
 * @returns 字段元素。
 */
function buildField(field: FormField, values: Record<string, unknown>, setField: (name: string, value: unknown) => void): React.ReactElement | null {
	const current = values[field.name];
	if (field.type === 'text') {
		return React.createElement(
			'div',
			{ key: field.name, className: 'ggg-field' },
			field.label !== undefined && React.createElement('label', { className: 'ggg-field-label' }, field.label),
			React.createElement(Input, {
				value: typeof current === 'string' ? current : '',
				placeholder: field.placeholder ?? '',
				onChange: (event: React.ChangeEvent<HTMLInputElement>) => setField(field.name, event.target.value),
			}),
		);
	}
	if (field.type === 'checkbox') {
		return React.createElement(
			'label',
			{ key: field.name, className: 'ggg-field ggg-field-inline' },
			React.createElement(Checkbox, {
				checked: current === true,
				onChange: (next: boolean) => setField(field.name, next),
				label: field.label ?? '',
			}),
			React.createElement('span', { className: 'ggg-field-text' }, field.label),
		);
	}
	if (field.type === 'select') {
		return React.createElement(
			'div',
			{ key: field.name, className: 'ggg-field' },
			field.label !== undefined && React.createElement('label', { className: 'ggg-field-label' }, field.label),
			React.createElement(SegmentedControl, {
				id: `ggg-field-${field.name}`,
				label: field.label ?? field.name,
				value: typeof current === 'string' ? current : '',
				onChange: (next: string) => setField(field.name, next),
				options: field.options.map((option) => ({ value: option.value, label: option.label, title: option.title })),
			}),
		);
	}
	if (field.type === 'multiselect') {
		const selected = Array.isArray(current) ? current as string[] : [];
		return React.createElement(
			'div',
			{ key: field.name, className: 'ggg-field' },
			field.label !== undefined && React.createElement('label', { className: 'ggg-field-label' }, field.label),
			...field.options.map((option) => {
				const checked = selected.includes(option.value);
				return React.createElement(
					'label',
					{ key: option.value, className: 'ggg-field ggg-field-inline' },
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
					React.createElement('span', { className: 'ggg-field-text' }, option.label),
				);
			}),
		);
	}
	return null;
}
