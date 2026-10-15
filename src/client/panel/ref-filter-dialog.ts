/**
 * 引用筛选弹窗：搜索、快捷勾选、多选列表。
 */
import React from 'react';
import {
	Button, Checkbox,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { RemoteRefIcon, TagRefIcon } from '../ui/ref-icons.ts';
import { GitGraphIcon } from '../ui/plugin-icon.ts';
import type { RefItem } from '../shared/types.ts';
import css from '../css/ref-filter-dialog.module.css';
import { cx } from '../css/cx.ts';

/** 引用筛选弹窗的属性。 */
export interface RefFilterDialogProps {
	readonly refs: readonly RefItem[];
	readonly selected: ReadonlySet<string>;
	readonly search: string;
	readonly onSearch: (search: string) => void;
	readonly onToggle: (name: string) => void;
	readonly onSelectAll: (checked: boolean) => void;
	/** 「全部」的勾选态：由筛选模式给出，不按列表反推。 */
	readonly allChecked: boolean;
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
export function RefFilterDialog({ refs, selected, search, onSearch, onToggle, onSelectAll, allChecked, autoChecked, onToggleAuto, onClose }: RefFilterDialogProps): React.ReactElement {
	const filtered = refs.filter((ref) => search === '' || ref.name.includes(search) || ref.hash.includes(search));
	return React.createElement(
		'div',
		{ className: css.filterBackdrop, onClick: onClose },
		React.createElement(
			'div',
			{ className: css.filterDialog, onClick: (event: React.MouseEvent<HTMLDivElement>) => event.stopPropagation() },
			// 顶部：搜索框 + 已选徽章 + 确定按钮
			React.createElement(
				'div',
				{ className: css.filterTop },
				React.createElement('input', {
					type: 'text', className: css.filterSearch, placeholder: '搜索分支、标签…',
					value: search, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onSearch(event.currentTarget.value),
				}),
				React.createElement('span', { className: css.filterBadge }, `${selected.size}`),
				React.createElement(Button, { variant: 'primary', size: 'sm', onClick: onClose }, '确定'),
			),
			// 快捷选项
			React.createElement(
				'div',
				{ className: css.filterQuick },
				React.createElement('label', { className: css.filterQuickItem },
					React.createElement(Checkbox, { checked: allChecked, onChange: () => onSelectAll(!allChecked), label: '' }),
					React.createElement('span', { className: css.filterQuickLabel }, '全部'),
					React.createElement('span', { className: css.filterQuickHint }, '显示所有分支与标签'),
				),
				React.createElement('label', { className: css.filterQuickItem },
					React.createElement(Checkbox, { checked: autoChecked, onChange: onToggleAuto, label: '' }),
					React.createElement('span', { className: css.filterQuickLabel }, '自动'),
					React.createElement('span', { className: css.filterQuickHint }, '仅显示当前分支及向其合并的分支'),
				),
			),
			// 引用列表
			React.createElement(
				'div',
				{ className: css.filterList },
				...filtered.map((ref) => {
					const isChecked = selected.has(ref.name);
					return React.createElement(
						'label',
						{ key: `${ref.type}:${ref.name}`, className: cx(css.filterRow, isChecked && css.isChecked) },
						React.createElement(Checkbox, { checked: isChecked, onChange: () => onToggle(ref.name), label: '' }),
						ref.type === 'branch' && React.createElement(GitGraphIcon, { size: 14, className: css.filterIcon }),
						ref.type === 'remote' && React.createElement(RemoteRefIcon),
						ref.type === 'tag' && React.createElement(TagRefIcon),
						React.createElement('span', { className: css.filterName }, ref.name),
						React.createElement('span', { className: css.filterHash }, ref.hash.slice(0, 7)),
						React.createElement('span', { className: css.filterKind }, ref.kind),
					);
				}),
			),
		),
	);
}
