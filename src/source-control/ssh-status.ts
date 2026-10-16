/**
 * 本地 SSH 状态检测：ssh 客户端、`~/.ssh` 私钥与对目标主机的认证结果。
 *
 * 探测一律非交互（`BatchMode=yes`）并带连接超时，避免在缺少凭据时挂起等待输入；
 * 检测不写入 `known_hosts` 等本地状态。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

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
	/** 未就绪时的原因说明；就绪时为 null。 */
	readonly message: string | null;
	/** 探测输出的原文，供排查。 */
	readonly detail: string;
}

/** `~/.ssh` 中不作为私钥列出的文件名。 */
const NON_KEY_NAMES = new Set([
	'agent', 'authorized_keys', 'config', 'environment', 'known_hosts', 'known_hosts.old', 'rc', 'ssh_config',
]);

/** 一次 ssh 调用的结果。 */
interface SshResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

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
function runSsh(args: readonly string[], timeoutMs: number): Promise<SshResult> {
	return new Promise((resolve) => {
		const child = spawn('ssh', [...args], {
			windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		/* 超时定时器先创建，finish 里要清掉它；回调在稍后执行，那时 finish 已初始化。 */
		const timer = setTimeout(() => {
			child.kill();
			finish({ code: -1, stdout, stderr: stderr === '' ? 'SSH 探测超时' : stderr });
		}, timeoutMs);
		const finish = (result: SshResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => { stdout += chunk; });
		child.stderr.on('data', (chunk: string) => { stderr += chunk; });
		child.on('error', (error: Error) => { finish({ code: -1, stdout, stderr: stderr !== '' ? stderr : error.message }); });
		child.on('close', (code) => { finish({ code: code === null ? -1 : code, stdout, stderr }); });
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
 * 归类认证探测的输出。
 *
 * @param stdout - 探测的标准输出。
 * @param stderr - 探测的标准错误。
 * @param host - 探测的目标主机名。
 * @returns 是否认证通过，以及未通过时的原因说明。
 */
export function classifySshProbe(stdout: string, stderr: string, host: string): { authenticated: boolean; message: string | null } {
	const text = `${stdout}\n${stderr}`.trim();
	if (/successfully authenticated/i.test(text)) return { authenticated: true, message: null };
	if (/host key verification failed|no .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
		return { authenticated: false, message: `目标主机 ${host} 的指纹尚未确认：请先在终端执行 ssh -T git@${host} 并确认指纹。` };
	}
	if (/permission denied|no supported authentication methods|publickey/i.test(text)) {
		return { authenticated: false, message: `SSH 公钥未被 ${host} 接受：请确认公钥已添加到该主机的账号或部署密钥，或先用 ssh-add 加载私钥。` };
	}
	if (/could not resolve hostname|connection timed out|connection refused|network is unreachable|operation timed out/i.test(text)) {
		return { authenticated: false, message: `无法连接 ${host}：请检查网络、代理或 SSH 配置。` };
	}
	return { authenticated: false, message: text === '' ? `SSH 认证未通过（${host}）。` : text };
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

/** 探测结果缓存；一次探测含一次 ssh 连接，同一进程内不重复请求。 */
let cache: { at: number; host: string; value: SshStatus } | null = null;

/** 就绪结果的缓存时长（毫秒）。 */
const STATUS_TTL_MS = 5 * 60_000;

/** 未就绪结果的缓存时长（毫秒）：用户可能立刻确认指纹或加载私钥，不宜久留。 */
const STATUS_FAILURE_TTL_MS = 15_000;

/**
 * 检测本地 SSH 状态。
 *
 * 依次检测 ssh 客户端、`~/.ssh` 私钥与对目标主机的认证；客户端不可用时不发起网络探测。
 * 结果在进程内按主机缓存，同一主机的重复请求不重新探测。
 *
 * @param host - 目标主机名，默认 github.com。
 * @param refresh - 为 true 时忽略缓存，重新探测。
 * @returns 检测结果。
 */
export async function sshStatus(host = 'github.com', refresh = false): Promise<SshStatus> {
	const target = safeHost(host);
	if (!refresh && cache !== null && cache.host === target) {
		const ttl = cache.value.ready ? STATUS_TTL_MS : STATUS_FAILURE_TTL_MS;
		if (Date.now() - cache.at < ttl) return cache.value;
	}
	const value = await sshStatusUncached(target);
	cache = { at: Date.now(), host: target, value };
	return value;
}

/**
 * 探测实现：不带缓存。
 *
 * @param target - 已规范化的目标主机名。
 * @returns 检测结果。
 */
async function sshStatusUncached(target: string): Promise<SshStatus> {
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
			detail: versionResult.stderr.trim(),
		};
	}

	const probe = await runSsh(
		['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', `git@${target}`],
		20000,
	);
	const verdict = classifySshProbe(probe.stdout, probe.stderr, target);
	return {
		installed: true,
		version: versionLine,
		keys,
		host: target,
		authenticated: verdict.authenticated,
		ready: verdict.authenticated,
		message: verdict.authenticated ? null : verdict.message,
		detail: `${probe.stdout}\n${probe.stderr}`.trim(),
	};
}
