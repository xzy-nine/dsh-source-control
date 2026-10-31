/**
 * 仓库级动作：设置写入、远程与用户身份、忽略规则、克隆、Pull Request、配置导出与归档。
 *
 * 这些动作只依赖当前仓库、仓库信息与面板的 
un/withProgress，集中在一个 hook 里；
 * 过程状态（克隆进行中、用户身份、本地排除条目）也在这里维护。
 */
import React from 'react';
import {
	addRemote, addToGitignore, addToLocalExclude, createArchive, deleteRemote, deleteUserDetails, editRemote,
	editUserDetails, exportRepoConfig, ghAccount, ghCreatePullRequest, ghRepoInfo, loadConfig, throwIfError,
} from '../api/index.ts';
import type { IgnoreWriteResult, LocalExcludeState } from '../api/index.ts';
import { showForm, showSelect, showText } from '../ui/dialog.ts';
import { cloneTerminalCommand } from '../git/clone-command.ts';
import { reportError } from './errors.ts';
import { saveSettings } from './settings.ts';
import { hasGitHubRemote } from './github.ts';
import { textOf, trimmedTextOf } from '../shared/text.ts';
import type { BusyFlags, PanelState, RepoNode, Settings } from '../shared/types.ts';
import type { PanelActionDeps } from './action-deps.ts';

/** 仓库动作的依赖面。 */
export interface RepoCommandDeps {
	/** 会话工作区路径；没有工作区时为 undefined。 */
	readonly cwd: string | undefined;
	/** 当前选中的工作树路径。 */
	readonly workingTreePath: string | null;
	/** 会话 id，克隆命令写进该会话的终端。 */
	readonly sessionId: string;
	/** 当前设置。 */
	readonly settings: Settings;
	/** 设置面板是否展开：展开时读取仓库配置。 */
	readonly settingsOpen: boolean;
	/** 面板状态里的远端列表、当前分支与详情。 */
	readonly remotes: readonly { readonly name: string }[];
	readonly head: string | null;
	readonly detail: { readonly commit: { readonly hash: string; readonly message?: string | null } } | null;
	/** 忙碌分级。 */
	readonly busyFlags: BusyFlags;
	/** 选中仓库节点；克隆时用于预填。 */
	readonly selectedNode: RepoNode | null;
	/** 打开宿主目录选择器。 */
	readonly pickDirectory?: (() => Promise<string | null>) | undefined;
	/** 在侧边栏终端里执行命令。 */
	readonly runInTerminal?: ((sessionId: string, command: string) => Promise<boolean>) | undefined;
	/** 打开一个文件或差异。 */
	readonly openDiff: (hash: string, path: string, staged: boolean, isNew?: boolean, baseHash?: string) => Promise<void>;
	/** 面板动作依赖：run、withProgress 与 notify。 */
	readonly actions: PanelActionDeps;
	/** 面板状态写入器：导出失败时报告。 */
	readonly setState: React.Dispatch<React.SetStateAction<PanelState>>;
	/** 重扫标志：克隆命令写入终端后置位。 */
	readonly rescanPending: React.MutableRefObject<boolean>;
	/** 写入设置。 */
	readonly setSettings: (next: Settings) => void;
}

/** 仓库动作。 */
export interface RepoCommands {
	/** 写入设置并持久化。 */
	readonly changeSettings: (next: Settings) => void;
	/** 删除远程。 */
	readonly deleteRemoteByName: (name: string) => void;
	/** 添加远程。 */
	readonly handleAddRemote: (name: string, url: string, pushUrl: string | null) => void;
	/** 编辑远程。 */
	readonly handleEditRemote: (nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) => void;
	/** 修改用户身份。 */
	readonly handleEditUserDetails: (name: string, email: string, location: string, deleteLocalName: boolean, deleteLocalEmail: boolean) => void;
	/** 删除用户身份。 */
	readonly handleDeleteUserDetails: (delName: boolean, delEmail: boolean, location: string) => void;
	/** 加入 .gitignore。 */
	readonly handleAddToGitignore: (path: string) => void;
	/** 加入本地排除文件。 */
	readonly handleAddToLocalExclude: (path: string) => void;
	/** 打开本地排除文件。 */
	readonly handleShowLocalExclude: () => void;
	/** 克隆远程仓库。 */
	readonly handleClone: () => void;
	/** 创建 Pull Request。 */
	readonly handleCreatePullRequest: () => Promise<void>;
	/** 导出仓库配置。 */
	readonly handleExportConfig: () => Promise<void>;
	/** 创建归档。 */
	readonly handleCreateArchive: (ref: string, refLabel: string) => Promise<void>;
	/** 当前工作树的本地排除条目。 */
	readonly localExclude: LocalExcludeState | null;
	/** 克隆进行中。 */
	readonly cloneBusy: boolean;
	/** 用户身份。 */
	readonly userDetails: { userName?: unknown; userEmail?: unknown } | null;
	/** 设置写入器：设置面板与预取回填共用。 */
	readonly setUserDetails: React.Dispatch<React.SetStateAction<{ userName?: unknown; userEmail?: unknown } | null>>;
	/** 是否可创建 Pull Request。 */
	readonly canCreatePullRequest: boolean;
}

/**
 * 组装仓库级动作。
 *
 * @param deps - 见 {@link RepoCommandDeps}。
 * @returns 仓库动作。
 */
export function useRepoCommands(deps: RepoCommandDeps): RepoCommands {
	const {
		cwd, workingTreePath, sessionId, settingsOpen, remotes, head, detail, busyFlags,
		pickDirectory, runInTerminal, openDiff, actions, setState, rescanPending, setSettings,
	} = deps;
	const { run, withProgress, notify } = actions;
	const [userDetails, setUserDetails] = React.useState<{ userName?: unknown; userEmail?: unknown } | null>(null);
	// 当前工作树的本地排除条目；有内容时提交框显示查看入口。
	const [localExclude, setLocalExclude] = React.useState<LocalExcludeState | null>(null);
	/** 克隆进行中：只禁用克隆入口，不影响面板其余控件。 */
	const [cloneBusy, setCloneBusy] = React.useState(false);
	/** 写入设置并刷新（排序/显示项变化需要重新拉取提交图）。 */
	const changeSettings = React.useCallback((next: Settings) => {
		setSettings(next);
		saveSettings(next);
	}, []);

	/** 删除远程并刷新。 */
	const deleteRemoteByName = React.useCallback((name: string) => {
		void run('history', async () => { throwIfError(await deleteRemote(workingTreePath as string, name)); }, undefined, undefined, { intent: `删除远程 ${name}` });
	}, [workingTreePath, run]);

	/* 打开设置时加载仓库配置（用户身份等）。 */
	React.useEffect(() => {
		if (!settingsOpen || workingTreePath === null) return;
		void (async () => {
			try {
				const cfg = await loadConfig(workingTreePath, remotes.map((remote) => remote.name));
				const user = (cfg.config as { user?: { name?: unknown; email?: unknown } } | undefined)?.user;
				setUserDetails({ userName: user?.name, userEmail: user?.email });
			} catch { /* 加载失败时保留空表单 */ }
		})();
	}, [settingsOpen, workingTreePath, remotes]);

	const reloadUserDetails = async (): Promise<void> => {
		const cfg = await loadConfig(workingTreePath as string, remotes.map((remote) => remote.name));
		const user = (cfg.config as { user?: { name?: unknown; email?: unknown } } | undefined)?.user;
		setUserDetails({ userName: user?.name, userEmail: user?.email });
	};

	const handleEditUserDetails = React.useCallback((name: string, email: string, location: string, deleteLocalName: boolean, deleteLocalEmail: boolean) => {
		void run('history', async () => {
			const errors = await editUserDetails(workingTreePath as string, name, email, location, deleteLocalName, deleteLocalEmail);
			if (errors.length > 0) throw new Error(errors[0]);
			await reloadUserDetails();
		}, undefined, undefined, { intent: `修改用户身份（${location === 'global' ? '全局' : '当前仓库'}）` });
	}, [workingTreePath, run, remotes]);

	const handleDeleteUserDetails = React.useCallback((delName: boolean, delEmail: boolean, location: string) => {
		void run('history', async () => {
			const errors = await deleteUserDetails(workingTreePath as string, delName, delEmail, location);
			if (errors.length > 0) throw new Error(errors[0]);
			await reloadUserDetails();
		}, undefined, undefined, { intent: `删除用户身份（${location === 'global' ? '全局' : '当前仓库'}）` });
	}, [workingTreePath, run, remotes]);

	/** 添加远程并刷新。 */
	const handleAddRemote = React.useCallback((name: string, url: string, pushUrl: string | null) => {
		void run('history', async () => { throwIfError(await addRemote(workingTreePath as string, name, url, pushUrl, false)); }, undefined, undefined, { intent: `添加远程 ${name}` });
	}, [workingTreePath, run]);

	/** 编辑远程并刷新。 */
	const handleEditRemote = React.useCallback((nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) => {
		void run('history', async () => { throwIfError(await editRemote(workingTreePath as string, nameOld, nameNew, urlOld, urlNew, pushUrlOld, pushUrlNew)); }, undefined, undefined, { intent: `编辑远程 ${nameOld}` });
	}, [workingTreePath, run]);

	/**
	 * 把未暂存的路径加入 `.gitignore`，随后打开该文件的差异视图。
	 *
	 * 规则写进最近的 `.gitignore`（没有则在仓库根新建）；新建的文件没有旧侧内容，
	 * 因此按普通文件打开而不是差异。
	 */
	const handleAddToGitignore = React.useCallback((path: string) => {
		void (async () => {
			const written: { value: IgnoreWriteResult | null } = { value: null };
			await run('commit', async () => { written.value = await addToGitignore(workingTreePath as string, path); }, undefined, (entries) => entries.filter((entry) => entry.path !== path), { historyChanged: false, intent: `加入 .gitignore：${path}` });
			const result = written.value;
			if (result === null || result.file === '') return;
			await notify(result.rule === null ? `${result.file} 已包含该忽略规则。` : `已写入 ${result.file}：${result.rule}`);
			await openDiff('*', result.file, false, !result.tracked);
		})();
	}, [run, workingTreePath, openDiff, notify]);

	/**
	 * 把未暂存的路径加入本地排除文件 `.git/info/exclude`，随后打开该文件。
	 *
	 * 该文件在 `.git` 目录内，以宿主返回的绝对路径按普通文件打开。
	 */
	const handleAddToLocalExclude = React.useCallback((path: string) => {
		void (async () => {
			const written: { value: LocalExcludeState | null } = { value: null };
			await run('commit', async () => { written.value = await addToLocalExclude(workingTreePath as string, path); }, undefined, (entries) => entries.filter((entry) => entry.path !== path), { historyChanged: false, intent: `加入本地排除：${path}` });
			const state = written.value;
			// 写入失败时 run 已提示错误：保留原有状态，不清掉已有的查看入口。
			if (state === null || state.path === '') return;
			setLocalExclude(state);
			await openDiff('*', state.path, false, true);
		})();
	}, [run, workingTreePath, openDiff]);

	/** 打开本地排除文件；它在 `.git` 目录内，以绝对路径按普通文件打开。 */
	const handleShowLocalExclude = React.useCallback(() => {
		const state = localExclude;
		if (state === null || state.path === '') return;
		void openDiff('*', state.path, false, true);
	}, [localExclude, openDiff]);

	/**
	 * 克隆远程仓库：先填地址，再选父目录，然后在 DSH 终端里执行克隆命令。
	 *
	 * 克隆由终端承担——进度、凭据提示与交互都在那里，插件不自己跑 git；命令只依赖
	 * `git -C <父目录> clone`，不必切换终端目录。命令写入后置起重扫标志，窗口重新获得
	 * 焦点时重扫一次仓库树。
	 */
	const handleClone = React.useCallback(() => {
		void (async () => {
			if (cwd === undefined) {
				await notify('没有可用的会话工作区，无法克隆。');
				return;
			}
			if (cloneBusy) return;
			const form = await showForm({
				title: '克隆远程仓库',
				message: '输入远程仓库地址，下一步选择存放位置；克隆在 DSH 终端里执行。',
				fields: [
					{ type: 'text', name: 'url', label: '仓库地址', placeholder: 'https://github.com/owner/repo.git 或 git@github.com:owner/repo.git' },
					{ type: 'checkbox', name: 'shallow', label: '浅克隆（只取最近的历史）', value: false },
					{
						type: 'text', name: 'depth', label: '浅克隆深度', value: '1', placeholder: '1',
						visibleWhen: (values) => values.shallow === true,
					},
				],
				confirmLabel: '下一步',
			});
			if (form === null) return;
			const url = trimmedTextOf(form.url);
			if (url === '') return;
			const shallow = form.shallow === true;
			// 深度按正整数处理：0 与非数值都表示不做浅克隆，由 shallowCloneArgs 生成参数。
			const parsedDepth = Number.parseInt(textOf(form.depth), 10);
			const depth = shallow && Number.isInteger(parsedDepth) && parsedDepth > 0 ? parsedDepth : 0;
			if (pickDirectory === undefined) {
				await notify('当前界面没有装载目录选择器，无法选择存放位置。');
				return;
			}
			const parent = await pickDirectory();
			if (parent === null) return;
			const command = cloneTerminalCommand(parent, url, { depth });
			if (command === null) {
				await notify('地址或目录含无法自动转义的字符，请在终端里手动克隆。');
				return;
			}
			if (runInTerminal === undefined) {
				await notify('当前界面没有装载终端，无法在其中克隆。');
				return;
			}
			setCloneBusy(true);
			try {
				const started = await runInTerminal(sessionId, command);
				await notify(started
					? `已在终端执行克隆：${command}`
					: '无法在终端里执行克隆命令，请在终端里手动执行。');
				// 回到本窗口时重扫一次：克隆可能已经完成，也可能还在跑。
				if (started) rescanPending.current = true;
			} finally {
				setCloneBusy(false);
			}
		})();
	}, [cwd, notify, pickDirectory, runInTerminal, sessionId, cloneBusy, rescanPending]);

	/**
	 * 创建 Pull Request：选目标分支、填标题与正文，交给 gh 创建。
	 *
	 * 当前分支没有上游时先说明原因；gh 不可用时给出降级提示而不是静默失败。
	 */
	const handleCreatePullRequest = React.useCallback(async () => {
		if (workingTreePath === null || head === null || busyFlags.network) return;
		const path = workingTreePath;
		const headRef = head;

		const account = await withProgress('network', () => ghAccount(path));
		if (account === null || !account.loggedIn) {
			await notify('未检测到可用的 GitHub 登录，请先运行 gh auth login。');
			return;
		}
		const blocked = account.unavailable.find((item) => item.feature === 'create-pr');
		if (blocked !== undefined) {
			await notify(blocked.message);
			return;
		}

		const info = await withProgress('network', () => ghRepoInfo(path));
		const branches = (info?.branches ?? []).filter((name) => name !== headRef);
		if (branches.length === 0) {
			await notify('没有可作为目标的分支，请先把分支推送到远程。');
			return;
		}
		const base = info?.defaultBranch !== null && info?.defaultBranch !== undefined && branches.includes(info.defaultBranch)
			? info.defaultBranch
			: branches[0];
		const form = await showForm({
			title: '创建 Pull Request',
			message: `把 ${headRef} 合并到目标分支。`,
			fields: [
				{ type: 'select', name: 'base', label: '目标分支', value: base, options: branches.map((name) => ({ value: name, label: name })) },
				{ type: 'text', name: 'title', label: '标题', value: detail !== null && detail.commit.hash !== '*' ? (detail.commit.message ?? '') : '', placeholder: 'PR 标题' },
				{ type: 'textarea', name: 'body', label: '正文（可选）', placeholder: '' },
				{ type: 'checkbox', name: 'draft', label: '创建为草稿', value: false },
			],
		});
		if (form === null) return;
		const title = trimmedTextOf(form.title);
		if (title === '') return;
		await run('network', async () => {
			const url = await ghCreatePullRequest(path, {
				head: headRef,
				base: textOf(form.base, base),
				title,
				body: textOf(form.body),
				draft: form.draft === true,
			});
			await notify(url === '' ? 'Pull Request 已创建。' : `Pull Request 已创建：${url}`);
		}, undefined, undefined, { intent: `创建 Pull Request：${title}` });
	}, [workingTreePath, head, busyFlags.network, detail, run, notify, withProgress]);

	/** 导出仓库配置为 JSON 文件下载。 */
	const handleExportConfig = React.useCallback(async () => {
		if (workingTreePath === null) return;
		try {
			const config = await exportRepoConfig(workingTreePath);
			if (config === null) return;
			const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'source-control-config.json';
			a.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			reportError(setState, error instanceof Error ? error.message : String(error));
		}
	}, [workingTreePath, setState]);


	/** 创建归档。 */
	const handleCreateArchive = React.useCallback(async (ref: string, refLabel: string) => {
		const format = await showSelect({
			title: '创建归档',
			message: `从 ${refLabel} 创建归档`,
			options: [
				{ value: 'zip', label: 'zip' },
				{ value: 'tar', label: 'tar' },
				{ value: 'tgz', label: 'tar.gz' },
			],
			value: 'zip',
		});
		if (format === null) return;
		const defaultName = `${ref.replace(/[^a-zA-Z0-9._-]/g, '-')}.${format}`;
		const outputPath = await showText({
			title: '归档输出路径',
			label: '文件路径',
			placeholder: defaultName,
			value: defaultName,
		});
		if (outputPath === null || outputPath === '') return;
		void run('read', async () => {
			const err = await createArchive(workingTreePath as string, ref, format, outputPath);
			if (err !== null) reportError(setState, err);
		}, undefined, undefined, { intent: `导出归档 ${ref}` });
	}, [workingTreePath, run, setState]);
	const canCreatePullRequest = hasGitHubRemote(remotes) && head !== null;

	return {
		changeSettings, deleteRemoteByName, handleAddRemote, handleEditRemote, handleEditUserDetails,
		handleDeleteUserDetails, handleAddToGitignore, handleAddToLocalExclude, handleShowLocalExclude,
		handleClone, handleCreatePullRequest, handleExportConfig, handleCreateArchive,
		localExclude, cloneBusy, userDetails, setUserDetails, canCreatePullRequest,
	};
}