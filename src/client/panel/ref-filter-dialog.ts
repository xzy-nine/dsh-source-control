/**
 * 引用筛选弹窗：搜索、快捷勾选、多选列表。
 */
import React from 'react';
import {
	Button, Checkbox, IconBranchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { RemoteRefIcon, TagRefIcon } from '../ref-icons.ts';
import type { RefItem } from '../types.ts';

/** 引用筛选弹窗的属性。 */
export interface RefFilterDialogProps {
	readonly refs: readonly RefItem[];
	readonly selected: ReadonlySet<string>;
	readonly search: string;
	readonly onSearch: (search: string) => void;
	readonly onToggle: (name: string) => void;
	readonly onSelectAll: (checked: boolean) => void;
	readonly autoChecked: boolean;
	readonly onToggleAuto: (checked: boolean) => void;
	readonly onClose: () => void;
}

/**
 * 引用筛选弹窗：搜索、快捷勾选、多选列表。
 *
 * @param props - 见 {@link RefFilterDialogProps}。
 * @returns 弹窗元素。
 */
export function RefFilterDialog({ refs, selected, search, onSearch, onToggle, onSelectAll, autoChecked, onToggleAuto, onClose }: RefFilterDialogProps): React.ReactElement {
	const filtered = refs.filter((ref) => search === '' || ref.name.includes(search) || ref.hash.includes(search));
	const allChecked = refs.length > 0 && refs.every((ref) => selected.has(ref.name));
	return React.createElement(
		'div',
		{ className: 'ggg-filter-backdrop', onClick: onClose },
		React.createElement(
			'div',
			{ className: 'ggg-filter-dialog', onClick: (event: React.MouseEvent<HTMLDivElement>) => event.stopPropagation() },
			// 顶部：搜索框 + 已选徽章 + 确定按钮
			React.createElement(
				'div',
				{ className: 'ggg-filter-top' },
				React.createElement('input', {
					type: 'text', className: 'ggg-filter-search', placeholder: '搜索分支、标签…',
					value: search, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onSearch(event.currentTarget.value),
				}),
				React.createElement('span', { className: 'ggg-filter-badge' }, `${selected.size}`),
				React.createElement(Button, { variant: 'primary', size: 'sm', onClick: onClose }, '确定'),
			),
			// 快捷选项
			React.createElement(
				'div',
				{ className: 'ggg-filter-quick' },
				React.createElement('label', { className: 'ggg-filter-quick-item' },
					React.createElement(Checkbox, { checked: allChecked, onChange: () => onSelectAll(!allChecked), label: '' }),
					React.createElement('span', { className: 'ggg-filter-quick-label' }, '全部'),
					React.createElement('span', { className: 'ggg-filter-quick-hint' }, '显示所有分支与标签'),
				),
				React.createElement('label', { className: 'ggg-filter-quick-item' },
					React.createElement(Checkbox, { checked: autoChecked, onChange: onToggleAuto, label: '' }),
					React.createElement('span', { className: 'ggg-filter-quick-label' }, '自动'),
					React.createElement('span', { className: 'ggg-filter-quick-hint' }, '仅显示当前分支及向其合并的分支'),
				),
			),
			// 引用列表
			React.createElement(
				'div',
				{ className: 'ggg-filter-list' },
				...filtered.map((ref) => {
					const isChecked = selected.has(ref.name);
					return React.createElement(
						'label',
						{ key: `${ref.type}:${ref.name}`, className: `ggg-filter-row${isChecked ? ' is-checked' : ''}` },
						React.createElement(Checkbox, { checked: isChecked, onChange: () => onToggle(ref.name), label: '' }),
						ref.type === 'branch' && React.createElement(IconBranchOutlineRegular, { size: 14, className: 'ggg-filter-icon' }),
						ref.type === 'remote' && React.createElement(RemoteRefIcon),
						ref.type === 'tag' && React.createElement(TagRefIcon),
						React.createElement('span', { className: 'ggg-filter-name' }, ref.name),
						React.createElement('span', { className: 'ggg-filter-hash' }, ref.hash.slice(0, 7)),
						React.createElement('span', { className: 'ggg-filter-kind' }, ref.kind),
					);
				}),
			),
		),
	);
}
