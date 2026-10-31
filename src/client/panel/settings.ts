/**
 * 源代码管理设置面板：按页签组装各分区。
 *
 * 全局分区覆盖提交图、引用标签与日期格式；仓库分区覆盖用户身份、远程仓库、
 * Issue Linking 与仓库配置导出。
 */
import React from 'react';
import { Button, SegmentedTabs, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { FeedbackTab } from './feedback.ts';
import type { SshStatusInfo } from '../api/index.ts';
import type { Remote, Settings } from '../shared/types.ts';
import { DATE_FORMAT_TYPE, ORDERING } from './settings-model.ts';
import {
	AUTO_FETCH_PERIOD_SECONDS_MAX, AUTO_FETCH_PERIOD_SECONDS_MIN, CLEANUP_PERIOD_SECONDS_MAX, CLEANUP_PERIOD_SECONDS_MIN,
	FALLBACK_POLL_SECONDS_MAX, FALLBACK_POLL_SECONDS_MIN,
} from './change-events.ts';
import {
	NumberRow, Section, SelectRow, ToggleRow,
} from './settings-rows.ts';
import { AiModelConfigSection } from './settings-ai.ts';
import { RemoteConfigSection } from './settings-remote.ts';
import { IssueLinkingForm, UserDetailsForm } from './settings-details.ts';
import type { SettingsTab, UserDetails } from './settings-types.ts';
import css from '../css/settings.module.css';

export { SETTINGS_KEY, ORDERING, DATE_FORMAT_TYPE, REMOTE_PROTOCOLS, defaultSettings, loadSettings, saveSettings, formatDate } from './settings-model.ts';
export type { UserDetails, SettingsTab } from './settings-types.ts';

/** 页签对应的面板 id。 */
const PANEL_ID_OF: Readonly<Record<SettingsTab, string>> = {
	repo: 'ggg-set-panel-repo',
	global: 'ggg-set-panel-global',
	feedback: 'ggg-set-panel-feedback',
};

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
	/** 当前会话工作区路径；反馈页签据此提交 gh 命令。 */
	readonly cwd?: string | null;
	/** 插件版本，写进反馈正文。 */
	readonly pluginVersion?: string;
	/** 打开设置时直接落在反馈页签。 */
	readonly initialTab?: SettingsTab;
	/** 按绝对路径打开一个文件（复用更改区的文件打开接线）。 */
	readonly onOpenFile?: ((path: string) => void) | undefined;
	/** 在系统文件管理器中定位一个路径；未装载时为 undefined。 */
	readonly onRevealPath?: ((path: string) => void) | undefined;
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
	userDetails, onEditUserDetails, onDeleteUserDetails, cwd = null, pluginVersion = '', initialTab = 'repo',
	onOpenFile, onRevealPath,
}: SettingsPanelProps): React.ReactElement | null {
	const [tab, setTab] = React.useState<SettingsTab>(initialTab);
	// 外部指定页签时跟随：面板打开前先设好目标页签，打开即落位。
	React.useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
	if (!open) return null;
	const patch = (partial: Partial<Settings>): void => { onChange({ ...settings, ...partial }); };
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
				onChange: (value) => { patch({ commitOrdering: value }); },
			}),
			React.createElement(SelectRow, {
				label: '日期格式',
				options: DATE_FORMAT_TYPE,
				value: String(settings.dateFormat.type),
				onChange: (type) => { patch({ dateFormat: { ...settings.dateFormat, type: Number(type) } }); },
			}),
			React.createElement(ToggleRow, {
				label: '使用 ISO 日期格式',
				checked: settings.dateFormat.iso,
				onChange: (iso) => { patch({ dateFormat: { ...settings.dateFormat, iso } }); },
			}),
			React.createElement(ToggleRow, {
				label: '显示贮藏',
				checked: settings.showStashes,
				onChange: (showStashes) => { patch({ showStashes }); },
			}),
			React.createElement(ToggleRow, {
				label: '显示标签',
				checked: settings.showTags,
				onChange: (showTags) => { patch({ showTags }); },
			}),
			React.createElement(ToggleRow, {
				label: '显示远程分支',
				checked: settings.showRemoteBranches,
				onChange: (showRemoteBranches) => { patch({ showRemoteBranches }); },
			}),
			React.createElement(ToggleRow, {
				label: '只跟随第一个父提交',
				checked: settings.onlyFollowFirstParent,
				onChange: (onlyFollowFirstParent) => { patch({ onlyFollowFirstParent }); },
			}),
			React.createElement(ToggleRow, {
				label: '包含 reflog 提到的提交',
				checked: settings.includeCommitsMentionedByReflogs,
				onChange: (includeCommitsMentionedByReflogs) => { patch({ includeCommitsMentionedByReflogs }); },
			}),
			React.createElement(ToggleRow, {
				label: 'Markdown 渲染提交信息',
				checked: settings.markdown,
				onChange: (markdown) => { patch({ markdown }); },
			}),
			React.createElement(ToggleRow, {
				label: '显示作者头像',
				checked: settings.showAvatars,
				onChange: (showAvatars) => { patch({ showAvatars }); },
			}),
			React.createElement(ToggleRow, {
				label: '静音合并提交',
				checked: settings.muteMergeCommits,
				onChange: (muteMergeCommits) => { patch({ muteMergeCommits }); },
			}),
			React.createElement(ToggleRow, {
				label: '抓取时修剪已删除远程分支',
				checked: settings.fetchAndPrune,
				onChange: (fetchAndPrune) => { patch({ fetchAndPrune }); },
			}),
			React.createElement(ToggleRow, {
				label: '抓取时修剪远程标签',
				checked: settings.fetchAndPruneTags,
				onChange: (fetchAndPruneTags) => { patch({ fetchAndPruneTags }); },
			}),
			React.createElement(ToggleRow, {
				label: '文件改动时自动刷新',
				checked: settings.autoRefresh,
				onChange: (autoRefresh) => { patch({ autoRefresh }); },
			}),
			React.createElement(ToggleRow, {
				label: '自动抓取远程',
				checked: settings.autoFetch,
				onChange: (autoFetch) => { patch({ autoFetch }); },
			}),
			React.createElement(NumberRow, {
				label: '自动抓取间隔（秒）',
				value: settings.autoFetchPeriod,
				min: AUTO_FETCH_PERIOD_SECONDS_MIN,
				max: AUTO_FETCH_PERIOD_SECONDS_MAX,
				onChange: (autoFetchPeriod) => { patch({ autoFetchPeriod }); },
			}),
			React.createElement(NumberRow, {
				label: '校对间隔·页签可见（秒）',
				value: settings.pollActiveSeconds,
				min: FALLBACK_POLL_SECONDS_MIN,
				max: FALLBACK_POLL_SECONDS_MAX,
				onChange: (pollActiveSeconds) => { patch({ pollActiveSeconds }); },
			}),
			React.createElement(NumberRow, {
				label: '校对间隔·页签不可见（秒）',
				value: settings.pollIdleSeconds,
				min: FALLBACK_POLL_SECONDS_MIN,
				max: FALLBACK_POLL_SECONDS_MAX,
				onChange: (pollIdleSeconds) => { patch({ pollIdleSeconds }); },
			}),
			React.createElement(NumberRow, {
				label: '提交信息缓存清理（秒）',
				value: settings.cleanupSeconds,
				min: CLEANUP_PERIOD_SECONDS_MIN,
				max: CLEANUP_PERIOD_SECONDS_MAX,
				onChange: (cleanupSeconds) => { patch({ cleanupSeconds }); },
			}),
			React.createElement(ToggleRow, {
				label: '加载仓库后滚动到 HEAD',
				checked: settings.onRepoLoadScrollToHead,
				onChange: (onRepoLoadScrollToHead) => { patch({ onRepoLoadScrollToHead }); },
			}),
		),
		React.createElement(Section, { title: 'Issue Linking', key: 'issue' },
			React.createElement(IssueLinkingForm, {
				config: settings.issueLinkingConfig,
				onChange: (issueLinkingConfig) => { patch({ issueLinkingConfig }); },
			}),
		),
		React.createElement(Section, { title: 'AI 提交信息', key: 'ai' },
			React.createElement(AiModelConfigSection, {
				provider: settings.aiCommitProvider,
				model: settings.aiCommitModel,
				rules: settings.aiCommitRules,
				onChange: (aiCommitProvider, aiCommitModel) => { patch({ aiCommitProvider, aiCommitModel }); },
				onRulesChange: (aiCommitRules) => { patch({ aiCommitRules }); },
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
		React.createElement(Section, { title: '仓库配置', key: 'export' },
			React.createElement(Button, {
				variant: 'outline', size: 'sm',
				onClick: () => { onExportConfig?.(); },
			}, '导出仓库配置'),
		),
	];
	return React.createElement(
		React.Fragment,
		null,
		React.createElement('div', { className: css.settingsBackdrop, onClick: onClose }),
		React.createElement(
			'div',
			{ className: css.settings, role: 'dialog', 'aria-label': '源代码管理设置' },
			React.createElement('div', { className: css.settingsHead },
				'设置',
				React.createElement(Button, {
					variant: 'toolbar', size: 'sm', title: '关闭',
					onClick: onClose,
				}, React.createElement(IconCloseOutlineRegular, { size: 14 })),
			),
			React.createElement(SegmentedTabs, {
				label: '设置范围',
				value: tab,
				onChange: (value: SettingsTab) => { setTab(value); },
				items: [
					{ value: 'repo', label: '仓库设置', id: 'ggg-set-tab-repo', panelId: 'ggg-set-panel-repo' },
					{ value: 'global', label: '全局设置', id: 'ggg-set-tab-global', panelId: 'ggg-set-panel-global' },
					{ value: 'feedback', label: '反馈', id: 'ggg-set-tab-feedback', panelId: 'ggg-set-panel-feedback' },
				],
			}),
			React.createElement('div', {
				className: css.settingsBody,
				id: PANEL_ID_OF[tab],
				role: 'tabpanel',
				'aria-labelledby': `ggg-set-tab-${tab}`,
			},
				...(tab === 'repo'
					? repoSections
					: tab === 'global'
						? [userSection('global'), ...generalSections]
						: [React.createElement(FeedbackTab, { key: 'feedback', cwd, pluginVersion, onOpenFile, onRevealPath })]),
			),
		),
	);
}