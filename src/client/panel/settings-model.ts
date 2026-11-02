/**
 * 设置模型：默认值、持久化读写与日期格式化。
 *
 * 设置由宿主持久化（见 ./storage.ts 的预取），因此换浏览器与标签页都保留。
 */
import type { DateFormat, Settings } from '../shared/types.ts';
import {
	AUTO_FETCH_PERIOD_SECONDS_DEFAULT,
	CLEANUP_PERIOD_SECONDS_DEFAULT,
	FALLBACK_POLL_ACTIVE_SECONDS_DEFAULT, FALLBACK_POLL_INTERVAL_SECONDS_DEFAULT,
} from './change-events.ts';
import { loadValue, saveValue } from './storage.ts';

/** 设置键。 */
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
		commitOrdering: 'topo',
		dateFormat: { type: 0, iso: false },
		showStashes: true,
		showTags: true,
		showRemoteBranches: true,
		onlyFollowFirstParent: false,
		includeCommitsMentionedByReflogs: false,
		issueLinkingConfig: null,
		markdown: true,
		muteMergeCommits: false,
		fetchAndPrune: false,
		fetchAndPruneTags: false,
		autoRefresh: true,
		autoFetch: true,
		autoFetchPeriod: AUTO_FETCH_PERIOD_SECONDS_DEFAULT,
		pollActiveSeconds: FALLBACK_POLL_ACTIVE_SECONDS_DEFAULT,
		pollIdleSeconds: FALLBACK_POLL_INTERVAL_SECONDS_DEFAULT,
		cleanupSeconds: CLEANUP_PERIOD_SECONDS_DEFAULT,
		onRepoLoadScrollToHead: false,
		showAvatars: true,
		graphColours: null,
		aiCommitProvider: '',
		aiCommitModel: '',
		aiCommitRules: '',
	};
}
/**
 * 读取设置，缺项以默认补齐。
 *
 * 设置由宿主持久化（见 ./storage.ts 的预取），因此换浏览器与标签页都保留。
 *
 * @returns 设置对象。
 */
export function loadSettings(): Settings {
	const base = defaultSettings();
	const parsed = loadValue<Partial<Settings> | null>(SETTINGS_KEY, null);
	if (parsed === null || typeof parsed !== 'object') return base;
	return {
		...base,
		...parsed,
		dateFormat: { ...base.dateFormat, ...(parsed.dateFormat ?? {}) },
		issueLinkingConfig: parsed.issueLinkingConfig ?? null,
		graphColours: Array.isArray(parsed.graphColours) ? parsed.graphColours : null,
	};
}

/**
 * 把设置写入宿主。
 *
 * @param settings - 设置对象。
 * @returns 无。
 */
export function saveSettings(settings: Settings): void {
	saveValue(SETTINGS_KEY, settings);
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
	const type = dateFormat.type;
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
	if (dateFormat.iso) {
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