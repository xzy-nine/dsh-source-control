import React from 'react';
import {
	Button, Menu,
	IconChevronDownOutlineRegular, IconCloseOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';

/**
 * 提交排序选项，三档与 git 的 `--order` 参数一致。
 */
export const ORDERING = [
	{ value: 'topo', label: '拓扑', title: '按拓扑排序（同一分支的提交相邻）' },
	{ value: 'date', label: '时间', title: '按提交时间排序' },
	{ value: 'author-date', label: '作者时间', title: '按作者时间排序' },
];

/** 默认排序：拓扑序。 */
export const DEFAULT_ORDERING = 'topo';

/**
 * 提交排序下拉：按钮显示当前排序，点击展开三档选择。
 *
 * @param props.value - 当前排序值。
 * @param props.onChange - 选择回调。
 * @returns 下拉元素。
 */
export function OrderingMenu({ value, onChange }) {
	const [open, setOpen] = React.useState(false);
	const current = ORDERING.find((option) => option.value === value) ?? ORDERING[0];
	return React.createElement(Menu, {
		open,
		anchor: React.createElement(Button, {
			variant: 'toolbar', size: 'sm', title: current.title,
			onClick: () => setOpen((previous) => !previous),
		},
			current.label,
			React.createElement(IconChevronDownOutlineRegular, { size: 12 }),
		),
		items: ORDERING.map((option) => ({ id: option.value, label: option.label })),
		selectedId: value,
		selection: 'fill',
		onSelect: (id) => { onChange(id); setOpen(false); },
		onClose: () => setOpen(false),
	});
}

/**
 * 设置面板：浮层显示排序等配置。
 *
 * @param props.open - 是否展开。
 * @param props.onClose - 关闭回调。
 * @param props.commitOrdering - 当前排序值。
 * @param props.onCommitOrderingChange - 排序变更回调。
 * @returns 面板元素，未展开时返回 null。
 */
export function SettingsPanel({ open, onClose, commitOrdering, onCommitOrderingChange }) {
	if (!open) return null;
	return React.createElement(
		React.Fragment,
		null,
		React.createElement('div', { className: 'ggg-settings-backdrop', onClick: onClose }),
		React.createElement(
			'div',
			{ className: 'ggg-settings', role: 'dialog', 'aria-label': 'Git Graph 设置' },
			React.createElement('div', { className: 'ggg-settings-head' },
				'设置',
				React.createElement(Button, {
					variant: 'toolbar', size: 'sm', title: '关闭',
					onClick: onClose,
				}, React.createElement(IconCloseOutlineRegular, { size: 14 })),
			),
			React.createElement('div', { className: 'ggg-settings-row' },
				React.createElement('span', { className: 'ggg-settings-label' }, '提交排序'),
				React.createElement(OrderingMenu, {
					value: commitOrdering,
					onChange: onCommitOrderingChange,
				}),
			),
		),
	);
}
