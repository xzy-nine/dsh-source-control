/**
 * 远程仓库配置区与 SSH 状态说明。
 */
import React from 'react';
import { Input, SegmentedControl, Button, IconEditOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { showConfirmation, showMessage } from '../ui/dialog.ts';
import { remoteHostOf, remoteProtocolSlot, toHttpsRemoteUrl, toSshRemoteUrl } from '../git/remote-url.ts';
import type { RemoteProtocolSlot } from '../git/remote-url.ts';
import type { SshStatusInfo } from '../api/index.ts';
import type { Remote } from '../shared/types.ts';
import { REMOTE_PROTOCOLS } from './settings-model.ts';
import css from '../css/settings.module.css';

/**
 * SSH 状态的一行说明。
 *
 * @param status - 检测结果。
 * @returns 说明文本。
 */
export function sshStatusText(status: SshStatusInfo): string {
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
export function RemoteConfigSection({ remotes, onDeleteRemote, onAddRemote, onEditRemote, onCheckSsh }: {
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
		{ className: css.setForm },
		React.createElement('label', { className: css.setRowBlock },
			React.createElement('span', { className: css.setRowText }, '名称'),
			React.createElement(Input, { value: name, placeholder: 'origin', onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setName(e.target.value); } }),
		),
		React.createElement('label', { className: css.setRowBlock },
			React.createElement('span', { className: css.setRowText }, 'URL'),
			React.createElement(Input, {
				value: url,
				placeholder: 'https://github.com/owner/repo.git 或 git@github.com:owner/repo.git',
				onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setUrl(e.target.value); },
			}),
		),
		React.createElement('div', { className: css.setRow },
			React.createElement('span', { className: css.setRowText }, '协议'),
			React.createElement(SegmentedControl, {
				id: 'ggg-set-remote-protocol', label: '协议',
				value: remoteProtocolSlot(url) ?? protocolDraft,
				onChange: (next: string) => { void switchFormProtocol(next === 'ssh' ? 'ssh' : 'https'); },
				options: REMOTE_PROTOCOLS,
			}),
		),
		React.createElement('label', { className: css.setRowBlock },
			React.createElement('span', { className: css.setRowText }, '推送 URL（可选）'),
			React.createElement(Input, { value: pushUrl, placeholder: '与抓取 URL 相同时留空', onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setPushUrl(e.target.value); } }),
		),
		React.createElement('div', { className: css.setFormActions },
			React.createElement(Button, { variant: 'primary', size: 'sm', onClick: editing !== null ? submitEdit : submitAdd }, editing !== null ? '保存' : '添加'),
			React.createElement(Button, { variant: 'toolbar', size: 'sm', onClick: () => { setAdding(false); setEditing(null); setName(''); setUrl(''); setPushUrl(''); } }, '取消'),
		),
	);
	const probeHost = remotes.map((remote) => remoteHostOf(remote.url ?? '')).find((host) => host !== '') ?? 'github.com';
	return React.createElement(
		'div',
		null,
		remotes.length > 0
			? React.createElement('div', { className: css.setRemotes },
				...remotes.map((remote) => React.createElement(
					'div',
					{ key: remote.name, className: css.setRemote },
					React.createElement('span', { className: css.setRemoteName }, remote.name),
					React.createElement('span', { className: css.setRemoteUrl }, remote.url ?? ''),
					React.createElement('button', {
						type: 'button', className: css.setRemoteEdit, title: '编辑远程',
						onClick: () => { beginEdit(remote); },
					}, React.createElement(IconEditOutlineRegular, { size: 18 })),
					React.createElement('button', {
						type: 'button', className: css.setRemoteDel, title: '删除远程',
						// 删除远程会改动仓库配置，先确认。
						onClick: async () => {
							const ok = await showConfirmation({
								title: '删除远程', message: `确定删除远程仓库 ${remote.name}？`,
								confirmLabel: '删除', danger: true,
							});
							if (ok) onDeleteRemote(remote.name);
						},
					}, React.createElement(IconTrashOutlineRegular, { size: 13 })),
				)),
			)
			: React.createElement('div', { className: css.setNote }, '没有配置远程仓库'),
		!adding && editing === null
			? React.createElement(Button, { variant: 'outline', size: 'sm', onClick: () => { setAdding(true); } }, '添加远程')
			: form,
		React.createElement('div', { className: css.setFormActions },
			React.createElement(Button, {
				variant: 'toolbar', size: 'sm', disabled: sshBusy,
				onClick: () => { void checkSsh(probeHost, true); },
			}, '检测 SSH 状态'),
		),
		sshNote !== null && React.createElement('div', { className: css.setNote }, sshNote),
	);
}