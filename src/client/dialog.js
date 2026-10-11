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
 * @param {function} build - 接收 finish(result) 回调，返回要渲染的 React 元素。
 * @returns {Promise<*>} 用户操作结果。
 */
function runDialog(build) {
	return new Promise((resolve) => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		const finish = (result) => {
			resolve(result);
			requestAnimationFrame(() => {
				root.unmount();
				container.remove();
			});
		};
		root.render(build(finish));
	});
}

/**
 * 简单确认框。
 *
 * @param {object} options - 选项。
 * @param {string} options.title - 标题。
 * @param {string} options.message - 正文。
 * @param {string} [options.confirmLabel] - 确认按钮文案。
 * @param {string} [options.cancelLabel] - 取消按钮文案。
 * @param {boolean} [options.danger] - 确认按钮是否使用危险样式。
 * @returns {Promise<boolean>} 用户点确认返回 true，否则 false。
 */
export function showConfirmation({ title, message, confirmLabel = '确认', cancelLabel = '取消', danger = false }) {
	return runDialog((finish) => {
		function Content() {
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
						variant: danger ? 'danger' : 'primary', size: 'sm', onClick: () => finish(true),
					}, confirmLabel),
				),
			});
		}
		return React.createElement(Content);
	});
}

/**
 * 含勾选的确认框：复选框未勾选时确认按钮禁用。
 *
 * @param {object} options - 选项。
 * @param {string} options.title - 标题。
 * @param {string} options.message - 正文。
 * @param {string} options.checkboxLabel - 复选框文案。
 * @param {string} [options.confirmLabel] - 确认按钮文案。
 * @param {string} [options.cancelLabel] - 取消按钮文案。
 * @param {boolean} [options.danger] - 确认按钮是否使用危险样式。
 * @returns {Promise<boolean>} 用户勾选并确认返回 true，否则 false。
 */
export function showCheckbox({ title, message, checkboxLabel, confirmLabel = '确认', cancelLabel = '取消', danger = false }) {
	return runDialog((finish) => {
		function Content() {
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

/**
 * 文本输入框。
 *
 * @param {object} options - 选项。
 * @param {string} options.title - 标题。
 * @param {string} [options.message] - 可选提示行。
 * @param {string} [options.label] - 输入框标签。
 * @param {string} [options.value] - 初始文本。
 * @param {string} [options.placeholder] - 占位文本。
 * @param {string} [options.confirmLabel] - 确认按钮文案。
 * @returns {Promise<string|null>} 用户确认返回输入文本，取消返回 null。
 */
export function showText({ title, message, label, value = '', placeholder = '', confirmLabel = '确定' }) {
	return runDialog((finish) => {
		function Content() {
			const [text, setText] = React.useState(value);
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(null),
				title,
				closeLabel: '关闭',
				children: React.createElement(
					React.Fragment,
					null,
					message !== undefined && message !== '' && React.createElement('div', { className: 'ggg-dialog-hint' }, message),
					label !== undefined && label !== '' && React.createElement('label', { className: 'ggg-field-label', htmlFor: 'ggg-text-input' }, label),
					React.createElement(Input, {
						id: 'ggg-text-input',
						value: text,
						placeholder,
						onChange: (event) => setText(event.target.value),
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

/**
 * 单选框：在多个互斥选项中选一个。
 *
 * @param {object} options - 选项。
 * @param {string} options.title - 标题。
 * @param {string} [options.message] - 可选提示行。
 * @param {Array<{value:string,label:string,title?:string}>} options.options - 选项列表。
 * @param {string} [options.value] - 初始选项值。
 * @param {string} [options.confirmLabel] - 确认按钮文案。
 * @returns {Promise<string|null>} 用户确认返回所选值，取消返回 null。
 */
export function showSelect({ title, message, options, value, confirmLabel = '确定' }) {
	return runDialog((finish) => {
		function Content() {
			const [selected, setSelected] = React.useState(value ?? options[0]?.value ?? '');
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(null),
				title,
				closeLabel: '关闭',
				children: React.createElement(
					React.Fragment,
					null,
					message !== undefined && message !== '' && React.createElement('div', { className: 'ggg-dialog-hint' }, message),
					React.createElement(SegmentedControl, {
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

/**
 * 表单：支持文本、下拉、单选、勾选与多选项。
 *
 * @param {object} options - 选项。
 * @param {string} options.title - 标题。
 * @param {string} [options.message] - 可选提示行。
 * @param {Array<object>} options.fields - 字段定义。
 * @param {string} [options.confirmLabel] - 确认按钮文案。
 * @returns {Promise<object|null>} 用户确认返回字段值对象，取消返回 null。
 */
export function showForm({ title, message, fields, confirmLabel = '确定' }) {
	return runDialog((finish) => {
		function Content() {
			const initial = {};
			for (const field of fields) {
				if (field.type === 'checkbox') initial[field.name] = field.value === true;
				else if (field.type === 'multiselect') initial[field.name] = Array.isArray(field.value) ? [...field.value] : [];
				else initial[field.name] = field.value ?? '';
			}
			const [values, setValues] = React.useState(initial);
			const setField = (name, value) => setValues((previous) => ({ ...previous, [name]: value }));
			return React.createElement(Modal, {
				open: true,
				onClose: () => finish(null),
				title,
				closeLabel: '关闭',
				children: React.createElement(
					React.Fragment,
					null,
					message !== undefined && message !== '' && React.createElement('div', { className: 'ggg-dialog-hint' }, message),
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
 * @param {object} field - 字段定义。
 * @param {object} values - 当前全部字段值。
 * @param {function} setField - 字段赋值回调。
 * @returns 字段元素。
 */
function buildField(field, values, setField) {
	const current = values[field.name];
	if (field.type === 'text') {
		return React.createElement(
			'div',
			{ key: field.name, className: 'ggg-field' },
			field.label !== undefined && React.createElement('label', { className: 'ggg-field-label' }, field.label),
			React.createElement(Input, {
				value: current,
				placeholder: field.placeholder ?? '',
				onChange: (event) => setField(field.name, event.target.value),
			}),
		);
	}
	if (field.type === 'checkbox') {
		return React.createElement(
			'label',
			{ key: field.name, className: 'ggg-field ggg-field-inline' },
			React.createElement(Checkbox, { checked: current, onChange: (event) => setField(field.name, event.target.checked) }),
			React.createElement('span', { className: 'ggg-field-text' }, field.label),
		);
	}
	if (field.type === 'select') {
		return React.createElement(
			'div',
			{ key: field.name, className: 'ggg-field' },
			field.label !== undefined && React.createElement('label', { className: 'ggg-field-label' }, field.label),
			React.createElement(SegmentedControl, {
				value: current,
				onChange: (value) => setField(field.name, value),
				options: field.options.map((option) => ({ value: option.value, label: option.label, title: option.title })),
			}),
		);
	}
	if (field.type === 'multiselect') {
		return React.createElement(
			'div',
			{ key: field.name, className: 'ggg-field' },
			field.label !== undefined && React.createElement('label', { className: 'ggg-field-label' }, field.label),
			...field.options.map((option) => {
				const checked = current.includes(option.value);
				return React.createElement(
					'label',
					{ key: option.value, className: 'ggg-field ggg-field-inline' },
					React.createElement(Checkbox, {
						checked,
						onChange: (event) => {
							const next = event.target.checked
								? [...current, option.value]
								: current.filter((item) => item !== option.value);
							setField(field.name, next);
						},
					}),
					React.createElement('span', { className: 'ggg-field-text' }, option.label),
				);
			}),
		);
	}
	return null;
}
