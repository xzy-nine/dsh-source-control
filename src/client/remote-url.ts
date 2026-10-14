/**
 * 远程地址解析与 HTTP(S) / SSH 形态换算。
 *
 * 识别三种书写形态：URL 形态 `https://host/owner/repo.git`、scp 形态 `git@host:owner/repo.git`
 * 与本地路径。SSH 的 URL 形态 `ssh://git@host/owner/repo.git` 在换算时归一为 scp 形态。
 *
 * 本模块无任何导入，供面板与单元测试直接使用。
 */

/** 远程地址的协议类别。 */
export type RemoteProtocol = 'https' | 'http' | 'ssh' | 'git' | 'file' | 'other';

/** 解析后的远程地址。 */
export interface RemoteAddress {
	/** 协议类别。 */
	readonly protocol: RemoteProtocol;
	/** 书写形态：URL、scp 或本地路径。 */
	readonly form: 'url' | 'scp' | 'path';
	/** 主机名；本地路径为空串。 */
	readonly host: string;
	/** 主机后的路径，不含前导斜杠。 */
	readonly path: string;
}

/** URL 形态：`scheme://[user@]host[:port]/path`。 */
const URL_FORM = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?(\/.*)?$/i;

/** scp 形态：`[user@]host:path`。 */
const SCP_FORM = /^(?:[^@/]+@)?([^:/@]+):(.+)$/;

/** Windows 盘符路径，如 `C:\repos\x`。 */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/**
 * 解析一个远程地址。
 *
 * @param url - 远程地址原文。
 * @returns 解析结果；无法识别（空串、未知 scheme、`file://`）时为 null。
 */
export function parseRemoteAddress(url: string): RemoteAddress | null {
	const text = url.trim();
	if (text === '') return null;
	if (WINDOWS_PATH.test(text)) return { protocol: 'file', form: 'path', host: '', path: text };

	const byUrl = URL_FORM.exec(text);
	if (byUrl !== null) {
		const scheme = byUrl[1].toLowerCase();
		const protocol: RemoteProtocol = scheme === 'ssh' ? 'ssh'
			: scheme === 'https' ? 'https'
				: scheme === 'http' ? 'http'
					: scheme === 'git' ? 'git'
						: 'other';
		const path = (byUrl[3] ?? '').replace(/^\/+/, '');
		if (protocol === 'other' || path === '') return null;
		return { protocol, form: 'url', host: byUrl[2], path };
	}
	// 带 scheme 但没有主机（如 `file:///path`）不是远程地址。
	if (text.includes('://')) return null;

	const byScp = SCP_FORM.exec(text);
	if (byScp !== null) {
		if (byScp[2].startsWith('\\')) return { protocol: 'file', form: 'path', host: '', path: text };
		return { protocol: 'ssh', form: 'scp', host: byScp[1], path: byScp[2] };
	}
	return null;
}

/**
 * 是否为 SSH 形态的远程地址。
 *
 * @param url - 远程地址原文。
 * @returns SSH 形态时为 true。
 */
export function isSshRemoteUrl(url: string): boolean {
	return parseRemoteAddress(url)?.protocol === 'ssh';
}

/**
 * 远程地址的主机名。
 *
 * @param url - 远程地址原文。
 * @returns 主机名；本地路径或不可解析时为空串。
 */
export function remoteHostOf(url: string): string {
	return parseRemoteAddress(url)?.host ?? '';
}

/**
 * 换算为 scp 形态的 SSH 地址。
 *
 * HTTP(S) 与 `git://` 地址改用 `git@` 用户；已是 SSH 的 scp 形态原样返回，URL 形态归一为
 * scp 形态。路径与 `.git` 后缀按原文保留，不做增删。
 *
 * @param url - 远程地址原文。
 * @returns SSH 地址；不可换算（本地路径、未知 scheme）时为 null。
 */
export function toSshRemoteUrl(url: string): string | null {
	const address = parseRemoteAddress(url);
	if (address === null || address.host === '') return null;
	if (address.protocol === 'ssh') {
		return address.form === 'scp' ? url.trim() : `git@${address.host}:${address.path}`;
	}
	if (address.protocol === 'https' || address.protocol === 'http' || address.protocol === 'git') {
		return `git@${address.host}:${address.path}`;
	}
	return null;
}

/**
 * 远程地址的协议档位：HTTP(S) 与 `git://` 同属 `https` 档，SSH 属 `ssh` 档。
 */
export type RemoteProtocolSlot = 'https' | 'ssh';

/**
 * 取地址所属的协议档位。
 *
 * @param url - 远程地址原文。
 * @returns 档位；地址不可判定（本地路径、未知 scheme、空串）时为 null。
 */
export function remoteProtocolSlot(url: string): RemoteProtocolSlot | null {
	const address = parseRemoteAddress(url);
	if (address === null) return null;
	if (address.protocol === 'ssh') return 'ssh';
	return address.protocol === 'https' || address.protocol === 'http' || address.protocol === 'git' ? 'https' : null;
}

/**
 * 换算为 HTTPS 地址。
 *
 * @param url - 远程地址原文。
 * @returns HTTPS 地址；不可换算时为 null。
 */
export function toHttpsRemoteUrl(url: string): string | null {
	const address = parseRemoteAddress(url);
	if (address === null || address.host === '') return null;
	if (address.protocol === 'https') return url.trim();
	if (address.protocol === 'ssh' || address.protocol === 'http' || address.protocol === 'git') {
		return `https://${address.host}/${address.path}`;
	}
	return null;
}
