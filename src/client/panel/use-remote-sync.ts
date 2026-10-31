/**
 * 远程相关动作：SSH 校验、发布、同步、双向覆盖与同步按钮的右键菜单。
 *
 * 这些动作只依赖当前仓库、远端列表、推送钩子勾选与面板的 run/withProgress，
 * 因此集中在一个 hook 里；面板只接线，不持有过程状态。
 */
import React from 'react';
import {
	addRemote, fetchRepo, ghAccount, ghCreateRepo, merge, pushBranch, pushUpstream, resetToCommit,
	sshStatus, throwIfError,
} from '../api/index.ts';
import type { SshStatusInfo } from '../api/index.ts';
import { showCheckbox, showMessage, showSelect, showTabbedForm, type FormPage } from '../ui/dialog.ts';
import { showContextMenu } from '../ui/context-menu.ts';
import { remoteHostOf, toHttpsRemoteUrl, toSshRemoteUrl } from '../git/remote-url.ts';
import { checkoutFailureText } from './git-messages.ts';
import { REMOTE_PROTOCOLS } from './settings-model.ts';
import { textOf, trimmedTextOf } from '../shared/text.ts';
import type { BusyFlags, RepoSync, Settings } from '../shared/types.ts';
import type { PanelActionDeps } from './action-deps.ts';

/** 远程动作的依赖面。 */
export interface RemoteSyncDeps {
	/** 当前选中的工作树路径。 */
	readonly workingTreePath: string | null;
	/** 所属仓库节点名称；发布时预填仓库名。 */
	readonly selectedRepoName: string;
	/** 当前分支的领先/落后与上游。 */
	readonly currentSync: RepoSync | undefined;
	/** 面板状态里的远端列表与当前分支名。 */
	readonly remotes: readonly { readonly name: string; readonly url?: string | null }[];
	readonly head: string | null;
	/** 当前设置。 */
	readonly settings: Settings;
	/** 忙碌分级。 */
	readonly busyFlags: BusyFlags;
	/** 推送钩子是否激活。 */
	readonly pushHookActive: boolean;
	/** 本次是否运行钩子。 */
	readonly runHooks: boolean;
	/** 操作结束复位钩子勾选。 */
	readonly setRunHooks: (next: boolean) => void;
	/** 面板动作依赖：run、withProgress 与 notify。 */
	readonly actions: PanelActionDeps;
}

/** 远程动作。 */
export interface RemoteSync {
	/** 读取本地 SSH 状态。 */
	readonly handleCheckSsh: (host: string, refresh?: boolean) => Promise<SshStatusInfo | null>;
	/** 发布当前本地分支。 */
	readonly handlePublish: () => void;
	/** 同步：抓取后按领先/落后合并或推送。 */
	readonly handleSync: () => void;
	/** 同步按钮的右键菜单。 */
	readonly handleSyncContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
	/** 推送某个仓库的当前分支到其上游，失败时报错。 */
	readonly pushCurrentBranch: (repoPath?: string, skipHooks?: boolean) => Promise<void>;
	/** 是否可用同步按钮的右键覆盖项。 */
	readonly overwriteChoicesAvailable: boolean;
}

/**
 * 组装远程动作。
 *
 * @param deps - 见 {@link RemoteSyncDeps}。
 * @returns 远程动作。
 */
export function useRemoteSync(deps: RemoteSyncDeps): RemoteSync {
	const {
		workingTreePath, selectedRepoName, currentSync, remotes, head, settings, busyFlags,
		pushHookActive, runHooks, setRunHooks, actions,
	} = deps;
	const { run, withProgress, notify } = actions;

	/**
	 * 推送某个仓库的当前分支到其上游，失败时报错。
	 *
	 * `pushUpstream` 把失败放在返回值里而不抛错，因此这里显式检查，避免静默失败。
	 * 未配置远程或当前分支没有上游时，git 给出的是多行长文，这里替换为可读提示；
	 * 这两类提示按 git 的实际措辞匹配，措辞变化时退回原文。
	 *
	 * @param repoPath - 目标仓库路径；省略时用当前选中的工作树。
	 * @param skipHooks - 是否跳过推送钩子（`--no-verify`）。
	 * @returns 无。
	 */
	const pushCurrentBranch = React.useCallback(async (repoPath?: string, skipHooks = false): Promise<void> => {
		const error = await pushUpstream(repoPath ?? (workingTreePath as string), skipHooks);
		if (error === null) return;
		if (/no configured push destination|no configured remote/i.test(error)) {
			throw new Error('未配置远程仓库，请先在设置中添加远程。');
		}
		if (/has no upstream branch/i.test(error)) {
			throw new Error('当前分支没有上游分支，请先设置上游后再推送。');
		}
		throw new Error(error);
	}, [workingTreePath]);

	/**
	 * 读取本地 SSH 状态；结果由宿主按主机缓存，设置面板与发布流程共用这一入口。
	 *
	 * @param host - 目标主机名。
	 * @param refresh - 为 true 时忽略宿主缓存重新探测。
	 * @returns SSH 状态；没有工作区或请求失败时为 null。
	 */
	const handleCheckSsh = React.useCallback(async (host: string, refresh = false) => (
		workingTreePath === null ? null : withProgress('network', () => sshStatus(workingTreePath, host, refresh))
	), [workingTreePath, withProgress]);

	/**
	 * 校验目标主机的 SSH 可用性：客户端、私钥与认证。
	 *
	 * @param host - 目标主机名。
	 * @returns 就绪时为 true；否则说明原因并返回 false。
	 */
	const ensureSshReady = React.useCallback(async (host: string): Promise<boolean> => {
		const status = await handleCheckSsh(host);
		if (status !== null && status.ready) return true;
		await showMessage({
			title: 'SSH 未就绪',
			message: status === null ? '无法获取本地 SSH 状态，请稍后重试。' : status.message ?? `本地 SSH 无法用于 ${status.host}。`,
		});
		return false;
	}, [handleCheckSsh]);

	const askRemoteSource = React.useCallback(async (branch: string): Promise<
		| { kind: 'manual'; name: string; url: string; protocol: 'https' | 'ssh' }
		| { kind: 'github'; owner: string; name: string; private: boolean; description: string; protocol: 'https' | 'ssh' }
		| null
	> => {
		const account = await withProgress('network', () => ghAccount(workingTreePath as string));
		const ghReady = account !== null && account.loggedIn
			&& account.owners.length > 0
			&& !account.unavailable.some((item) => item.feature === 'create-repo');
		// 仓库名预填存储库区域显示的名称，即所选节点的末段目录名。
		const repoName = selectedRepoName;
		const user = account?.user ?? '';
		const orgs = (account?.owners ?? []).filter((owner) => owner !== user);
		const protocolField = {
			type: 'select' as const, name: 'protocol', label: '协议', value: 'https', options: REMOTE_PROTOCOLS,
		};

		const manualPage: FormPage = {
			value: 'manual',
			label: '手动输入地址',
			message: '填写已有远程仓库的地址。',
			fields: [
				{ type: 'text', name: 'name', label: '远程名', value: 'origin', placeholder: 'origin' },
				{ type: 'text', name: 'url', label: '远程地址', placeholder: 'https://github.com/owner/repo.git 或 git@github.com:owner/repo.git' },
				protocolField,
			],
		};
		const unavailableNote = account !== null && account.loggedIn
			? account.unavailable.find((item) => item.feature === 'create-repo')?.message ?? ''
			: '未检测到可用的 GitHub 登录，请先运行 gh auth login。';

		const pages: [FormPage, ...FormPage[]] = ghReady
			? [
				{
					value: 'github',
					label: '新建 GitHub 仓库',
					message: `仓库将创建在所选账号下，并把分支 ${branch} 推送上去。`,
					fields: [
						{
							// 账户类型决定下一级：个人账号直接用当前账号，组织再选具体组织。
							// 没有加入任何组织时不显示该字段，避免出现无选项的分支。
							type: 'select', name: 'accountType', label: '账户类型', value: 'user',
							options: [
								{ value: 'user', label: `个人（${user}）` },
								{ value: 'org', label: '组织' },
							],
							visibleWhen: () => orgs.length > 0,
						},
						{
							type: 'dropdown', name: 'owner', label: '组织', value: orgs[0] ?? '',
							options: orgs.map((org) => ({ value: org, label: org })),
							visibleWhen: (values: Record<string, unknown>) => orgs.length > 0 && values.accountType === 'org',
						},
						{ type: 'text', name: 'name', label: '仓库名', value: repoName, placeholder: 'my-repo' },
						{
							type: 'select', name: 'visibility', label: '可见性', value: 'private', options: [
								{ value: 'private', label: '私有' },
								{ value: 'public', label: '公开' },
							],
						},
						protocolField,
						{ type: 'text', name: 'description', label: '简介（可选）', placeholder: '' },
					],
				},
				manualPage,
			]
			: [
				{
					...manualPage,
					message: `当前仓库还没有远程仓库，请输入地址后发布。\n${unavailableNote}`.trim(),
				},
			];

		const form = await showTabbedForm({ title: '发布', pages, confirmLabel: '发布' });
		if (form === null) return null;
		if (form.page === 'github') {
			const name = trimmedTextOf(form.name);
			if (name === '') return null;
			// 个人账号固定为当前登录用户；组织取所选组织。组织为空时退回个人账号。
			const chosenOrg = trimmedTextOf(form.owner);
			const owner = form.accountType === 'org' && chosenOrg !== '' ? chosenOrg : user;
			if (owner === '') return null;
			// 选 SSH 时先确认本机可认证，避免仓库已建好却推送失败。
			if (form.protocol === 'ssh' && !await ensureSshReady('github.com')) return null;
			return {
				kind: 'github',
				owner,
				name,
				private: textOf(form.visibility, 'private') !== 'public',
				description: trimmedTextOf(form.description),
				protocol: form.protocol === 'ssh' ? 'ssh' : 'https',
			};
		}
		const name = trimmedTextOf(form.name) === '' ? 'origin' : trimmedTextOf(form.name);
		let url = trimmedTextOf(form.url);
		if (url === '') return null;
		if (form.protocol === 'ssh') {
			const sshUrl = toSshRemoteUrl(url);
			if (sshUrl === null) {
				await showMessage({ title: '无法转换', message: '该地址不是 HTTP(S) 或 SSH 形态的远程地址，无法按 SSH 发布。' });
				return null;
			}
			const host = remoteHostOf(url);
			if (sshUrl !== url && !await ensureSshReady(host === '' ? 'github.com' : host)) return null;
			url = sshUrl;
		} else {
			// 选择 HTTPS 时把 SSH 形态的地址换算回 HTTPS；不可换算的地址按原样使用。
			url = toHttpsRemoteUrl(url) ?? url;
		}
		return { kind: 'manual', name, url, protocol: form.protocol === 'ssh' ? 'ssh' : 'https' };
	}, [workingTreePath, selectedRepoName, withProgress, ensureSshReady]);

	/**
	 * 发布当前本地分支：推送到选定远程并建立上游。
	 *
	 * 单一远程直接推送；多个远程弹窗选择；没有远程时可选 GitHub 建仓或手工输入地址。
	 */
	const handlePublish = React.useCallback(() => {
		if (busyFlags.network || workingTreePath === null || currentSync === undefined || currentSync.branch === null) return;
		const branch = currentSync.branch;
		const path = workingTreePath;
		// 推送钩子激活且取消勾选时本次跳过；推送完成后回到默认勾选。
		const skipHooks = pushHookActive && !runHooks;
		const publishDone = (): void => { setRunHooks(true); };
		void (async () => {
			let remote = '';
			if (remotes.length === 1) {
				remote = remotes[0].name;
			} else if (remotes.length > 1) {
				const picked = await showSelect({
					title: '发布到远程仓库',
					message: `把分支 ${branch} 推送到哪个远程仓库？`,
					options: remotes.map((item) => ({ value: item.name, label: `${item.name}${item.url !== undefined && item.url !== '' ? `（${item.url}）` : ''}` })),
				});
				if (picked === null || picked === '') return;
				remote = picked;
			} else {
				const source = await askRemoteSource(branch);
				if (source === null) return;
				if (source.kind === 'github') {
					await run('network', async () => {
						const url = await ghCreateRepo(path, {
							name: source.name, owner: source.owner, private: source.private, description: source.description,
							protocol: source.protocol,
						});
						await notify(`已发布到 ${url}`);
					}, undefined, undefined, { intent: '发布到 GitHub 新仓库' });
					return;
				}
				await run('network', async () => {
					const addError = await addRemote(path, source.name, source.url, null, false);
					if (addError !== null) throw new Error(addError);
					const errors = await pushBranch(path, branch, [source.name], skipHooks);
					if (errors.length > 0) throw new Error(errors.join('\n'));
				}, undefined, undefined, { intent: '添加远程并推送（发布）' });
				publishDone();
				return;
			}
			await run('network', async () => {
				const errors = await pushBranch(path, branch, [remote], skipHooks);
				if (errors.length > 0) throw new Error(errors.join('\n'));
			}, undefined, undefined, { intent: `推送分支 ${branch}` });
			publishDone();
		})();
	}, [busyFlags.network, remotes, currentSync, workingTreePath, run, askRemoteSource, notify, pushHookActive, runHooks, setRunHooks]);

	const handleSync = (): void => {
		if (busyFlags.network || workingTreePath === null) return;
		const skipHooks = pushHookActive && !runHooks;
		void run('network', async () => {
			await fetchRepo(workingTreePath, null, settings.fetchAndPrune, settings.fetchAndPruneTags);
			if (currentSync !== undefined && currentSync.behind > 0 && currentSync.upstream !== null) {
				throwIfError(await merge(workingTreePath, currentSync.upstream), checkoutFailureText);
			}
			if (currentSync !== undefined && currentSync.ahead > 0 && head !== null) {
				await pushCurrentBranch(undefined, skipHooks);
			}
		}, undefined, undefined, { intent: '同步（抓取 + 合并或推送）' }).finally(() => { setRunHooks(true); });
	};

	/**
	 * 把上游名拆成远程名与分支名。
	 *
	 * 上游记作 `<远程>/<分支>`（如 `origin/main`），远程名可能含斜杠以外字符；
	 * 没有斜杠时无法判定远程，返回 null。
	 *
	 * @param upstream - 上游引用名。
	 * @returns 远程名与该远程上的分支名。
	 */
	const upstreamPartsOf = (upstream: string | null): { remote: string; branch: string } | null => {
		if (upstream === null) return null;
		const at = upstream.indexOf('/');
		if (at <= 0 || at === upstream.length - 1) return null;
		return { remote: upstream.slice(0, at), branch: upstream.slice(at + 1) };
	};

	/**
	 * 取当前分支与其上游的拆分结果；不可用时为 null。
	 *
	 * 两项「整体覆盖」都要先做这一判定：本地与上游都必须存在，且都带分支名。
	 *
	 * @returns 上游拆分与本地分支名；不可用时为 null。
	 */
	const overwriteTarget = (): { readonly sync: RepoSync; readonly path: string; readonly parts: { remote: string; branch: string } } | null => {
		const sync = currentSync;
		const parts = sync === undefined ? null : upstreamPartsOf(sync.upstream);
		if (sync === undefined || workingTreePath === null || parts === null || sync.branch === null) return null;
		return { sync, path: workingTreePath, parts };
	};

	/** 用本地分支覆盖远程分支：远程独有的提交会被丢弃。 */
	const overwriteRemoteWithLocal = React.useCallback(() => {
		const target = overwriteTarget();
		if (target === null) return;
		const { sync, path, parts } = target;
		const branch = sync.branch as string;
		const skipHooks = pushHookActive && !runHooks;
		void (async () => {
			const ok = await showCheckbox({
				title: '用本地覆盖远程',
				message: `把本地 ${branch} 强制推送到 ${parts.remote}/${parts.branch}：远程分支上独有的 ${String(sync.behind)} 个提交会被丢弃，推送后无法恢复。`,
				checkboxLabel: '我确认用本地分支覆盖远程分支',
				confirmLabel: '覆盖远程', danger: true,
			});
			if (!ok) return;
			await run('network', async () => {
				const errors = await pushBranch(path, branch, [parts.remote], skipHooks, 'force');
				if (errors.length > 0) throw new Error(errors.join('\n'));
			}, undefined, undefined, { intent: '用本地覆盖远程（强制推送）' });
		})();
	}, [currentSync, workingTreePath, pushHookActive, runHooks, run]);

	/** 用远程分支覆盖本地分支：本地独有的提交与已跟踪改动会被丢弃。 */
	const overwriteLocalWithRemote = React.useCallback(() => {
		const target = overwriteTarget();
		if (target === null) return;
		const { sync, path, parts } = target;
		const upstream = sync.upstream as string;
		const branch = sync.branch as string;
		void (async () => {
			const ok = await showCheckbox({
				title: '用远程覆盖本地',
				message: `把本地 ${branch} 重置到 ${upstream}：本地独有的 ${String(sync.ahead)} 个提交与已跟踪文件的未提交改动都会被丢弃（未跟踪文件保留），重置后无法恢复。`,
				checkboxLabel: '我确认用远程分支覆盖本地分支',
				confirmLabel: '覆盖本地', danger: true,
			});
			if (!ok) return;
			await run('history', async () => {
				await fetchRepo(path, parts.remote, settings.fetchAndPrune, settings.fetchAndPruneTags);
				const error = await resetToCommit(path, upstream, 'hard');
				if (error !== null) throw new Error(error);
			}, undefined, undefined, { intent: '用远程覆盖本地（硬重置）' });
		})();
	}, [currentSync, workingTreePath, run, settings.fetchAndPrune, settings.fetchAndPruneTags]);

	/** 同步按钮的右键菜单：双向分叉时给出两种整体覆盖。 */
	const handleSyncContextMenu = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
		const { clientX, clientY } = event;
		const upstream = currentSync?.upstream ?? '';
		showContextMenu({
			x: clientX, y: clientY,
			items: [
				{
					title: '用本地覆盖远程（强制推送）', danger: true,
					hint: upstream === '' ? undefined : `把本地分支强推到 ${upstream}`,
					onClick: () => { overwriteRemoteWithLocal(); },
				},
				{
					title: '用远程覆盖本地（硬重置）', danger: true,
					hint: upstream === '' ? undefined : `把本地分支重置到 ${upstream}`,
					onClick: () => { overwriteLocalWithRemote(); },
				},
			],
		});
	}, [currentSync, overwriteRemoteWithLocal, overwriteLocalWithRemote]);

	const overwriteChoicesAvailable = leadGapOf(currentSync);

	return {
		handleCheckSsh, handlePublish, handleSync, handleSyncContextMenu, overwriteChoicesAvailable, pushCurrentBranch,
	};
}

/**
 * 本地与上游是否各有对方没有的提交。
 *
 * @param sync - 当前分支的同步状态。
 * @returns 双向分叉时为 true。
 */
function leadGapOf(sync: RepoSync | undefined): boolean {
	return sync !== undefined && sync.ahead > 0 && sync.behind > 0;
}