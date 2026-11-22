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
		const path = (byUrl.at(3) ?? '').replace(/^\/+/, '');
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
 * 该协议是否归入 HTTP(S) 一族：`http`、`https` 与 `git` 三者可互相换算。
 *
 * @param protocol - 解析出的协议。
 * @returns 属于这一族时为 true。
 */
function isHttpLike(protocol: RemoteProtocol): boolean {
	return protocol === 'https' || protocol === 'http' || protocol === 'git';
}

/**
 * 解析地址并拒绝没有主机的形态。
 *
 * 本地路径与空串都没有主机，无法换算成另一种地址形态。
 *
 * @param url - 远程地址原文。
 * @returns 带主机的地址；不可换算时为 null。
 */
function addressWithHost(url: string): RemoteAddress | null {
	const address = parseRemoteAddress(url);
	return address === null || address.host === '' ? null : address;
}

/**
 * 地址的 scp 形态 SSH 写法。
 *
 * @param address - 已解析的地址，调用方保证 host 非空。
 * @returns `git@host:path`。
 */
function sshFormOf(address: RemoteAddress): string {
	return `git@${address.host}:${address.path}`;
}

/**
 * 地址的 HTTPS 写法。
 *
 * @param address - 已解析的地址，调用方保证 host 非空。
 * @returns `https://host/path`。
 */
function httpsFormOf(address: RemoteAddress): string {
	return `https://${address.host}/${address.path}`;
}

/**
 * 把地址换算到另一个协议族；已属该族时按原文归一。
 *
 * 两个方向共用这一处判定：解析、拒绝无主机的形态、已在目标族内时归一原文、否则按目标族的
 * 写法重写，不为该族时给 null。
 *
 * @param url - 远程地址原文。
 * @param target - 目标族。
 * @param render - 落在目标族时的写法。
 * @returns 换算结果；不可换算时为 null。
 */
function convertRemoteUrl(
	url: string,
	target: RemoteProtocolSlot,
	render: (address: RemoteAddress) => string,
): string | null {
	const address = addressWithHost(url);
	if (address === null) return null;
	const family: RemoteProtocolSlot | null = address.protocol === 'ssh' ? 'ssh' : isHttpLike(address.protocol) ? 'https' : null;
	if (family === null) return null;
	/*
	 * 已是目标族时仍要看写法：scp 形态的 SSH 地址原样返回，其余（含 ssh:// 这种 URL 形态）
	 * 归一为目标族的规范写法。只按「同一族」提前返回会让 ssh:// 原封不动地留在结果里。
	 */
	const canonical = target === 'ssh' ? address.form === 'scp' : address.protocol === 'https';
	return canonical ? url.trim() : render(address);
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
	return convertRemoteUrl(url, 'ssh', sshFormOf);
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
	return isHttpLike(address.protocol) ? 'https' : null;
}

/**
 * 换算为 HTTPS 地址。
 *
 * @param url - 远程地址原文。
 * @returns HTTPS 地址；不可换算时为 null。
 */
export function toHttpsRemoteUrl(url: string): string | null {
	return convertRemoteUrl(url, 'https', httpsFormOf);
}
