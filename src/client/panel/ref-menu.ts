/**
 * 引用标记右键菜单：本地分支、远程分支、标签与贮藏。
 */
import {
	applyStash, branchFromStash, checkoutBranch, checkoutCommit, createBranch, deleteBranch,
	deleteRemoteBranch, deleteTag, dropStash, fetchIntoLocalBranch, merge, mergeIntoBranch, popStash,
	pushTag, rebase, renameBranch,
} from '../api.ts';
import { copyText, showContextMenu, type ContextMenuItem } from '../context-menu.ts';
import { showCheckbox, showConfirmation, showMessage, showSelect, showText } from '../dialog.ts';
import type { Commit, Remote } from '../types.ts';

/** 引用菜单识别出的目标。 */
export interface RefMenuTarget {
	/** 引用类型：head / remote / tag / stash。 */
	readonly type: string;
	/** 引用名称。 */
	readonly name: string;
	/** 远程名；远程分支时提供。 */
	readonly remote?: string | null;
}

/** 引用菜单的依赖面。 */
export interface RefMenuDeps {
	/** 当前工作树路径。 */
	readonly workingTreePath: string | null;
	/** 执行一次工作区操作并刷新。 */
	readonly run: (operation: () => Promise<void>) => Promise<void>;
	/** 当前分支名。 */
	readonly head: string | null;
	/** 远端列表。 */
	readonly remotes: readonly Remote[];
	/** 报错提示：依赖 VS Code 的动作在 DSH 中不可用。 */
	readonly unsupported: (label: string) => Promise<void>;
	/** 查看标签详情。 */
	readonly handleTagDetails: (tagName: string, commitHash: string) => Promise<void>;
	/** 创建归档。 */
	readonly handleCreateArchive: (ref: string, refLabel: string) => Promise<void>;
	/** 写入提交信息框；合并到选中分支后填入 git 生成的初始信息。 */
	readonly setCommitMessage: (message: string) => void;
}

/**
 * 分支标签（head / remote / tag / stash）右键菜单。
 *
 * @param deps - 见 {@link RefMenuDeps}。
 * @param args - 目标提交、引用信息与触发事件。
 * @returns 无。
 */
export function openRefMenu(
	deps: RefMenuDeps,
	{ commit, refInfo, event }: { commit: Commit; refInfo: RefMenuTarget; event: React.MouseEvent<HTMLElement> },
): void {
	const { workingTreePath, run, head, remotes, unsupported, handleTagDetails, handleCreateArchive, setCommitMessage } = deps;
	const repo = workingTreePath as string;
	const x = event.clientX, y = event.clientY;
	const target = event.currentTarget;
	target.classList.add('ggg-menu-target');
	const onClose = (): void => target.classList.remove('ggg-menu-target');
	if (refInfo.type === 'head') {
		const name = refInfo.name;
		const isCurrent = name === head;
		// 该提交就是该分支的尖端时才提供合并入口：合并目标由右键所在位置决定，非尖端时无法确定。
		const isTip = (commit.heads ?? []).includes(name);
		showContextMenu({
			x, y, onClose,
			items: [
				{ title: '检出此分支', disabled: isCurrent, onClick: () => { void run(async () => { await checkoutBranch(repo, name, null); }); } },
				{ title: '从此分支创建新分支…', onClick: async () => {
					const newName = await showText({ title: '创建分支', label: '新分支名', value: name, placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void run(async () => { await createBranch(repo, newName, `refs/heads/${name}`, true); });
				} },
				{ title: '重命名分支…', disabled: isCurrent, onClick: async () => {
					const newName = await showText({ title: '重命名分支', label: '新分支名', value: name });
					if (newName !== null && newName !== '' && newName !== name) void run(async () => { await renameBranch(repo, name, newName); });
				} },
				{ title: '合并到选中分支…', visible: !isCurrent && isTip, onClick: async () => {
					const ok = await showConfirmation({
						title: '合并到选中分支',
						message: `检出 ${name}，并把当前分支合并过去，保持未提交状态？`,
						confirmLabel: '合并', danger: true,
					});
					if (!ok) return;
					// 冲突提示放在刷新之后：run 内部先刷新面板，提示框不应挡住刷新。
					let conflicted = false;
					await run(async () => {
						const result = await mergeIntoBranch(repo, name, commit.hash);
						if (result.error !== null) throw new Error(result.error);
						if (result.mergeMessage !== null) setCommitMessage(result.mergeMessage);
						conflicted = result.conflicted;
					});
					if (conflicted) {
						await showMessage({ title: '合并存在冲突', message: '已检出到该分支并保持待合并状态，请在变更列表中解决冲突后再提交。' });
					}
				} },
				{ title: '变基当前分支到此处…', disabled: isCurrent, onClick: async () => {
					const ok = await showConfirmation({ title: '变基', message: `把当前分支变基到 ${name}？`, confirmLabel: '变基', danger: true });
					if (ok) void run(async () => { await rebase(repo, name); });
				} },
				{ type: 'divider' },
				{ title: '复制分支名', onClick: async () => { await copyText(name); } },
				{ title: '创建归档…', onClick: () => { void handleCreateArchive(name, `分支 ${name}`); } },
				{ title: '删除分支…', danger: true, onClick: async () => {
					// 当前分支不可删除：直接说明原因，而不是置灰等 git 报错。
					if (isCurrent) {
						await showMessage({
							title: '无法删除当前分支',
							message: `分支 ${name} 是当前检出的分支，不能删除。\n请先切换到其他分支再删除。`,
						});
						return;
					}
					const ok = await showCheckbox({
						title: '删除本地分支', message: `确定删除本地分支 ${name}？`, checkboxLabel: '同时强制删除未合并分支', danger: true,
					});
					if (ok) void run(async () => { await deleteBranch(repo, name, true); });
				} },
			],
		});
		return;
	}
	if (refInfo.type === 'remote') {
		const name = refInfo.name;
		const short = name.replace(/^[^/]+\//, '');
		showContextMenu({
			x, y, onClose,
			items: [
				{ title: '检出远程分支…', onClick: async () => {
					const localName = await showText({ title: '检出远程分支', label: '本地分支名', value: short, placeholder: 'feature/xxx' });
					if (localName !== null && localName !== '') void run(async () => { await checkoutBranch(repo, localName, name); });
				} },
				{ title: '从远程分支创建本地分支…', onClick: async () => {
					const localName = await showText({ title: '创建本地分支', label: '本地分支名', value: short });
					if (localName !== null && localName !== '') void run(async () => { await fetchIntoLocalBranch(repo, refInfo.remote ?? '', short, localName, false); });
				} },
				{ title: '合并到当前分支…', onClick: async () => {
					const ok = await showConfirmation({ title: '合并', message: `把 ${name} 合并进当前分支？`, confirmLabel: '合并', danger: true });
					if (ok) void run(async () => { await merge(repo, name); });
				} },
				{ title: '变基当前分支到此处…', onClick: async () => {
					const ok = await showConfirmation({ title: '变基', message: `把当前分支变基到 ${name}？`, confirmLabel: '变基', danger: true });
					if (ok) void run(async () => { await rebase(repo, name); });
				} },
				{ type: 'divider' },
				{ title: '删除远程分支…', danger: true, onClick: async () => {
					const ok = await showCheckbox({
						title: '删除远程分支', message: `确定删除远程分支 ${name}？`, checkboxLabel: '我已知晓并继续', danger: true,
					});
					if (ok) void run(async () => { await deleteRemoteBranch(repo, short, refInfo.remote ?? ''); });
				} },
				{ title: '复制远程分支名', onClick: async () => { await copyText(name); } },
			],
		});
		return;
	}
	if (refInfo.type === 'tag') {
		const name = refInfo.name;
		showContextMenu({
			x, y, onClose,
			items: [
				{ title: '检出此标签', onClick: () => { void run(async () => { await checkoutCommit(repo, commit.hash); }); } },
				{ title: '从此标签创建分支…', onClick: async () => {
					const newName = await showText({ title: '创建分支', label: '新分支名', placeholder: 'feature/xxx' });
					if (newName !== null && newName !== '') void run(async () => { await createBranch(repo, newName, commit.hash, true); });
				} },
				{ title: '推送标签到远程…', onClick: async () => {
					if (remotes.length === 0) return unsupported('推送标签');
					const remote = remotes.length === 1 ? remotes[0].name : await showSelect({
						title: '推送标签到远程', options: remotes.map((item) => ({ value: item.name, label: item.name })),
					});
					if (remote !== null && remote !== '') void run(async () => { await pushTag(repo, name, [remote], commit.hash, false); });
				} },
				{ title: '查看标签详情…', onClick: () => { void handleTagDetails(name, commit.hash); } },
				{ title: '创建归档…', onClick: () => { void handleCreateArchive(name, `标签 ${name}`); } },
				{ type: 'divider' },
				{ title: '复制标签名', onClick: async () => { await copyText(name); } },
				{ title: '删除标签…', danger: true, onClick: async () => {
					const ok = await showCheckbox({
						title: '删除标签', message: `确定删除标签 ${name}？`, checkboxLabel: '同时删除远程标签', danger: true,
					});
					if (ok) void run(async () => { await deleteTag(repo, name, remotes.length > 0 ? remotes[0].name : null); });
				} },
			],
		});
		return;
	}
	// stash
	const selector = refInfo.name;
	showContextMenu({
		x, y, onClose,
		items: [
			{ title: '应用贮藏', onClick: () => { void run(async () => { await applyStash(repo, selector, false); }); } },
			{ title: '弹出贮藏', onClick: () => { void run(async () => { await popStash(repo, selector, false); }); } },
			{ title: '从贮藏创建分支…', onClick: async () => {
				const newName = await showText({ title: '从贮藏创建分支', label: '新分支名', placeholder: 'feature/xxx' });
				if (newName !== null && newName !== '') void run(async () => { await branchFromStash(repo, selector, newName); });
			} },
			{ type: 'divider' },
			{ title: '丢弃贮藏…', danger: true, onClick: async () => {
				const ok = await showCheckbox({
					title: '丢弃贮藏', message: `确定丢弃贮藏 ${selector}？`, checkboxLabel: '我已知晓并继续', danger: true,
				});
				if (ok) void run(async () => { await dropStash(repo, selector); });
			} },
			{ title: '复制选择器', onClick: async () => { await copyText(selector); } },
		],
	});
}

/** 一条菜单项的类型别名，供调用方标注。 */
export type { ContextMenuItem };
