/**
 * 下拉选择控件：触发器显示当前值，展开后由 DSH 的 Menu 列出选项。
 *
 * 设置面板的行与对话框表单的字段共用这一个实现，仅外层布局由调用方给出。
 * 选项较多时比分段按钮更合适。
 */
import React from 'react';
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import css from '../css/dropdown.module.css';
/** 一个下拉选项。 */
export interface DropdownOption {
	readonly value: string;
	readonly label: string;
	readonly title?: string;
}

/** 下拉控件的属性。 */
export interface DropdownProps {
	/** 选项。 */
	readonly options: ReadonlyArray<DropdownOption>;
	/** 当前值。 */
	readonly value: string;
	/** 变更回调。 */
	readonly onChange: (next: string) => void;
	/** 触发器元素 id；省略时不设置。 */
	readonly id?: string;
	/** 无匹配选项时显示的文本；省略时显示当前值。 */
	readonly fallbackLabel?: string;
}

/**
 * 下拉控件本体：只有触发器与浮层，不含标签与外层布局。
 *
 * @param props - 见 {@link DropdownProps}。
 * @returns 下拉元素。
 */
export function Dropdown({ options, value, onChange, id, fallbackLabel }: DropdownProps): React.ReactElement {
	const [open, setOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const current = options.find((option) => option.value === value);
	return React.createElement(Menu, {
		open,
		portal: true,
		getAnchorRect: () => triggerRef.current?.getBoundingClientRect() ?? null,
		selectedId: value,
		items: options.map((option) => ({ id: option.value, label: option.label, title: option.title })),
		onSelect: (menuId: string) => { setOpen(false); onChange(menuId); },
		onClose: () => setOpen(false),
		anchor: React.createElement('button', {
			type: 'button', ref: triggerRef, id, className: css.setDropdown,
			'aria-haspopup': 'menu', 'aria-expanded': open,
			onClick: () => setOpen((previous) => !previous),
		},
			React.createElement('span', { className: css.setDropdownText }, current?.label ?? fallbackLabel ?? value),
			React.createElement(IconChevronDownOutlineRegular, { size: 13 }),
		),
	});
}
