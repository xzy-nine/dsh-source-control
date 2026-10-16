/**
 * GitHub 集成与 SSH 状态：账号、属主、新建仓库、创建 Pull Request。
 */
import { callApi } from './http.ts';
import { textOf } from '../shared/text.ts';

/** GitHub 账号信息。 */
export interface GhAccountInfo {
	readonly loggedIn: boolean;
	readonly user: string | null;
	readonly owners: readonly string[];
	/** 当前 token 的 scope 列表。 */
	readonly scopes: readonly string[];
	/** 不可用的功能与原因；前端据此隐藏入口并说明原因。 */
	readonly unavailable: readonly { readonly feature: string; readonly reason: string; readonly message: string }[];
}

/** 可发布的属主。 */
export interface GhOwnerInfo {
	readonly login: string;
	readonly isOrg: boolean;
	readonly name: string;
}

/** 远程仓库信息（创建 PR 用）。 */
export interface GhRepoInfoResult {
	readonly defaultBranch: string | null;
	readonly branches: readonly string[];
}

/**
 * 读取 GitHub 账号与可用的仓库属主。
 *
 * @param cwd - 会话工作区路径。
 * @returns 账号信息；未安装或未登录时 `loggedIn` 为 false。
 */
export async function ghAccount(cwd: string): Promise<GhAccountInfo> {
	const payload = await callApi(cwd, { command: 'ghAccount' });
	const account = (payload.account ?? {}) as Record<string, unknown>;
	const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
	const unavailable = Array.isArray(account.unavailable)
		? account.unavailable.map((item) => {
			const entry = item as Record<string, unknown>;
			return { feature: textOf(entry.feature), reason: textOf(entry.reason), message: textOf(entry.message) };
		})
		: [];
	return {
		loggedIn: account.loggedIn === true,
		user: typeof account.user === 'string' ? account.user : null,
		owners: strings(account.owners),
		scopes: strings(account.scopes),
		unavailable,
	};
}

/**
 * 列出可作为仓库属主的账号：个人账号在前，随后是其组织。
 *
 * @param cwd - 会话工作区路径。
 * @returns 属主列表。
 */
export async function ghOwners(cwd: string): Promise<GhOwnerInfo[]> {
	const payload = await callApi(cwd, { command: 'ghOwners' });
	const owners = Array.isArray(payload.owners) ? payload.owners : [];
	return owners.map((item) => {
		const owner = item as Record<string, unknown>;
		return {
			login: textOf(owner.login),
			isOrg: owner.isOrg === true,
			name: typeof owner.name === 'string' && owner.name !== '' ? owner.name : textOf(owner.login),
		};
	}).filter((owner) => owner.login !== '');
}

/**
 * 读取远程仓库的默认分支与分支候选。
 *
 * @param cwd - 会话工作区路径。
 * @returns 默认分支与分支列表。
 */
export async function ghRepoInfo(cwd: string): Promise<GhRepoInfoResult> {
	const payload = await callApi(cwd, { command: 'ghRepoInfo' });
	const info = (payload.info ?? {}) as Record<string, unknown>;
	return {
		defaultBranch: typeof info.defaultBranch === 'string' ? info.defaultBranch : null,
		branches: Array.isArray(info.branches) ? info.branches.filter((item): item is string => typeof item === 'string') : [],
	};
}

/**
 * 本地 SSH 状态。
 */
export interface SshStatusInfo {
	/** ssh 客户端是否可用。 */
	readonly installed: boolean;
	/** ssh 版本行；不可用时为 null。 */
	readonly version: string | null;
	/** `~/.ssh` 下的私钥文件名。 */
	readonly keys: readonly string[];
	/** 探测的目标主机。 */
	readonly host: string;
	/** 目标主机是否接受本机公钥。 */
	readonly authenticated: boolean;
	/** 是否可直接用于 SSH 远程操作。 */
	readonly ready: boolean;
	/** 未就绪时的原因说明。 */
	readonly message: string | null;
	/** 探测输出的原文。 */
	readonly detail: string;
}

/**
 * 检测本地 SSH 状态：ssh 客户端、私钥与对目标主机的认证。
 *
 * 结果由宿主按主机缓存：就绪结果缓存 5 分钟、未就绪结果缓存 15 秒，重复调用不重新探测。
 *
 * @param cwd - 会话工作区路径。
 * @param host - 目标主机名，默认 github.com。
 * @param refresh - 为 true 时忽略宿主缓存，重新探测。
 * @returns SSH 状态。
 */
export async function sshStatus(cwd: string, host = 'github.com', refresh = false): Promise<SshStatusInfo> {
	const payload = await callApi(cwd, { command: 'sshStatus', host, refresh });
	const status = (payload.status ?? {}) as Record<string, unknown>;
	const keys = Array.isArray(status.keys) ? status.keys.filter((item): item is string => typeof item === 'string') : [];
	return {
		installed: status.installed === true,
		version: typeof status.version === 'string' ? status.version : null,
		keys,
		host: typeof status.host === 'string' ? status.host : host,
		authenticated: status.authenticated === true,
		ready: status.ready === true,
		message: typeof status.message === 'string' ? status.message : null,
		detail: typeof status.detail === 'string' ? status.detail : '',
	};
}

/**
 * 在 GitHub 上新建仓库并设为本地远程后推送。
 *
 * @param cwd - 会话工作区路径。
 * @param options - 仓库名、属主、可见性、简介与远程地址协议。
 * @returns 新仓库地址。
 */
export async function ghCreateRepo(cwd: string, options: { name: string; owner: string; private: boolean; description: string; protocol: 'https' | 'ssh' }): Promise<string> {
	const payload = await callApi(cwd, { command: 'ghCreateRepo', ...options, remote: 'origin' });
	return typeof payload.url === 'string' ? payload.url : '';
}

/**
 * 创建 Pull Request。
 *
 * @param cwd - 会话工作区路径。
 * @param options - 源分支、目标分支、标题、正文与是否草稿。
 * @returns Pull Request 地址。
 */
export async function ghCreatePullRequest(cwd: string, options: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<string> {
	const payload = await callApi(cwd, { command: 'createPullRequest', ...options });
	return typeof payload.url === 'string' ? payload.url : '';
}
