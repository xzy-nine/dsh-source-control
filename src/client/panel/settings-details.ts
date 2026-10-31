/**
 * Issue 链接配置表单与用户身份表单。
 */
import React from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { showConfirmation } from '../ui/dialog.ts';
import type { IssueLinkingConfig } from '../shared/types.ts';
import { ToggleRow } from './settings-rows.ts';
import type { SettingsTab, UserDetails } from './settings-types.ts';
import css from '../css/settings.module.css';
import { cx } from '../css/cx.ts';

/**
 * Issue 链接配置表单。
 *
 * @param props.config - 当前配置。
 * @param props.onChange - 变更回调。
 * @returns 表单元素。
 */
export function IssueLinkingForm({ config, onChange }: {
	config: IssueLinkingConfig | null;
	onChange: (config: IssueLinkingConfig) => void;
}): React.ReactElement {
	const regex = config?.issueRegex ?? '';
	const url = config?.issueUrlTemplate ?? '';
	return React.createElement(
		'div',
		{ className: css.setForm },
		React.createElement('label', { className: css.setRowBlock },
			React.createElement('span', { className: css.setRowText }, 'Issue 正则'),
			React.createElement(Input, {
				value: regex,
				placeholder: '如 #(\\d+)',
				onChange: (event: React.ChangeEvent<HTMLInputElement>) => { onChange({ issueRegex: event.target.value, issueUrlTemplate: url }); },
			}),
		),
		React.createElement('label', { className: css.setRowBlock },
			React.createElement('span', { className: css.setRowText }, 'Issue 链接模板'),
			React.createElement(Input, {
				value: url,
				placeholder: '如 https://github.com/owner/repo/issues/%ID%',
				onChange: (event: React.ChangeEvent<HTMLInputElement>) => { onChange({ issueRegex: regex, issueUrlTemplate: event.target.value }); },
			}),
		),
		React.createElement('div', { className: css.setNote }, '该配置仅在前端保存，用于识别提交信息中的 Issue 编号。'),
	);
}

/**
 * 用户身份表单：编辑 user.name 与 user.email。
 *
 * @param props.userDetails - 当前身份配置。
 * @param props.onEdit - 保存回调。
 * @param props.onDelete - 删除回调。
 * @returns 表单元素。
 */
export function UserDetailsForm({ userDetails, onEdit, onDelete, scope }: {
	userDetails: UserDetails | null;
	onEdit: (name: string, email: string, location: string, deleteLocalName: boolean, deleteLocalEmail: boolean) => void;
	onDelete: (delName: boolean, delEmail: boolean, location: string) => void;
	/** 表单所在页签：仓库级表单可退化为「跟随全局」，全局表单始终编辑全局值。 */
	scope: SettingsTab;
}): React.ReactElement {
	const globalName = userDetails?.userName?.global ?? null;
	const globalEmail = userDetails?.userEmail?.global ?? null;
	const localName = userDetails?.userName?.local ?? null;
	const localEmail = userDetails?.userEmail?.local ?? null;
	const [name, setName] = React.useState('');
	const [email, setEmail] = React.useState('');
	// 仓库表单默认「跟随全局」：本地未配置时不写本地、直接用全局值。
	const [useGlobal, setUseGlobal] = React.useState(scope === 'repo' && localName === null && localEmail === null);
	const currentName = userDetails?.userName;
	const currentEmail = userDetails?.userEmail;
	/**
	 * 该页签要编辑的值。
	 *
	 * 全局页签只取全局值——取「本地优先」会把仓库级覆盖误写进全局配置；仓库页签取
	 * 「本地优先」，与仓库实际生效的身份一致。
	 */
	const valueOf = (entry: { local?: string | null; global?: string | null } | null | undefined): string =>
		scope === 'global' ? (entry?.global ?? '') : (entry?.local ?? entry?.global ?? '');
	// 表单载入时的值：未编辑过就不写回配置。
	const initial = { name: valueOf(currentName), email: valueOf(currentEmail) };
	React.useEffect(() => {
		setName(valueOf(currentName));
		setEmail(valueOf(currentEmail));
	}, [currentName, currentEmail]);
	const hasLocal = localName !== null || localEmail !== null;
	// 仓库级值与全局不同：切换开关会清掉覆盖并改变生效身份，需先确认。
	const differsFromGlobal = (localName !== null && localName !== globalName)
		|| (localEmail !== null && localEmail !== globalEmail);
	// 仓库表单开启「使用全局身份」时隐藏输入框，只展示当前生效的全局值。
	const inheriting = scope === 'repo' && useGlobal;
	/** 清除仓库级覆盖，改用全局身份。 */
	const clearLocalCover = (): void => {
		setUseGlobal(true);
		setName(globalName ?? '');
		setEmail(globalEmail ?? '');
		onDelete(localName !== null, localEmail !== null, 'local');
	};
	/** 切换「使用全局身份」。会改变生效身份时先说明仓库级配置将被清除。 */
	const toggleUseGlobal = (next: boolean): void => {
		if (!next) { setUseGlobal(false); return; }
		if (!hasLocal) { setUseGlobal(true); return; }
		// 本地值与全局相同时清除覆盖不改变生效值，无需确认。
		if (!differsFromGlobal) { clearLocalCover(); return; }
		void showConfirmation({
			title: '使用全局身份',
			message: `当前仓库配置了 ${[localName, localEmail].filter((value) => value !== null).join(' / ')}，`
				+ '改用全局身份会清除这些仓库级配置。\n需要现在清除吗？',
			confirmLabel: '清除并使用全局', danger: true,
		}).then((ok) => { if (ok) clearLocalCover(); });
	};
	const save = (): void => {
		// 仓库级「跟随全局」时输入框不可见，没有可保存的内容。
		if (inheriting) return;
		// 未编辑则不写入：避免无改动时也覆盖配置。
		if (name === initial.name && email === initial.email) return;
		// 各页签只写自己那一级：清除仓库级覆盖由仓库页签的开关负责，这里不代劳。
		onEdit(name, email, scope, false, false);
	};
	const remove = (): void => {
		onDelete(true, true, scope);
		setName('');
		setEmail('');
	};
	return React.createElement(
		'div',
		{ className: css.setForm },
		scope === 'repo' && React.createElement(ToggleRow, {
			label: '使用全局身份',
			checked: useGlobal,
			onChange: toggleUseGlobal,
		}),
		// 使用全局身份时不显示输入框；当前值由下方的配置说明给出，不重复列出。
		inheriting
			? (globalName === null && globalEmail === null
				? React.createElement('div', { className: css.setNote }, '未配置全局身份，请在「全局设置」中配置。')
				: null)
			: [
				React.createElement('label', { className: css.setRowBlock, key: 'name' },
					React.createElement('span', { className: css.setRowText }, '用户名'),
					React.createElement(Input, {
						value: name,
						placeholder: 'git user.name',
						onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setName(event.target.value); },
					}),
				),
				React.createElement('label', { className: css.setRowBlock, key: 'email' },
					React.createElement('span', { className: css.setRowText }, '邮箱'),
					React.createElement(Input, {
						value: email,
						placeholder: 'git user.email',
						onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setEmail(event.target.value); },
					}),
				),
				React.createElement('div', { className: cx(css.setRow, css.setRowInline), key: 'actions' },
					React.createElement(Button, { variant: 'primary', size: 'sm', onClick: save }, '保存'),
					React.createElement(Button, { variant: 'outline', size: 'sm', onClick: remove }, '删除'),
				),
			],
		localName !== null
			&& React.createElement('div', { className: css.setNote }, `仓库级覆盖：${localName} <${localEmail ?? '?'}>`),
		globalName !== null
			&& React.createElement('div', { className: css.setNote }, `全局配置：${globalName} <${globalEmail ?? '?'}>`),
	);
}