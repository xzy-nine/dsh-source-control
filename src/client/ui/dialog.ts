/**
 * 自建弹窗基础设施：基于 DSH 的 Modal 封装确认框、输入框、表单与单选。
 *
 * 这些封装以 Promise 返回用户操作结果，调用方用 await 串接即可。
 */
import React from 'react';
import {
	Button, Checkbox, Input, Modal, RiskConfirmation, SegmentedControl, SegmentedTabs, writeClipboard, type SegmentedTab,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { Dropdown, type DropdownOption, type DropdownValueProps } from './dropdown.ts';
import { AnsiText } from './ansi.ts';
import { pushDialog, removeDialog } from './overlay-host.ts';
import css from '../css/dialog.module.css';
import { cx } from '../css/cx.ts';

export type { DropdownOption };

/**
 * 说明文字节点：按 ANSI 颜色渲染探测与命令的输出，纯文本原样呈现。
 *
 * @param message - 说明文字。
 * @returns 节点。
 */
function messageText(message: string): React.ReactElement {
	return React.createElement(AnsiText, { text: message });
}

/**
 * 构造弹窗主体：可选说明文字在前，其余节点依次排列。
 *
 * @param message - 说明文字；空串时不渲染。
 * @param children - 其余主体节点。
 * @returns 主体元素。
 */
function dialogBody(message: string, ...children: React.ReactNode[]): React.ReactElement {
	return React.createElement(
		React.Fragment,
		null,
		message !== '' && React.createElement('div', { className: css.dialogHint }, messageText(message)),
		...children,
	);
}

/**
 * 构造弹窗主体：节点依次排列，说明文字在最后给出的位置渲染。
 *
 * @param children - 主体节点；说明文字由调用方按位置给出。
 * @returns 主体元素。
 */
function dialogNodes(...children: React.ReactNode[]): React.ReactElement {
	return React.createElement(React.Fragment, null, ...children);
}

/**
 * 说明文字节点；空串时不渲染。
 *
 * @param message - 说明文字。
 * @returns 节点或 false。
 */
function hintNode(message: string): React.ReactNode {
	return message !== '' && React.createElement('div', { className: css.dialogHint }, messageText(message));
}

/**
 * 构造一个弹窗。
 *
 * @param title - 标题。
 * @param onClose - 关闭回调。
 * @param body - 主体节点。
 * @param footer - 页脚节点。
 * @returns 弹窗元素。
 */
function dialogModal(title: string, onClose: () => void, body: React.ReactNode, footer: React.ReactNode): React.ReactElement {
	return React.createElement(Modal, {
		open: true,
		onClose,
		title,
		closeLabel: '关闭',
		children: body,
		footer,
	});
}

/**
 * 弹窗底部的「取消 + 确认」页脚。
 *
 * @param onCancel - 取消回调。
 * @param onConfirm - 确认回调。
 * @param confirmLabel - 确认按钮文案。
 * @param cancelLabel - 取消按钮文案。
 * @param confirmDisabled - 确认按钮是否禁用。
 * @param danger - 确认按钮是否按危险样式呈现。
 * @returns 页脚元素。
 */
function confirmFooter(
	onCancel: () => void,
	onConfirm: () => void,
	confirmLabel: string,
	cancelLabel = '取消',
	confirmDisabled = false,
	danger = false,
): React.ReactElement {
	return React.createElement(
		React.Fragment,
		null,
		React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onCancel }, cancelLabel),
		primaryButton({ label: confirmLabel, onClick: onConfirm, disabled: confirmDisabled, danger }),
	);
}

/**
 * 把一个弹窗投进覆盖层队列，并在结束后摘除。
 *
 * 传入的是组件；覆盖层在挂载时才渲染它，弹窗内的状态钩子落在组件里。
 *
 * @param build - 接收 finish(result) 回调，返回弹窗组件。
 * @returns 用户操作结果。
 */
function runDialog<T>(build: (finish: (result: T) => void) => React.FunctionComponent): Promise<T> {
	return new Promise((resolve) => {
		pushDialog((id) => {
			const Content = build((result) => {
				resolve(result);
				// 摘除延后一帧执行：退出动画在这段时间里播放。
				requestAnimationFrame(() => { removeDialog(id); });
			});
			return React.createElement(Content);
		});
	});
}

/**
 * 跑一个弹窗，内容由调用方按 `finish` 返回。
 *
 * `runDialog` 的入参是「组件工厂」，每个弹窗都还要自己套一层
 * `function Content(): React.ReactElement`。这里把那一层收进来，调用方只写内容函数。
 *
 * @param build - 接收 finish(result) 回调，返回弹窗元素的函数。
 * @returns 用户操作结果。
 */
function dialogContent<T>(build: (finish: (result: T) => void) => React.ReactElement): Promise<T> {
	return runDialog<T>((finish) => function Content(): React.ReactElement {
		return build(finish);
	});
}

/**
 * 带一份局部状态的弹窗：状态在内容组件里建立，内容函数拿到当前值与写入器。
 *
 * @param initial - 初始值，或惰性给出初始值的函数。
 * @param build - 内容函数：接收 finish 回调与这份状态。
 * @returns 用户操作结果。
 */
function statefulDialog<T, S>(
	initial: S | (() => S),
	build: (
		finish: (result: T) => void,
		value: S,
		setValue: React.Dispatch<React.SetStateAction<S>>,
	) => React.ReactElement,
): Promise<T> {
	return dialogContent<T>((finish) => {
		const [value, setValue] = React.useState(initial);
		return build(finish, value, setValue);
	});
}

/**
 * 取消与关闭同义的弹窗：两者都返回 null。
 *
 * @param title - 标题。
 * @param finish - 结果回调。
 * @param body - 主体节点。
 * @param onConfirm - 确认回调。
 * @param confirmLabel - 确认按钮文案。
 * @param confirmDisabled - 确认按钮是否禁用。
 * @returns 弹窗元素。
 */
function cancelableModal(
	title: string,
	finish: (result: null) => void,
	body: React.ReactNode,
	onConfirm: () => void,
	confirmLabel: string,
	confirmDisabled = false,
): React.ReactElement {
	return dialogModal(title, () => { finish(null); }, body, confirmFooter(() => { finish(null); }, onConfirm, confirmLabel, '取消', confirmDisabled));
}

/** 带确认与取消的弹窗选项。 */
export interface ConfirmOptions {
	readonly title: string;
	readonly message: string;
	readonly confirmLabel?: string;
	readonly cancelLabel?: string;
	readonly danger?: boolean;
}

/** 确认框选项。 */
export type ConfirmationOptions = ConfirmOptions;

/**
 * 关闭与确认各自结束的弹窗：关闭回投 `closeWith`。
 *
 * @param title - 标题。
 * @param finish - 结果回调。
 * @param closeWith - 关闭与取消时的结果。
 * @param body - 主体节点。
 * @param footer - 页脚节点。
 * @returns 弹窗元素。
 */
function closedDialog<T>(
	title: string,
	finish: (result: T) => void,
	closeWith: T,
	body: React.ReactNode,
	footer: React.ReactNode,
): React.ReactElement {
	return dialogModal(title, () => { finish(closeWith); }, body, footer);
}

/**
 * 简单确认框。
 *
 * @param options - 见 {@link ConfirmationOptions}。
 * @returns 用户点确认返回 true，否则 false。
 */
export function showConfirmation({ title, message, confirmLabel = '确认', cancelLabel = '取消', danger = false }: ConfirmationOptions): Promise<boolean> {
	return dialogContent<boolean>((finish) => {
		return closedDialog(title, finish, false,
			React.createElement('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, messageText(message)),
			confirmFooter(() => { finish(false); }, () => { finish(true); }, confirmLabel, cancelLabel, false, danger));
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
	return dialogContent<undefined>((finish) => {
		return closedDialog(title, finish, undefined,
			React.createElement('div', { className: css.dialogHint }, messageText(message)),
			primaryButton({ label: closeLabel, onClick: () => { finish(undefined); } }));
	});
}

/**
 * 提示框里的一个入口：文案与动作由调用方给，弹窗只排版。
 *
 * 结果里的去向（如 issue 地址）跟着结果走，因此留在结果弹窗里，
 * 不散落在触发它的表单页上。
 */
export interface MessageLink {
	/** 入口文案。 */
	readonly label: string;
	/** 点击回调。 */
	readonly onClick: () => void;
}

/** 含入口与勾选的提示框选项。 */
export interface MessageLinksOptions {
	readonly title: string;
	readonly message: string;
	/** 结果里可点的入口，按给出顺序排列。 */
	readonly links?: readonly MessageLink[];
	/** 勾选项文案；缺省时不渲染勾选。 */
	readonly checkboxLabel?: string;
	/** 初始勾选状态；缺省为勾选。 */
	readonly checked?: boolean;
	/** 关闭按钮文案。 */
	readonly closeLabel?: string;
}

/**
 * 含入口与勾选的提示框：关闭时回投勾选状态。
 *
 * 勾选不门控关闭——它表达的是关闭之后的后续动作，不是对本条提示的确认。
 *
 * @param options - 见 {@link MessageLinksOptions}。
 * @returns 关闭时是否勾选；没有勾选项时恒为 false。
 */
export function showMessageWithLinks({ title, message, links = [], checkboxLabel, checked = true, closeLabel = '知道了' }: MessageLinksOptions): Promise<boolean> {
	return statefulDialog<boolean, boolean>(checked, (finish, on, setOn) => {
		const close = (): void => { finish(checkboxLabel === undefined ? false : on); };
		return dialogModal(
			title,
			close,
			dialogBody(
				message,
				links.length > 0 && React.createElement(
					'div',
					{ className: css.dialogLinks },
					...links.map((link) => React.createElement('button', {
						key: link.label, type: 'button', className: css.dialogLink,
						onClick: link.onClick,
					}, link.label)),
				),
				checkboxLabel !== undefined && React.createElement(Checkbox, { checked: on, label: checkboxLabel, onChange: setOn }),
			),
			primaryButton({ label: closeLabel, onClick: close }),
		);
	});
}

/**
 * 错误框：显示失败原因，正文可整段复制。
 *
 * @param message - 错误文本。
 * @returns 用户关闭后完成。
 */
export function showError(message: string): Promise<void> {
	return statefulDialog<undefined, boolean>(false, (finish, copied, setCopied) => {
		/** 复制正文；写入失败时按钮文案保持「复制」。 */
		const copy = async (): Promise<void> => {
			try {
				if (await writeClipboard(message)) setCopied(true);
			} catch {
				/* 写入失败：按钮文案不变 */
			}
		};
		return dialogModal(
			'操作失败',
			() => { finish(undefined); },
			React.createElement(
				'div',
				{ style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, maxHeight: 240, overflow: 'auto' } },
				messageText(message),
			),
			// 取消位承担复制，确认位承担关闭。
			confirmFooter(() => { void copy(); }, () => { finish(undefined); }, '知道了', copied ? '已复制' : '复制'),
		);
	});
}

/** 含勾选的确认框选项。 */
export interface CheckboxOptions extends ConfirmOptions {
	readonly checkboxLabel: string;
}

/**
 * 含勾选的确认框：复选框未勾选时确认按钮禁用。
 *
 * @param options - 见 {@link CheckboxOptions}。
 * @returns 用户勾选并确认返回 true，否则 false。
 */
export function showCheckbox({ title, message, checkboxLabel, confirmLabel = '确认', cancelLabel = '取消' }: CheckboxOptions): Promise<boolean> {
	return statefulDialog<boolean, boolean>(false, (finish, acknowledged, setAcknowledged) => {
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
			onCancel: () => { finish(false); },
			onConfirm: () => { finish(true); },
		});
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
	return statefulDialog<string | null, string>(value, (finish, text, setText) => {
		const submit = (): void => { if (text.trim() !== '') finish(text.trim()); };
		return cancelableModal(title, finish, dialogBody(
			message,
			label !== '' && React.createElement('label', { className: css.fieldLabel, htmlFor: 'ggg-text-input' }, label),
			React.createElement(Input, {
				id: 'ggg-text-input',
				value: text,
				placeholder,
				onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setText(event.target.value); },
				// 单行输入框里回车即确认。
				onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
					if (event.key === 'Enter') { event.preventDefault(); submit(); }
				},
			}),
		), submit, confirmLabel, text.trim() === '');
	});
}

/**
 * 单选框选项。
 *
 * 段内只放得下短文案：`label` 超出列宽时按省略号截断，完整名称挂在悬停提示上；
 * 地址这类放不下的长文本放 `description`，它不在段内，只在选中后于控件下方整行显示。
 */
export interface SelectOptions {
	readonly title: string;
	readonly message?: string;
	readonly options: ReadonlyArray<{ value: string; label: string; description?: string; title?: string }>;
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
	return statefulDialog<string | null, string>(value ?? options.at(0)?.value ?? '', (finish, selected, setSelected) => {
		const detail = options.find((option) => option.value === selected)?.description;
		return cancelableModal(title, finish, dialogBody(
			message,
			React.createElement(SegmentedControl, {
				id: 'ggg-select',
				label: title,
				value: selected,
				onChange: setSelected,
				className: css.selectControl,
				options: options.map((option) => ({ value: option.value, label: option.label, title: option.title ?? option.label })),
			}),
			detail !== undefined && detail !== '' && React.createElement('div', { className: css.selectDescription }, detail),
		), () => { finish(selected); }, confirmLabel);
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
 * 取一组字段的初始值。
 *
 * @param fields - 字段定义。
 * @returns 字段名到初始值的映射。
 */
function initialValues(fields: readonly FormField[]): Record<string, unknown> {
	const initial: Record<string, unknown> = {};
	for (const field of fields) {
		if (field.type === 'checkbox') initial[field.name] = field.value === true;
		else if (field.type === 'multiselect') initial[field.name] = Array.isArray(field.value) ? [...field.value] : [];
		else initial[field.name] = field.value ?? '';
	}
	return initial;
}

/**
 * 弹窗里的主操作按钮。
 *
 * 弹窗的确认、关闭与保存都长这一颗：主色、小号、可带危险样式。语序与尺寸因此只有一处。
 *
 * @param props.label - 按钮文案。
 * @param props.onClick - 点击处理。
 * @param props.disabled - 是否禁用。
 * @param props.danger - 是否用危险样式。
 * @returns 按钮元素。
 */
export function primaryButton({ label, onClick, disabled = false, danger = false }: {
	readonly label: string;
	readonly onClick: () => void;
	readonly disabled?: boolean;
	readonly danger?: boolean;
}): React.ReactElement {
	return React.createElement(Button, {
		variant: 'primary', size: 'sm',
		disabled,
		className: danger ? css.btnDanger : undefined,
		onClick,
	}, label);
}

/**
 * 按字段名写入一格值。
 *
 * 单个值对象与分页表单的某一页共用这一层：差别只在「写哪一份」，因此由调用方给出写入函数。
 *
 * @param setValues - 状态写入器。
 * @param write - 拿到上一份值与字段名后给出新一份值。
 * @returns 按字段名写入的回调。
 */
function fieldWriter<S>(
	setValues: React.Dispatch<React.SetStateAction<S>>,
	write: (previous: S, name: string, value: unknown) => S,
): (name: string, value: unknown) => void {
	return (name, value) => { setValues((previous) => write(previous, name, value)); };
}


/**
 * 表单：支持文本、下拉、单选、勾选与多选项。
 *
 * @param options - 见 {@link FormOptions}。
 * @returns 用户确认返回字段值对象，取消返回 null。
 */
export function showForm({ title, message = '', fields, confirmLabel = '确定' }: FormOptions): Promise<Record<string, unknown> | null> {
	return statefulDialog<Record<string, unknown> | null, Record<string, unknown>>(
		() => initialValues(fields),
		(finish, values, setValues) => {
			const setField = fieldWriter(setValues, (previous, name, value) => ({ ...previous, [name]: value }));
			const submit = (): void => { finish(values); };
			return cancelableModal(
				title,
				finish,
				dialogBody(message, ...fields.map((field) => buildField(field, values, setField, submit))),
				submit,
				confirmLabel,
			);
		},
	);
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
 * 分页表单：顶部页签切换页面，底部确认返回当前页的字段值。
 *
 * 各页字段值互相隔离，同名不会串值（如两页各有 `name`）；切换页签保留各自已填内容。
 * 返回结果附带 `page` 表示所选页签，其后是该页的字段值。
 *
 * @param options - 见 {@link TabbedFormOptions}。
 * @returns 用户确认返回当前页的字段值（含 `page`），取消返回 null。
 */
export function showTabbedForm({ title, pages, confirmLabel = '确定' }: TabbedFormOptions): Promise<Record<string, unknown> | null> {
	// 每页一份值对象，同名不跨页覆盖。
	const initial: Record<string, Record<string, unknown>> = {};
	for (const page of pages) initial[page.value] = initialValues(page.fields);
	return statefulDialog<Record<string, unknown> | null, Record<string, Record<string, unknown>>>(
		initial,
		(finish, values, setValues) => {
			const [activeValue, setActiveValue] = React.useState<string>(pages[0].value);
			const active = pages.find((page) => page.value === activeValue) ?? pages[0];
			const activeValues = values[active.value] ?? {};
			// 每页一份值对象，写入只动当前页那一层，同名不跨页覆盖。
			const setField = fieldWriter(setValues, (previous, name, value) => ({
				...previous, [active.value]: { ...(previous[active.value] ?? {}), [name]: value },
			}));
			// SegmentedTabs 要求非空元组：首项单独取，其余展开。
			const tabItems: [SegmentedTab, ...SegmentedTab[]] = [
				{ value: pages[0].value, label: pages[0].label, id: `ggg-tab-${pages[0].value}`, panelId: `ggg-panel-${pages[0].value}` },
				...pages.slice(1).map((page) => ({
					value: page.value, label: page.label,
					id: `ggg-tab-${page.value}`, panelId: `ggg-panel-${page.value}`,
				})),
			];
			const submit = (): void => { finish({ page: active.value, ...activeValues }); };
			return cancelableModal(title, finish, dialogNodes(
				pages.length > 1 && React.createElement(SegmentedTabs, {
					label: title,
					value: active.value,
					onChange: setActiveValue,
					items: tabItems,
				}),
				hintNode(active.message ?? ''),
				...active.fields.map((field) => buildField(field, activeValues, setField, submit)),
			), submit, confirmLabel);
		},
	);
}

/**
 * 用字段容器包住一个控件，并在有标签时先渲染标签。
 *
 * @param field - 字段定义；取其 name 作为 key、label 作为标签文案。
 * @param control - 控件元素。
 * @returns 字段元素。
 */
function labeledField(field: FormField, control: React.ReactElement): React.ReactElement {
	return React.createElement(
		'div',
		{ key: field.name, className: css.field },
		field.label !== undefined && React.createElement('label', { className: css.fieldLabel }, field.label),
		control,
	);
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
function DropdownField({ name, label, ...choice }: { name: string; label?: string | undefined } & DropdownValueProps): React.ReactElement {
	return labeledField(
		{ name, label, type: 'dropdown', options: choice.options },
		React.createElement(Dropdown, { ...choice, id: `ggg-field-${name}` }),
	);
}

/**
 * 回车键按下时执行确认。
 *
 * 单行字段按下回车即确认；多行字段保留 Shift+回车换行。
 *
 * @param onEnter - 确认回调。
 * @param shiftInsertsNewline - 是否保留 Shift+回车插入换行。
 * @returns 键按下处理器。
 */
function enterConfirms(onEnter: () => void, shiftInsertsNewline = false): (event: React.KeyboardEvent<HTMLElement>) => void {
	return (event) => {
		if (event.key !== 'Enter') return;
		if (shiftInsertsNewline && event.shiftKey) return;
		event.preventDefault();
		onEnter();
	};
}

/**
 * 一行单独的复选框：自带文案，所在行同时是点击区。
 *
 * @param key - React 的兄弟节点键。
 * @param checked - 当前勾选状态。
 * @param label - 复选框文案。
 * @param onChange - 变更回调。
 * @returns 行元素。
 */
function checkboxRow(
	key: string,
	checked: boolean,
	label: string,
	onChange: (next: boolean) => void,
): React.ReactElement {
	/* Checkbox 自身携带可见文案且根元素是 `<label>`，文案由它承载，无需另加节点。 */
	return React.createElement('div', { key, className: cx(css.field, css.fieldInline) },
		React.createElement(Checkbox, { checked, onChange, label }));
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
	const text = typeof current === 'string' ? current : '';
	const setText = (next: string): void => { setField(field.name, next); };
	if (field.type === 'text') {
		return labeledField(field, React.createElement(Input, {
			value: text,
			placeholder: field.placeholder ?? '',
			onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setField(field.name, event.target.value); },
			onKeyDown: enterConfirms(onEnter),
		}));
	}
	if (field.type === 'textarea') {
		return labeledField(field, React.createElement('textarea', {
			className: css.fieldTextarea,
			value: text,
			placeholder: field.placeholder ?? '',
			rows: 4,
			onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { setField(field.name, event.target.value); },
			onKeyDown: enterConfirms(onEnter, true),
		}));
	}
	if (field.type === 'checkbox') {
		return checkboxRow(field.name, current === true, field.label ?? '', (next) => { setField(field.name, next); });
	}
	if (field.type === 'select') {
		return labeledField(field, React.createElement(SegmentedControl, {
			id: `ggg-field-${field.name}`,
			label: field.label ?? field.name,
			value: text,
			onChange: setText,
			className: css.selectControl,
			options: field.options.map((option) => ({ value: option.value, label: option.label, title: option.title ?? option.label })),
		}));
	}
	if (field.type === 'dropdown') {
		return React.createElement(DropdownField, {
			key: field.name,
			name: field.name,
			label: field.label,
			options: field.options,
			value: text,
			onChange: setText,
		});
	}
	const selected = Array.isArray(current) ? current as string[] : [];
	return labeledField(field, React.createElement(
		React.Fragment,
		null,
		...field.options.map((option) => checkboxRow(option.value, selected.includes(option.value), option.label, (next) => {
			setField(field.name, next
				? [...selected, option.value]
				: selected.filter((item) => item !== option.value));
		})),
	));
}
