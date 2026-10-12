/**
 * Git Graph 设置：分区配置、本地持久化与日期格式化。
 *
 * 设置分区对齐 mhutchie/vscode-git-graph 的默认布局；User Details、
 * Pull Request Creation 等依赖 VS Code 的条目在 DSH 版本中弱化展示。
 */
import React from 'react';
import {
	Button, Checkbox, Input, SegmentedControl,
	IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** 用户身份配置位置选项。 */
const CONFIG_LOCATION = [
	{ value: 'global', label: '全局', title: '写入 ~/.gitconfig' },
	{ value: 'local', label: '仓库', title: '写入当前仓库 .git/config' },
];

/** localStorage 键。 */
export const SETTINGS_KEY = 'dsh-git-graph-settings';

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

/** 日期格式选项：类型与是否使用 ISO。值用字符串，适配 SegmentedControl 的取值约定。 */
export const DATE_FORMAT_TYPE = [
	{ value: '0', label: '日期和时间', title: '显示完整日期与时间' },
	{ value: '1', label: '相对', title: '显示相对时间（如「3 天前」）' },
	{ value: '2', label: '绝对', title: '显示绝对日期' },
];

/**
 * 默认设置，取值与 createDefaultViewConfig 对齐。
 *
 * @returns 设置对象。
 */
export function defaultSettings() {
	return {
		commitOrdering: 'date',
		dateFormat: { type: 0, iso: false },
		showStashes: true,
		showTags: true,
		showRemoteBranches: true,
		onlyFollowFirstParent: false,
		includeCommitsMentionedByReflogs: false,
		issueLinkingConfig: null,
	};
}

/**
 * 从 localStorage 读取设置，缺项以默认补齐。
 *
 * @returns 设置对象。
 */
export function loadSettings() {
	const base = defaultSettings();
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return base;
		const parsed = JSON.parse(raw);
		return {
			...base,
			...parsed,
			dateFormat: { ...base.dateFormat, ...(parsed.dateFormat ?? {}) },
			issueLinkingConfig: parsed.issueLinkingConfig ?? null,
		};
	} catch {
		return base;
	}
}

/**
 * 把设置写入 localStorage。
 *
 * @param {object} settings - 设置对象。
 * @returns 无。
 */
export function saveSettings(settings) {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		/* 持久化失败时静默回退到内存态 */
	}
}

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
	return React.createElement(SegmentedControl, {
		value: current.value,
		onChange,
		options: ORDERING.map((option) => ({ value: option.value, label: option.label, title: option.title })),
	});
}

/**
 * 把时间戳格式化为提交行展示文本。
 *
 * @param {number} unixSeconds - 提交时间（秒）。
 * @param {object} dateFormat - { type, iso }。
 * @returns 格式化文本。
 */
export function formatDate(unixSeconds, dateFormat) {
	const date = new Date(unixSeconds * 1000);
	const type = dateFormat?.type ?? 0;
	if (type === 1) {
		const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
		if (diff < 60) return '刚刚';
		if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
		if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
		if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
		if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} 个月前`;
		return `${Math.floor(diff / (86400 * 365))} 年前`;
	}
	let text;
	if (dateFormat?.iso === true) {
		text = date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
	} else {
		const pad = (n) => String(n).padStart(2, '0');
		const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
		if (type === 2) {
			text = ymd;
		} else {
			text = `${ymd} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}
	}
	return text;
}

/**
 * 一个分区标题。
 *
 * @param props.title - 标题。
 * @returns 分区元素。
 */
function Section({ title, children }) {
	return React.createElement(
		'div',
		{ className: 'ggg-set-section' },
		React.createElement('div', { className: 'ggg-set-section-title' }, title),
		children,
	);
}

/**
 * 一个开关行。
 *
 * @param props.label - 文案。
 * @param props.checked - 状态。
 * @param props.onChange - 变更回调。
 * @returns 行元素。
 */
function ToggleRow({ label, checked, onChange }) {
	return React.createElement(
		'label',
		{ className: 'ggg-set-row ggg-set-row-inline' },
		React.createElement(Checkbox, { checked, onChange: (next) => onChange(next) }),
		React.createElement('span', { className: 'ggg-set-row-text' }, label),
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
function SelectRow({ label, options, value, onChange }) {
	return React.createElement(
		'div',
		{ className: 'ggg-set-row' },
		React.createElement('span', { className: 'ggg-set-row-text' }, label),
		React.createElement(SegmentedControl, { value, onChange, options }),
	);
}

/**
 * 设置面板：浮层显示全部分区。
 *
 * @param props.open - 是否展开。
 * @param props.onClose - 关闭回调。
 * @param props.settings - 当前设置。
 * @param props.onChange - 设置变更回调（传回整个设置对象）。
 * @param props.remotes - 远端列表。
 * @param props.onDeleteRemote - 删除远端回调。
 * @returns 面板元素，未展开时返回 null。
 */
export function SettingsPanel({ open, onClose, settings, onChange, remotes, onDeleteRemote, userDetails, onEditUserDetails, onDeleteUserDetails }) {
	if (!open) return null;
	const patch = (partial) => onChange({ ...settings, ...partial });
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
			React.createElement('div', { className: 'ggg-settings-body' },
				React.createElement(Section, { title: 'General' },
					React.createElement(SelectRow, {
						label: '提交排序',
						options: ORDERING.map((option) => ({ value: option.value, label: option.label, title: option.title })),
						value: settings.commitOrdering,
						onChange: (value) => patch({ commitOrdering: value }),
					}),
					React.createElement(SelectRow, {
						label: '日期格式',
						options: DATE_FORMAT_TYPE,
						value: String(settings.dateFormat.type),
						onChange: (type) => patch({ dateFormat: { ...settings.dateFormat, type: Number(type) } }),
					}),
					React.createElement(ToggleRow, {
						label: '使用 ISO 日期格式',
						checked: settings.dateFormat.iso,
						onChange: (iso) => patch({ dateFormat: { ...settings.dateFormat, iso } }),
					}),
					React.createElement(ToggleRow, {
						label: '显示贮藏',
						checked: settings.showStashes,
						onChange: (showStashes) => patch({ showStashes }),
					}),
					React.createElement(ToggleRow, {
						label: '显示标签',
						checked: settings.showTags,
						onChange: (showTags) => patch({ showTags }),
					}),
					React.createElement(ToggleRow, {
						label: '显示远程分支',
						checked: settings.showRemoteBranches,
						onChange: (showRemoteBranches) => patch({ showRemoteBranches }),
					}),
					React.createElement(ToggleRow, {
						label: '只跟随第一个父提交',
						checked: settings.onlyFollowFirstParent,
						onChange: (onlyFollowFirstParent) => patch({ onlyFollowFirstParent }),
					}),
					React.createElement(ToggleRow, {
						label: '包含 reflog 提到的提交',
						checked: settings.includeCommitsMentionedByReflogs,
						onChange: (includeCommitsMentionedByReflogs) => patch({ includeCommitsMentionedByReflogs }),
					}),
				),
				React.createElement(Section, { title: 'User Details' },
					React.createElement(UserDetailsForm, {
						userDetails,
						onEdit: onEditUserDetails,
						onDelete: onDeleteUserDetails,
					}),
				),
				React.createElement(Section, { title: 'Remote Configuration' },
					remotes !== undefined && remotes.length > 0
						? React.createElement('div', { className: 'ggg-set-remotes' },
							...remotes.map((remote) => React.createElement(
								'div',
								{ key: remote.name, className: 'ggg-set-remote' },
								React.createElement('span', { className: 'ggg-set-remote-name' }, remote.name),
								React.createElement('span', { className: 'ggg-set-remote-url' }, remote.url ?? ''),
								React.createElement('button', {
									type: 'button', className: 'ggg-set-remote-del', title: '删除远程',
									onClick: () => onDeleteRemote?.(remote.name),
								}, React.createElement(IconTrashOutlineRegular, { size: 13 })),
							)),
						)
						: React.createElement('div', { className: 'ggg-set-note' }, '没有配置远程仓库'),
				),
				React.createElement(Section, { title: 'Issue Linking' },
					React.createElement(IssueLinkingForm, {
						config: settings.issueLinkingConfig,
						onChange: (issueLinkingConfig) => patch({ issueLinkingConfig }),
					}),
				),
				React.createElement(Section, { title: 'Pull Request Creation' },
					React.createElement('div', { className: 'ggg-set-note' },
						'创建 Pull Request 依赖 GitHub 等宿主集成；DSH 版本暂不支持，请在相应平台上创建。'),
				),
			),
		),
	);
}

/**
 * Issue 链接配置表单。
 *
 * @param props.config - 当前配置 { issueRegex, issueUrlTemplate }。
 * @param props.onChange - 变更回调。
 * @returns 表单元素。
 */
function IssueLinkingForm({ config, onChange }) {
	const regex = config?.issueRegex ?? '';
	const url = config?.issueUrlTemplate ?? '';
	return React.createElement(
		'div',
		{ className: 'ggg-set-form' },
		React.createElement('label', { className: 'ggg-set-row-block' },
			React.createElement('span', { className: 'ggg-set-row-text' }, 'Issue 正则'),
			React.createElement(Input, {
				value: regex,
				placeholder: '如 #(\\d+)',
				onChange: (event) => onChange({ issueRegex: event.target.value, issueUrlTemplate: url }),
			}),
		),
		React.createElement('label', { className: 'ggg-set-row-block' },
			React.createElement('span', { className: 'ggg-set-row-text' }, 'Issue 链接模板'),
			React.createElement(Input, {
				value: url,
				placeholder: '如 https://github.com/owner/repo/issues/%ID%',
				onChange: (event) => onChange({ issueRegex: regex, issueUrlTemplate: event.target.value }),
			}),
		),
		React.createElement('div', { className: 'ggg-set-note' }, '该配置仅在前端保存，用于识别提交信息中的 Issue 编号。'),
	);
}

/**
 * 用户身份表单：编辑 user.name 与 user.email。
 *
 * @param props.userDetails - { userName: {local, global}, userEmail: {local, global} }。
 * @param props.onEdit - 保存回调 (name, email, location, deleteLocalName, deleteLocalEmail) => void。
 * @param props.onDelete - 删除回调 (name, email, location) => void。
 * @returns 表单元素。
 */
function UserDetailsForm({ userDetails, onEdit, onDelete }) {
	const [name, setName] = React.useState('');
	const [email, setEmail] = React.useState('');
	const [location, setLocation] = React.useState('global');
	const currentName = userDetails?.userName;
	const currentEmail = userDetails?.userEmail;
	React.useEffect(() => {
		if (currentName !== undefined) {
			setName(currentName.local ?? currentName.global ?? '');
		}
		if (currentEmail !== undefined) {
			setEmail(currentEmail.local ?? currentEmail.global ?? '');
		}
	}, [currentName, currentEmail]);
	const save = () => {
		const deleteLocalName = (currentName?.local ?? null) !== null && location === 'global';
		const deleteLocalEmail = (currentEmail?.local ?? null) !== null && location === 'global';
		onEdit?.(name, email, location, deleteLocalName, deleteLocalEmail);
	};
	const remove = () => {
		onDelete?.(true, true, location);
		setName('');
		setEmail('');
	};
	return React.createElement(
		'div',
		{ className: 'ggg-set-form' },
		React.createElement('label', { className: 'ggg-set-row-block' },
			React.createElement('span', { className: 'ggg-set-row-text' }, '用户名'),
			React.createElement(Input, {
				value: name,
				placeholder: 'git user.name',
				onChange: (event) => setName(event.target.value),
			}),
		),
		React.createElement('label', { className: 'ggg-set-row-block' },
			React.createElement('span', { className: 'ggg-set-row-text' }, '邮箱'),
			React.createElement(Input, {
				value: email,
				placeholder: 'git user.email',
				onChange: (event) => setEmail(event.target.value),
			}),
		),
		React.createElement(SelectRow, {
			label: '写入位置',
			options: CONFIG_LOCATION,
			value: location,
			onChange: setLocation,
		}),
		React.createElement('div', { className: 'ggg-set-row ggg-set-row-inline' },
			React.createElement(Button, { variant: 'primary', size: 'sm', onClick: save }, '保存'),
			React.createElement(Button, { variant: 'outline', size: 'sm', onClick: remove }, '删除'),
		),
		currentName?.local !== undefined && currentName?.local !== null
			&& React.createElement('div', { className: 'ggg-set-note' }, `仓库级覆盖：${currentName.local} <${currentEmail?.local ?? '?'}>`),
		currentName?.global !== undefined && currentName?.global !== null
			&& React.createElement('div', { className: 'ggg-set-note' }, `全局配置：${currentName.global} <${currentEmail?.global ?? '?'}>`),
	);
}
