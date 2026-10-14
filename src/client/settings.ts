/**
 * 源代码管理设置：分区配置、本地持久化与日期格式化。
 *
 * 全局分区覆盖提交图、引用标签与日期格式；仓库分区覆盖用户身份、远程仓库、
 * Pull Request Creation、Issue Linking 与仓库配置导出。
 */
import React from 'react';
import {
	Button, Checkbox, Input, SegmentedControl, SegmentedTabs,
	IconEditOutlineRegular, IconCloseOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { Dropdown } from './ui/dropdown.ts';
import { fetchAiModels } from './api.ts';
import { showConfirmation, showMessage } from './dialog.ts';
import { remoteHostOf, remoteProtocolSlot, toHttpsRemoteUrl, toSshRemoteUrl } from './remote-url.ts';
import type { RemoteProtocolSlot } from './remote-url.ts';
import type { AiModelCatalog, SshStatusInfo } from './api.ts';
import type { DateFormat, IssueLinkingConfig, Remote, Settings } from './types.ts';

/** 用户身份配置位置选项。 */
/** localStorage 键。 */
export const SETTINGS_KEY = 'dsh-source-control-settings';

/** 提交排序选项，三档与 git 的 `--order` 参数一致。 */
export const ORDERING = [
	{ value: 'topo', label: '拓扑', title: '按拓扑排序（同一分支的提交相邻）' },
	{ value: 'date', label: '时间', title: '按提交时间排序' },
	{ value: 'author-date', label: '作者时间', title: '按作者时间排序' },
];

/** 日期格式选项：类型与是否使用 ISO。值用字符串，适配 SegmentedControl 的取值约定。 */
export const DATE_FORMAT_TYPE = [
	{ value: '0', label: '日期和时间', title: '显示完整日期与时间' },
	{ value: '1', label: '相对', title: '显示相对时间（如「3 天前」）' },
	{ value: '2', label: '绝对', title: '显示绝对日期' },
];

/** 远程地址协议档位选项：HTTP(S) 与 git:// 归入 HTTPS 档，其余为 SSH 档。 */
export const REMOTE_PROTOCOLS = [
	{ value: 'https', label: 'HTTPS', title: '以 HTTP(S) 形式访问远程' },
	{ value: 'ssh', label: 'SSH', title: '以 SSH 形式访问远程' },
];

/**
 * 默认设置，取值与 createDefaultViewConfig 对齐。
 *
 * @returns 设置对象。
 */
export function defaultSettings(): Settings {
	return {
		commitOrdering: 'date',
		dateFormat: { type: 0, iso: false },
		showStashes: true,
		showTags: true,
		showRemoteBranches: true,
		onlyFollowFirstParent: false,
		includeCommitsMentionedByReflogs: false,
		issueLinkingConfig: null,
		markdown: true,
		muteMergeCommits: false,
		combineLocalAndRemoteBranchLabels: true,
		fetchAndPrune: false,
		fetchAndPruneTags: false,
		onRepoLoadScrollToHead: false,
		showAvatars: true,
		graphColours: null,
		aiCommitProvider: '',
		aiCommitModel: '',
		aiCommitRules: '',
	};
}

/**
 * 从 localStorage 读取设置，缺项以默认补齐。
 *
 * @returns 设置对象。
 */
export function loadSettings(): Settings {
	const base = defaultSettings();
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return base;
		const parsed = JSON.parse(raw) as Partial<Settings>;
		return {
			...base,
			...parsed,
			dateFormat: { ...base.dateFormat, ...(parsed.dateFormat ?? {}) },
			issueLinkingConfig: parsed.issueLinkingConfig ?? null,
			graphColours: Array.isArray(parsed.graphColours) ? parsed.graphColours : null,
		};
	} catch {
		return base;
	}
}

/**
 * 把设置写入 localStorage。
 *
 * @param settings - 设置对象。
 * @returns 无。
 */
export function saveSettings(settings: Settings): void {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		/* 持久化失败时静默回退到内存态 */
	}
}

/**
 * 把时间戳格式化为提交行展示文本。
 *
 * @param unixSeconds - 提交时间（秒）。
 * @param dateFormat - 日期格式设置。
 * @returns 格式化文本。
 */
export function formatDate(unixSeconds: number, dateFormat: DateFormat): string {
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
	let text: string;
	if (dateFormat?.iso === true) {
		text = date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
	} else {
		const pad = (n: number): string => String(n).padStart(2, '0');
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
function Section({ title, children }: { title: string; children?: React.ReactNode }): React.ReactElement {
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
 * Checkbox 自身携带文案且根元素是 `<label>`，因此这里用 `div` 作行容器、不再另加文案节点：
 * 再套一层 `<label>` 会形成嵌套，重复显示文案并让点击行为异常。
 *
 * @param props.label - 文案。
 * @param props.checked - 状态。
 * @param props.onChange - 变更回调。
 * @returns 行元素。
 */
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }): React.ReactElement {
	return React.createElement(
		'div',
		{ className: 'ggg-set-row ggg-set-row-inline' },
		React.createElement(Checkbox, { checked, onChange, label }),
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
function SelectRow({ label, options, value, onChange }: {
	label: string;
	options: ReadonlyArray<{ value: string; label: string; title?: string }>;
	value: string;
	onChange: (next: string) => void;
}): React.ReactElement {
	return React.createElement(
		'div',
		{ className: 'ggg-set-row' },
		React.createElement('span', { className: 'ggg-set-row-text' }, label),
		React.createElement(SegmentedControl, { id: `ggg-set-${label}`, label, value, onChange, options }),
	);
}

/**
 * 下拉选择行：行内标签 + 共享下拉控件。
 *
 * @param props.label - 行标签。
 * @param props.options - 选项。
 * @param props.value - 当前值。
 * @param props.onChange - 变更回调。
 * @returns 行元素。
 */
function DropdownRow({ label, options, value, onChange }: {
	label: string;
	options: ReadonlyArray<{ value: string; label: string }>;
	value: string;
	onChange: (next: string) => void;
}): React.ReactElement {
	return React.createElement(
		'div',
		{ className: 'ggg-set-row' },
		React.createElement('span', { className: 'ggg-set-label' }, label),
		React.createElement(Dropdown, { options, value, onChange }),
	);
}

/**
 * AI 提交信息生成的模型配置区。
 *
 * @param props.provider - 当前保存的供应商 id（空串 = 未配置）。
 * @param props.model - 当前保存的模型 id。
 * @param props.rules - 自定义规则提示词。
 * @param props.onChange - 供应商与模型变更回调。
 * @param props.onRulesChange - 规则变更回调。
 * @returns 区元素。
 */
function AiModelConfigSection({ provider, model, rules, onChange, onRulesChange }: {
	provider: string;
	model: string;
	rules: string;
	onChange: (provider: string, model: string) => void;
	onRulesChange: (rules: string) => void;
}): React.ReactElement {
	const [catalog, setCatalog] = React.useState<AiModelCatalog | null>(null);
	React.useEffect(() => {
		let cancelled = false;
		fetchAiModels().then((data) => { if (!cancelled) setCatalog(data); }).catch(() => { if (!cancelled) setCatalog(null); });
		return () => { cancelled = true; };
	}, []);
	const providers = catalog?.providers ?? [];
	const modelsByProvider = catalog?.modelsByProvider ?? {};
	const fallback = catalog?.fallback ?? null;
	const models = modelsByProvider[provider] ?? [];
	return React.createElement(
		'div',
		{ className: 'ggg-set-ai-model' },
		provider === '' && fallback !== null
			? React.createElement('div', { className: 'ggg-set-note' }, '未配置专用模型，将使用当前会话模型（', fallback.provider, '/', fallback.model, '）。')
			: provider === ''
				? React.createElement('div', { className: 'ggg-set-note' }, '未配置专用模型，且无法获取当前会话模型。')
				: null,
		React.createElement(DropdownRow, {
			label: '供应商',
			value: provider,
			options: [
				{ value: '', label: '（使用当前会话模型）' },
				...providers.map((p) => ({ value: p.id, label: p.name || p.id })),
			],
			onChange: (next: string) => onChange(next, ''),
		}),
		provider !== '' && React.createElement(DropdownRow, {
			label: '模型',
			value: model,
			options: models.map((m) => ({ value: m, label: m })),
			onChange: (next: string) => onChange(provider, next),
		}),
		React.createElement('div', { className: 'ggg-set-row' },
			React.createElement('label', { className: 'ggg-set-label' }, '规则'),
			React.createElement('textarea', {
				className: 'ggg-set-textarea',
				value: rules,
				placeholder: '自定义规则提示词，追加到系统提示词末尾。例如：使用中文；提交信息不超过 50 字符。',
				onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => onRulesChange(e.currentTarget.value),
				rows: 3,
			}),
		),
	);
}

/** 用户身份（本地与全局）。 */
export interface UserDetails {
	readonly userName?: { local?: string | null; global?: string | null } | null;
	readonly userEmail?: { local?: string | null; global?: string | null } | null;
}

/** 设置页签：作用范围。 */
export type SettingsTab = 'repo' | 'global';

/** 设置面板属性。 */
export interface SettingsPanelProps {
	readonly open: boolean;
	readonly onClose: () => void;
	readonly settings: Settings;
	readonly onChange: (next: Settings) => void;
	readonly remotes: readonly Remote[];
	readonly onDeleteRemote: (name: string) => void;
	readonly onAddRemote?: (name: string, url: string, pushUrl: string | null) => void;
	readonly onEditRemote?: (nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) => void;
	/** 读取本地 SSH 状态；refresh 为 true 时忽略宿主缓存，返回 null 表示检测失败。 */
	readonly onCheckSsh?: (host: string, refresh?: boolean) => Promise<SshStatusInfo | null>;
	readonly onExportConfig?: () => void;
	readonly userDetails: UserDetails | null;
	readonly onEditUserDetails: (name: string, email: string, location: string, deleteLocalName: boolean, deleteLocalEmail: boolean) => void;
	readonly onDeleteUserDetails: (delName: boolean, delEmail: boolean, location: string) => void;
}

/**
 * 源代码管理设置面板。
 *
 * 分「仓库设置」与「全局设置」两个页签：前者作用于当前仓库（身份、远程、导出），后者作用于
 * 界面与生成行为。用户身份在两侧都显示——它既可写入单个仓库，也可写入全局配置。
 *
 * @param props - 见 {@link SettingsPanelProps}。
 * @returns 面板元素，未展开时返回 null。
 */
export function SettingsPanel({
	open, onClose, settings, onChange, remotes, onDeleteRemote, onAddRemote, onEditRemote, onExportConfig, onCheckSsh,
	userDetails, onEditUserDetails, onDeleteUserDetails,
}: SettingsPanelProps): React.ReactElement | null {
	const [tab, setTab] = React.useState<SettingsTab>('repo');
	if (!open) return null;
	const patch = (partial: Partial<Settings>): void => onChange({ ...settings, ...partial });
	const userSection = (scope: SettingsTab): React.ReactElement => React.createElement(Section, { title: 'User Details' },
		React.createElement(UserDetailsForm, {
			userDetails,
			onEdit: onEditUserDetails,
			onDelete: onDeleteUserDetails,
			scope,
		}),
	);
	const generalSections = [
		React.createElement(Section, { title: 'General', key: 'general' },
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
			React.createElement(ToggleRow, {
				label: 'Markdown 渲染提交信息',
				checked: settings.markdown,
				onChange: (markdown) => patch({ markdown }),
			}),
			React.createElement(ToggleRow, {
				label: '显示作者头像',
				checked: settings.showAvatars,
				onChange: (showAvatars) => patch({ showAvatars }),
			}),
			React.createElement(ToggleRow, {
				label: '静音合并提交',
				checked: settings.muteMergeCommits,
				onChange: (muteMergeCommits) => patch({ muteMergeCommits }),
			}),
			React.createElement(ToggleRow, {
				label: '合并本地与远程分支标签',
				checked: settings.combineLocalAndRemoteBranchLabels,
				onChange: (combineLocalAndRemoteBranchLabels) => patch({ combineLocalAndRemoteBranchLabels }),
			}),
			React.createElement(ToggleRow, {
				label: '抓取时修剪已删除远程分支',
				checked: settings.fetchAndPrune,
				onChange: (fetchAndPrune) => patch({ fetchAndPrune }),
			}),
			React.createElement(ToggleRow, {
				label: '抓取时修剪远程标签',
				checked: settings.fetchAndPruneTags,
				onChange: (fetchAndPruneTags) => patch({ fetchAndPruneTags }),
			}),
			React.createElement(ToggleRow, {
				label: '加载仓库后滚动到 HEAD',
				checked: settings.onRepoLoadScrollToHead,
				onChange: (onRepoLoadScrollToHead) => patch({ onRepoLoadScrollToHead }),
			}),
		),
		React.createElement(Section, { title: 'Issue Linking', key: 'issue' },
			React.createElement(IssueLinkingForm, {
				config: settings.issueLinkingConfig,
				onChange: (issueLinkingConfig) => patch({ issueLinkingConfig }),
			}),
		),
		React.createElement(Section, { title: 'AI 提交信息', key: 'ai' },
			React.createElement(AiModelConfigSection, {
				provider: settings.aiCommitProvider,
				model: settings.aiCommitModel,
				rules: settings.aiCommitRules,
				onChange: (aiCommitProvider, aiCommitModel) => patch({ aiCommitProvider, aiCommitModel }),
				onRulesChange: (aiCommitRules) => patch({ aiCommitRules }),
			}),
		),
	];
	const repoSections = [
		userSection('repo'),
		React.createElement(Section, { title: 'Remote Configuration', key: 'remote' },
			React.createElement(RemoteConfigSection, {
				remotes,
				onDeleteRemote,
				onAddRemote,
				onEditRemote,
				onCheckSsh,
			}),
		),
		React.createElement(Section, { title: 'Pull Request Creation', key: 'pr' },
			React.createElement('div', { className: 'ggg-set-note' },
				'创建 Pull Request 通过 gh CLI 完成：在当前分支的提交右键菜单或分支引用右键菜单选择'
				+ '「创建 Pull Request…」，填写目标分支、标题与正文，可创建为草稿。'
				+ '需要本机已登录 gh，且当前分支已推送到 GitHub 远程；授权缺少所需 scope 时提示补授权命令。'),
		),
		React.createElement(Section, { title: '仓库配置', key: 'export' },
			React.createElement(Button, {
				variant: 'outline', size: 'sm',
				onClick: () => { void onExportConfig?.(); },
			}, '导出仓库配置'),
		),
	];
	return React.createElement(
		React.Fragment,
		null,
		React.createElement('div', { className: 'ggg-settings-backdrop', onClick: onClose }),
		React.createElement(
			'div',
			{ className: 'ggg-settings', role: 'dialog', 'aria-label': '源代码管理设置' },
			React.createElement('div', { className: 'ggg-settings-head' },
				'设置',
				React.createElement(Button, {
					variant: 'toolbar', size: 'sm', title: '关闭',
					onClick: onClose,
				}, React.createElement(IconCloseOutlineRegular, { size: 14 })),
			),
			React.createElement(SegmentedTabs, {
				label: '设置范围',
				value: tab,
				onChange: (value: SettingsTab) => setTab(value),
				items: [
					{ value: 'repo', label: '仓库设置', id: 'ggg-set-tab-repo', panelId: 'ggg-set-panel-repo' },
					{ value: 'global', label: '全局设置', id: 'ggg-set-tab-global', panelId: 'ggg-set-panel-global' },
				],
			}),
			React.createElement('div', {
				className: 'ggg-settings-body',
				id: tab === 'repo' ? 'ggg-set-panel-repo' : 'ggg-set-panel-global',
				role: 'tabpanel',
				'aria-labelledby': tab === 'repo' ? 'ggg-set-tab-repo' : 'ggg-set-tab-global',
			},
				...(tab === 'repo'
					? repoSections
					: [userSection('global'), ...generalSections]),
			),
		),
	);
}

/**
 * SSH 状态的一行说明。
 *
 * @param status - 检测结果。
 * @returns 说明文本。
 */
function sshStatusText(status: SshStatusInfo): string {
	if (!status.installed) return 'SSH：未找到 ssh 客户端';
	const keys = status.keys.length > 0 ? `私钥 ${status.keys.join('、')}` : '未发现 ~/.ssh 私钥';
	return `SSH：${status.host} ${status.authenticated ? '已认证' : '未认证'}（${status.version ?? 'ssh'}；${keys}）`;
}

/**
 * 远程仓库配置区：列出已有远程（含编辑与删除）与添加 / 编辑表单。
 *
 * 协议切换只在表单内进行：表单的协议分段控件换算输入框内容，保存后写入仓库配置。
 * 切到 SSH 前先检测本地 SSH 状态（客户端、私钥与目标主机认证），未就绪时说明原因且不改写配置；
 * 切回 HTTPS 不依赖本地 SSH。
 *
 * @param props.remotes - 远程列表。
 * @param props.onDeleteRemote - 删除远程回调。
 * @param props.onAddRemote - 添加远程回调。
 * @param props.onEditRemote - 编辑远程回调。
 * @param props.onCheckSsh - 本地 SSH 状态检测回调。
 * @returns 区元素。
 */
function RemoteConfigSection({ remotes, onDeleteRemote, onAddRemote, onEditRemote, onCheckSsh }: {
	remotes: readonly Remote[];
	onDeleteRemote: (name: string) => void;
	onAddRemote?: ((name: string, url: string, pushUrl: string | null) => void) | undefined;
	onEditRemote?: ((nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) => void) | undefined;
	onCheckSsh?: ((host: string, refresh?: boolean) => Promise<SshStatusInfo | null>) | undefined;
}): React.ReactElement {
	const [adding, setAdding] = React.useState(false);
	const [editing, setEditing] = React.useState<Remote | null>(null);
	const [name, setName] = React.useState('');
	const [url, setUrl] = React.useState('');
	const [pushUrl, setPushUrl] = React.useState('');
	const [protocolDraft, setProtocolDraft] = React.useState<RemoteProtocolSlot>('https');
	const [sshNote, setSshNote] = React.useState<string | null>(null);
	const [sshBusy, setSshBusy] = React.useState(false);

	/**
	 * 检测本地 SSH 状态。
	 *
	 * 结果由宿主按主机缓存，转换前的校验直接复用；显式检测时绕过缓存重新探测。
	 *
	 * @param host - 目标主机名。
	 * @param refresh - 为 true 时忽略宿主缓存重新探测。
	 * @returns 就绪时为 true；未就绪时说明原因并返回 false。
	 */
	const checkSsh = async (host: string, refresh = false): Promise<boolean> => {
		if (onCheckSsh === undefined) return true;
		setSshBusy(true);
		try {
			const status = await onCheckSsh(host, refresh);
			if (status === null) {
				setSshNote('SSH：检测失败');
				await showMessage({ title: 'SSH 状态未知', message: '无法获取本地 SSH 状态，请稍后重试。' });
				return false;
			}
			setSshNote(sshStatusText(status));
			if (!status.ready) {
				await showMessage({ title: 'SSH 未就绪', message: status.message ?? `本地 SSH 无法用于 ${status.host}。` });
				return false;
			}
			return true;
		} finally {
			setSshBusy(false);
		}
	};

	/**
	 * 换算地址的协议档位。
	 *
	 * 转为 SSH 前检测本地 SSH 状态（客户端、私钥与目标主机认证），未就绪时说明原因且不换算；
	 * 转回 HTTPS 不依赖本地 SSH，直接换算。
	 *
	 * @param value - 待换算的地址。
	 * @param target - 目标档位。
	 * @returns 换算后的地址；不可换算或 SSH 未就绪时为 null。
	 */
	const convertUrl = async (value: string, target: RemoteProtocolSlot): Promise<string | null> => {
		const next = target === 'ssh' ? toSshRemoteUrl(value) : toHttpsRemoteUrl(value);
		if (next === null) {
			await showMessage({ title: '无法转换', message: '该地址不是 HTTP(S) 或 SSH 形态的远程地址。' });
			return null;
		}
		if (next === value.trim() || target === 'https') return next;
		const host = remoteHostOf(value);
		return (await checkSsh(host === '' ? 'github.com' : host)) ? next : null;
	};

	/**
	 * 换算同一远程的推送地址：与抓取地址同主机时跟随换算，否则原样保留。
	 *
	 * @param push - 推送地址；未配置时为 null。
	 * @param fetch - 抓取地址。
	 * @param target - 目标档位。
	 * @returns 换算后的推送地址。
	 */
	const convertPushUrl = (push: string, fetch: string, target: RemoteProtocolSlot): string => {
		if (remoteHostOf(push) !== remoteHostOf(fetch)) return push;
		const next = target === 'ssh' ? toSshRemoteUrl(push) : toHttpsRemoteUrl(push);
		return next ?? push;
	};

	const submitAdd = (): void => {
		if (!name || !url) return;
		onAddRemote?.(name, url, pushUrl || null);
		setAdding(false); setName(''); setUrl(''); setPushUrl('');
	};
	const submitEdit = (): void => {
		if (!editing || !name) return;
		onEditRemote?.(editing.name, name, editing.url ?? null, url || null, editing.pushUrl ?? null, pushUrl || null);
		setEditing(null); setName(''); setUrl(''); setPushUrl('');
	};
	const beginEdit = (remote: Remote): void => {
		setEditing(remote);
		setName(remote.name);
		setUrl(remote.url ?? '');
		setPushUrl(remote.pushUrl ?? '');
	};
	/** 表单内切换协议：换算输入框内容，推送地址同主机时一并换算。 */
	const switchFormProtocol = async (target: RemoteProtocolSlot): Promise<void> => {
		if (url.trim() === '' || remoteProtocolSlot(url) === target) {
			setProtocolDraft(target);
			return;
		}
		const next = await convertUrl(url, target);
		if (next === null) return;
		setProtocolDraft(target);
		if (pushUrl.trim() !== '') setPushUrl(convertPushUrl(pushUrl, url, target));
		setUrl(next);
	};
	const form = React.createElement(
		'div',
		{ className: 'ggg-set-form' },
		React.createElement('label', { className: 'ggg-set-row-block' },
			React.createElement('span', { className: 'ggg-set-row-text' }, '名称'),
			React.createElement(Input, { value: name, placeholder: 'origin', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value) }),
		),
		React.createElement('label', { className: 'ggg-set-row-block' },
			React.createElement('span', { className: 'ggg-set-row-text' }, 'URL'),
			React.createElement(Input, {
				value: url,
				placeholder: 'https://github.com/owner/repo.git 或 git@github.com:owner/repo.git',
				onChange: (e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value),
			}),
		),
		React.createElement('div', { className: 'ggg-set-row' },
			React.createElement('span', { className: 'ggg-set-row-text' }, '协议'),
			React.createElement(SegmentedControl, {
				id: 'ggg-set-remote-protocol', label: '协议',
				value: remoteProtocolSlot(url) ?? protocolDraft,
				onChange: (next: string) => { void switchFormProtocol(next === 'ssh' ? 'ssh' : 'https'); },
				options: REMOTE_PROTOCOLS,
			}),
		),
		React.createElement('label', { className: 'ggg-set-row-block' },
			React.createElement('span', { className: 'ggg-set-row-text' }, '推送 URL（可选）'),
			React.createElement(Input, { value: pushUrl, placeholder: '与抓取 URL 相同时留空', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPushUrl(e.target.value) }),
		),
		React.createElement('div', { className: 'ggg-set-form-actions' },
			React.createElement(Button, { variant: 'primary', size: 'sm', onClick: editing !== null ? submitEdit : submitAdd }, editing !== null ? '保存' : '添加'),
			React.createElement(Button, { variant: 'toolbar', size: 'sm', onClick: () => { setAdding(false); setEditing(null); setName(''); setUrl(''); setPushUrl(''); } }, '取消'),
		),
	);
	const probeHost = remotes.map((remote) => remoteHostOf(remote.url ?? '')).find((host) => host !== '') ?? 'github.com';
	return React.createElement(
		'div',
		null,
		remotes !== undefined && remotes.length > 0
			? React.createElement('div', { className: 'ggg-set-remotes' },
				...remotes.map((remote) => React.createElement(
					'div',
					{ key: remote.name, className: 'ggg-set-remote' },
					React.createElement('span', { className: 'ggg-set-remote-name' }, remote.name),
					React.createElement('span', { className: 'ggg-set-remote-url' }, remote.url ?? ''),
					React.createElement('button', {
						type: 'button', className: 'ggg-set-remote-edit', title: '编辑远程',
						onClick: () => beginEdit(remote),
					}, React.createElement(IconEditOutlineRegular, { size: 18 })),
					React.createElement('button', {
						type: 'button', className: 'ggg-set-remote-del', title: '删除远程',
						// 删除远程会改动仓库配置，先确认。
						onClick: async () => {
							const ok = await showConfirmation({
								title: '删除远程', message: `确定删除远程仓库 ${remote.name}？`,
								confirmLabel: '删除', danger: true,
							});
							if (ok) onDeleteRemote?.(remote.name);
						},
					}, React.createElement(IconTrashOutlineRegular, { size: 13 })),
				)),
			)
			: React.createElement('div', { className: 'ggg-set-note' }, '没有配置远程仓库'),
		!adding && editing === null
			? React.createElement(Button, { variant: 'outline', size: 'sm', onClick: () => setAdding(true) }, '添加远程')
			: form,
		React.createElement('div', { className: 'ggg-set-form-actions' },
			React.createElement(Button, {
				variant: 'toolbar', size: 'sm', disabled: sshBusy,
				onClick: () => { void checkSsh(probeHost, true); },
			}, '检测 SSH 状态'),
		),
		sshNote !== null && React.createElement('div', { className: 'ggg-set-note' }, sshNote),
	);
}

/**
 * Issue 链接配置表单。
 *
 * @param props.config - 当前配置。
 * @param props.onChange - 变更回调。
 * @returns 表单元素。
 */
function IssueLinkingForm({ config, onChange }: {
	config: IssueLinkingConfig | null;
	onChange: (config: IssueLinkingConfig) => void;
}): React.ReactElement {
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
				onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange({ issueRegex: event.target.value, issueUrlTemplate: url }),
			}),
		),
		React.createElement('label', { className: 'ggg-set-row-block' },
			React.createElement('span', { className: 'ggg-set-row-text' }, 'Issue 链接模板'),
			React.createElement(Input, {
				value: url,
				placeholder: '如 https://github.com/owner/repo/issues/%ID%',
				onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange({ issueRegex: regex, issueUrlTemplate: event.target.value }),
			}),
		),
		React.createElement('div', { className: 'ggg-set-note' }, '该配置仅在前端保存，用于识别提交信息中的 Issue 编号。'),
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
function UserDetailsForm({ userDetails, onEdit, onDelete, scope }: {
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
		onDelete?.(localName !== null, localEmail !== null, 'local');
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
		onEdit?.(name, email, scope, false, false);
	};
	const remove = (): void => {
		onDelete?.(true, true, scope);
		setName('');
		setEmail('');
	};
	return React.createElement(
		'div',
		{ className: 'ggg-set-form' },
		scope === 'repo' && React.createElement(ToggleRow, {
			label: '使用全局身份',
			checked: useGlobal,
			onChange: toggleUseGlobal,
		}),
		// 使用全局身份时不显示输入框；当前值由下方的配置说明给出，不重复列出。
		inheriting
			? (globalName === null && globalEmail === null
				? React.createElement('div', { className: 'ggg-set-note' }, '未配置全局身份，请在「全局设置」中配置。')
				: null)
			: [
				React.createElement('label', { className: 'ggg-set-row-block', key: 'name' },
					React.createElement('span', { className: 'ggg-set-row-text' }, '用户名'),
					React.createElement(Input, {
						value: name,
						placeholder: 'git user.name',
						onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
					}),
				),
				React.createElement('label', { className: 'ggg-set-row-block', key: 'email' },
					React.createElement('span', { className: 'ggg-set-row-text' }, '邮箱'),
					React.createElement(Input, {
						value: email,
						placeholder: 'git user.email',
						onChange: (event: React.ChangeEvent<HTMLInputElement>) => setEmail(event.target.value),
					}),
				),
				React.createElement('div', { className: 'ggg-set-row ggg-set-row-inline', key: 'actions' },
					React.createElement(Button, { variant: 'primary', size: 'sm', onClick: save }, '保存'),
					React.createElement(Button, { variant: 'outline', size: 'sm', onClick: remove }, '删除'),
				),
			],
		localName !== null
			&& React.createElement('div', { className: 'ggg-set-note' }, `仓库级覆盖：${localName} <${localEmail ?? '?'}>`),
		globalName !== null
			&& React.createElement('div', { className: 'ggg-set-note' }, `全局配置：${globalName} <${globalEmail ?? '?'}>`),
	);
}
