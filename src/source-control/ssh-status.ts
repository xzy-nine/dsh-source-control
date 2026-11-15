/**
 * 本地 SSH 状态检测：ssh 客户端、`~/.ssh` 私钥与对目标主机的认证结果。
 *
 * 认证判定只取退出码，不解析输出文字：远端横幅的措辞、颜色与退出码由对方决定。
 * 有远程地址时用它跑 `git ls-remote`，走一遍 git 真实取数路径；只有主机名时退回 `ssh` 握手。
 * 探测一律非交互并带连接超时，避免缺少凭据时挂起等待输入。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { runCollect } from './host-runtime.js';

/** 本地 SSH 状态。 */
export interface SshStatus {
	/** ssh 可执行文件是否可用。 */
	readonly installed: boolean;
	/** ssh 版本行；不可用时为 null。 */
	readonly version: string | null;
	/** `~/.ssh` 下的私钥文件名（不含 `.pub`）。 */
	readonly keys: readonly string[];
	/** 探测的目标主机。 */
	readonly host: string;
	/** 目标主机是否接受本机公钥。 */
	readonly authenticated: boolean;
	/** 是否可直接用于 SSH 远程操作：客户端可用且认证通过。 */
	readonly ready: boolean;
	/** 未就绪时的说明：探测输出原文，没有输出时为兜底一句；就绪时为 null。 */
	readonly message: string | null;
}

/** `~/.ssh` 中不作为私钥列出的文件名。 */
const NON_KEY_NAMES = new Set([
	'agent', 'authorized_keys', 'config', 'environment', 'known_hosts', 'known_hosts.old', 'rc', 'ssh_config',
]);

/** 一次探测中一次调用的结果。 */
interface ProbeOutput {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** 探测方式：`git` 用远程地址跑 `git ls-remote`，`ssh` 只用主机名跑 `ssh -T`。 */
export type SshProbeMode = 'git' | 'ssh';

/** 认证探测的超时毫秒数。 */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * 运行一次 ssh。
 *
 * 无法启动子进程（ssh 不在 PATH）时不抛错，以退出码 -1 与错误文本返回；
 * 超过时限时结束子进程并以超时文本返回。
 *
 * @param args - 参数数组，按原样传给 ssh。
 * @param timeoutMs - 超时毫秒数。
 * @returns 退出码与输出。
 */
function runSsh(args: readonly string[], timeoutMs: number): Promise<ProbeOutput> {
	return runCollect({
		command: 'ssh',
		args,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		timeoutMs,
		timeoutMessage: 'SSH 探测超时',
	});
}

/**
 * 运行一次 `git ls-remote`。
 *
 * 用远程地址本身探测，因此本机 git 与 ssh 配置、代理与传输设置都参与其中，探测结果与真实取数一致。
 *
 * @param url - SSH 形态的远程地址。
 * @param timeoutMs - 超时毫秒数。
 * @returns 退出码与输出。
 */
function runGitProbe(url: string, timeoutMs: number): Promise<ProbeOutput> {
	return runCollect({
		command: 'git',
		args: ['ls-remote', '--heads', '--', url],
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		timeoutMs,
		timeoutMessage: 'git ls-remote 探测超时',
	});
}

/**
 * 从 `ssh -V` 的输出里取版本行。
 *
 * OpenSSH 把版本写入标准错误；取首个 `OpenSSH` 开头的行，没有时退回首个非空行。
 *
 * @param stdout - 标准输出。
 * @param stderr - 标准错误。
 * @returns 版本行；输出为空时为 null。
 */
export function parseSshVersion(stdout: string, stderr: string): string | null {
	const lines = `${stderr}\n${stdout}`.split('\n').map((line) => line.trim()).filter((line) => line !== '');
	return lines.find((line) => /^OpenSSH/i.test(line)) ?? lines.at(0) ?? null;
}

/**
 * 从 `~/.ssh` 的目录项里挑出私钥文件名。
 *
 * 排除隐藏项、`.pub` 公钥与 `known_hosts` / `config` 等配置文件。
 *
 * @param entries - 目录项名称。
 * @returns 私钥文件名，按名称升序。
 */
export function sshKeyNames(entries: readonly string[]): string[] {
	return entries
		.filter((name) => !name.startsWith('.') && !name.endsWith('.pub') && !NON_KEY_NAMES.has(name))
		.sort();
}

/**
 * 退出码是否表示认证通过。
 *
 * `git ls-remote` 成功即以 0 结束。`ssh -T` 的退出码取自远端命令：认证通过后远端拒绝该命令，
 * 退出码由对方决定（github 为 1、gitee 为 0），只有 ssh 自身出错才用 255（man ssh：ssh exits
 * with the exit status of the remote command or with 255 if an error occurred），因此 255 之外
 * 都算认证通过。
 *
 * @param mode - 探测方式。
 * @param code - 探测的退出码。
 * @returns 认证通过时为 true。
 */
export function isAuthenticated(mode: SshProbeMode, code: number): boolean {
	return mode === 'git' ? code === 0 : code !== 255;
}

/** 探测没有任何输出时的兜底说明；`{host}` 为目标主机。 */
const FAILED_WITHOUT_OUTPUT = 'SSH 认证未通过（{host}）。';

/**
 * 未就绪时的说明。
 *
 * 取探测输出原文，ANSI 转义序列原样保留，由界面按颜色渲染；没有任何输出时给兜底一句。
 *
 * @param stdout - 探测的标准输出。
 * @param stderr - 探测的标准错误。
 * @param host - 探测的目标主机名。
 * @returns 说明文本。
 */
export function sshFailureMessage(stdout: string, stderr: string, host: string): string {
	const text = `${stdout}\n${stderr}`.trim();
	return text === '' ? FAILED_WITHOUT_OUTPUT.replace('{host}', host) : text;
}

/**
 * 目标主机名是否可直接用于 ssh 参数；非法值退回 github.com。
 *
 * @param host - 请求探测的主机名。
 * @returns 安全的主机名。
 */
function safeHost(host: string): string {
	const text = host.trim();
	return /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(text) ? text : 'github.com';
}

/**
 * `ssh` 握手探测的参数。
 *
 * `BatchMode=yes` 与 `StrictHostKeyChecking=yes` 让探测不等待输入、也不写入 `known_hosts`。
 *
 * @param host - 目标主机名。
 * @returns 参数数组。
 */
function sshProbeArgs(host: string): string[] {
	return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', `git@${host}`];
}

/** 探测结果缓存；一次探测含一次远端连接，同一目标的重复请求不重新探测。 */
let cache: { at: number; key: string; value: SshStatus } | null = null;

/** 就绪结果的缓存时长（毫秒）。 */
const STATUS_TTL_MS = 5 * 60_000;

/** 未就绪结果的缓存时长（毫秒）：用户可能立刻确认指纹或加载私钥，不宜久留。 */
const STATUS_FAILURE_TTL_MS = 15_000;

/**
 * 检测本地 SSH 状态。
 *
 * 依次检测 ssh 客户端、`~/.ssh` 私钥与目标主机的认证；客户端不可用时不发起网络探测。
 * 结果在进程内按探测目标缓存——给了远程地址时按地址，否则按主机名——同一目标的重复请求不重新探测。
 *
 * @param host - 目标主机名，默认 github.com。
 * @param refresh - 为 true 时忽略缓存，重新探测。
 * @param sshUrl - 目标主机的 SSH 远程地址；给定时用它跑 `git ls-remote`，省略时退回 `ssh` 握手。
 * @returns 检测结果。
 */
export async function sshStatus(host = 'github.com', refresh = false, sshUrl = ''): Promise<SshStatus> {
	const target = safeHost(host);
	const url = sshUrl.trim();
	const key = url === '' ? target : url;
	if (!refresh && cache !== null && cache.key === key) {
		const ttl = cache.value.ready ? STATUS_TTL_MS : STATUS_FAILURE_TTL_MS;
		if (Date.now() - cache.at < ttl) return cache.value;
	}
	const value = await sshStatusUncached(target, url);
	cache = { at: Date.now(), key, value };
	return value;
}

/**
 * 探测实现：不带缓存。
 *
 * @param target - 已规范化的目标主机名。
 * @param sshUrl - SSH 远程地址；空串时退回 `ssh` 握手探测。
 * @returns 检测结果。
 */
async function sshStatusUncached(target: string, sshUrl: string): Promise<SshStatus> {
	const versionResult = await runSsh(['-V'], 8000);
	const versionLine = parseSshVersion(versionResult.stdout, versionResult.stderr);
	const installed = versionResult.code === 0 && versionLine !== null && /^OpenSSH/i.test(versionLine);

	let keys: string[] = [];
	try {
		keys = sshKeyNames(await fs.readdir(nodePath.join(os.homedir(), '.ssh')));
	} catch {
		keys = [];
	}

	if (!installed) {
		return {
			installed: false, version: null, keys, host: target, authenticated: false, ready: false,
			message: '未找到 OpenSSH 客户端（ssh），请先安装并加入 PATH。',
		};
	}

	const mode: SshProbeMode = sshUrl === '' ? 'ssh' : 'git';
	const output = mode === 'git'
		? await runGitProbe(sshUrl, PROBE_TIMEOUT_MS)
		: await runSsh(sshProbeArgs(target), PROBE_TIMEOUT_MS);
	const authenticated = isAuthenticated(mode, output.code);
	return {
		installed: true,
		version: versionLine,
		keys,
		host: target,
		authenticated,
		ready: authenticated,
		message: authenticated ? null : sshFailureMessage(output.stdout, output.stderr, target),
	};
}
