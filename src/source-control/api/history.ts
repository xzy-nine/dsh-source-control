/**
 * 分支、提交、标签与远程写操作命令：检出、创建、删除、重命名、拉取、推送、合并、变基、重置、拣选、变基、
 * 标签增删、抓取与远程配置。
 */
import {
	abortMerge, addRemote, addTag, checkoutBranch, checkoutCommit, cherrypickCommit, createBranch,
	deleteBranch, deleteRemote, deleteRemoteBranch, deleteTag, dropCommit, editRemote, fetch,
	applyStash, branchFromStash, dropStash, fetchIntoLocalBranch, merge, mergeCurrentIntoBranch, popStash, pruneRemote, pullBranch, pushBranchToMultipleRemotes,
	pushStash, pushTag, pushUpstream, rebase, renameBranch, resetToCommit, revertCommit,
} from '../git-actions.js';
import { notifyRepositoryWrite, runGit } from '../git-exec.js';
import { logDebug, logInfo } from '../logger.js';
import type { ApiContext } from './context.js';

/**
 * 读全部引用的签名。
 *
 * 抓取只改动引用与 `FETCH_HEAD`；签名前后一致即表示本次抓取没有拉回任何东西，
 * 不必让面板重取，也不必作废缓存。
 *
 * @param repo - 仓库路径。
 * @returns 引用名与哈希的拼接串；读取失败时为空串。
 */
async function refsSignature(repo: string): Promise<string> {
	const result = await runGit(['for-each-ref', '--format=%(refname)%00%(objectname)'], repo);
	return result.code === 0 ? result.stdout : '';
}

/**
 * 处理分支、提交、标签与远程写操作的一条命令。
 *
 * @param ctx - 命令上下文。
 * @returns 是否已处理；未识别的命令返回 false。
 */
export async function handleHistoryCommand(ctx: ApiContext): Promise<boolean> {
	const { msg, repo, str, strOrNull, bool, num, arr, isRepoPath, respond, respondResult, respondResultSync, respondError } = ctx;
	void respondResultSync;
	switch (ctx.command) {
		/* --- 分支操作 --- */
		case 'checkoutBranch': {
			const branchName = str('branchName');
			const errors: unknown[] = [await checkoutBranch(repo, branchName, strOrNull('remoteBranch'))];
			const pull = msg.pullAfterwards as Record<string, unknown> | null;
			if (errors[0] === null && pull) {
				errors.push(await pullBranch(repo, String(pull.branchName), String(pull.remote), Boolean(pull.createNewCommit), Boolean(pull.squash)));
			}
			if (errors.every((error) => error === null)) logInfo('repo', `已检出分支：${branchName}${pull ? '（并拉取）' : ''}`);
			respond({ command: 'checkoutBranch', pullAfterwards: msg.pullAfterwards ?? null, errors });
			break;
		}
		case 'createBranch':
			respond({ command: 'createBranch', errors: await createBranch(repo, str('branchName'), str('commitHash'), bool('checkout'), bool('force')) });
			break;
		case 'deleteBranch': {
			const branchName = str('branchName');
			const forceDelete = bool('forceDelete');
			const errors: unknown[] = [await deleteBranch(repo, branchName, forceDelete)];
			if (errors[0] === null) {
				logInfo('repo', `已删除本地分支${forceDelete ? '（强制）' : ''}：${branchName}`);
				for (const remote of arr<string>('deleteOnRemotes')) {
					errors.push(await deleteRemoteBranch(repo, branchName, remote));
				}
			}
			respond({ command: 'deleteBranch', repo, branchName: str('branchName'), deleteOnRemotes: arr('deleteOnRemotes'), errors });
			break;
		}
		case 'deleteRemoteBranch':
			await respondError('deleteRemoteBranch', () => deleteRemoteBranch(repo, str('branchName'), str('remote')));
			break;
		case 'renameBranch':
			await respondError('renameBranch', () => renameBranch(repo, str('oldName'), str('newName')));
			break;
		case 'fetchIntoLocalBranch':
			await respondError('fetchIntoLocalBranch', () => fetchIntoLocalBranch(repo, str('remote'), str('remoteBranch'), str('localBranch'), bool('force')));
			break;
		case 'pullBranch':
			await respondError('pullBranch', () => pullBranch(repo, str('branchName'), str('remote'), bool('createNewCommit'), bool('squash')));
			break;
		case 'pushBranch':
			respond({
				command: 'pushBranch',
				willUpdateBranchConfig: bool('willUpdateBranchConfig'),
				errors: await pushBranchToMultipleRemotes(repo, str('branchName'), arr('remotes'), bool('setUpstream'), (typeof msg.mode === 'string' ? msg.mode : '') as never, bool('skipHooks')),
			});
			break;
		case 'pushUpstream':
			await respondError('pushUpstream', () => pushUpstream(repo, bool('skipHooks')));
			break;

		/* --- 提交操作 --- */
		case 'checkoutCommit':
			await respondError('checkoutCommit', () => checkoutCommit(repo, str('commitHash')));
			break;
		case 'cherrypickCommit':
			respond({ command: 'cherrypickCommit', errors: [await cherrypickCommit(repo, str('commitHash'), num('parentIndex'), bool('recordOrigin'), bool('noCommit'))] });
			break;
		case 'dropCommit':
			await respondError('dropCommit', () => dropCommit(repo, str('commitHash')));
			break;
		case 'resetToCommit':
			await respondError('resetToCommit', () => resetToCommit(repo, str('commit'), (typeof msg.resetMode === 'string' ? msg.resetMode : 'mixed') as never));
			break;
		case 'revertCommit':
			await respondError('revertCommit', () => revertCommit(repo, str('commitHash'), num('parentIndex')));
			break;
		case 'merge': {
			const obj = str('obj');
			const error = await merge(repo, obj, typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch', bool('createNewCommit'), bool('squash'), bool('noCommit'));
			if (error === null) logInfo('repo', `已合并：${obj}`);
			respond({
				command: 'merge',
				actionOn: msg.actionOn,
				error,
			});
			break;
		}
		case 'abortMerge':
			await respondResult('abortMerge', async () => {
				const error = await abortMerge(repo);
				if (error !== null) throw new Error(error);
				return { repo };
			});
			break;
		case 'mergeIntoBranch': {
			const branchName = str('branchName');
			const commitHash = str('commitHash');
			// 选中分支必须存在，且被右键的提交就是它的尖端：否则合并的目标不是用户所指的位置。
			const tip = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], repo);
			const tipHash = tip.code === 0 ? tip.stdout.trim() : '';
			if (tipHash === '') {
				respond({ command: 'mergeIntoBranch', error: '选中的分支不存在。', branchName, mergeMessage: null, conflicted: false });
				break;
			}
			if (commitHash !== '' && tipHash !== commitHash) {
				respond({
					command: 'mergeIntoBranch', branchName, mergeMessage: null, conflicted: false,
					error: '该提交不是选中分支的尖端，无法执行合并。',
				});
				break;
			}
			respond({ command: 'mergeIntoBranch', ...(await mergeCurrentIntoBranch(repo, branchName, str('message'))) });
			break;
		}
		case 'rebase': {
			const obj = str('obj');
			const error = await rebase(repo, obj, typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch', bool('ignoreDate', true), bool('interactive'));
			if (error === null) logInfo('repo', `已变基到：${obj}`);
			respond({ command: 'rebase', actionOn: msg.actionOn, interactive: bool('interactive'), error });
			break;
		}

		/* --- 标签 --- */
		case 'addTag': {
			const errors: unknown[] = [await addTag(repo, str('tagName'), str('commitHash'), typeof msg.type === 'number' ? msg.type : 0, str('message'), bool('force'))];
			if (errors[0] === null && strOrNull('pushToRemote') !== null) {
				errors.push(...(await pushTag(repo, str('tagName'), [str('pushToRemote')], str('commitHash'), bool('pushSkipRemoteCheck'))));
			}
			respond({ command: 'addTag', repo, tagName: str('tagName'), pushToRemote: strOrNull('pushToRemote'), commitHash: str('commitHash'), errors });
			break;
		}
		case 'deleteTag':
			await respondError('deleteTag', () => deleteTag(repo, str('tagName'), strOrNull('deleteOnRemote')));
			break;
		/* --- 远程 --- */
		case 'fetch': {
			const remoteName = strOrNull('name');
			const pruneRemotes = bool('prune');
			const pruneAllTags = bool('pruneTags');
			// 非仓库路径抓不了：直接回未变化，不起 git fetch 与两次 for-each-ref。
			if (!(await isRepoPath(repo))) {
				logDebug('repo', `目标路径不是 git 仓库，跳过抓取：${repo}`);
				respondResultSync('fetch', { repo, changed: false });
				break;
			}
			await respondResult('fetch', async () => {
				/*
				 * 抓取前后比一次引用：远端没有新东西时这次抓取不改变任何可见状态。
				 *
				 * 不比较的话，自动抓取（默认每 180s 一轮）会让所有面板每轮都重取一次提交图
				 * 与工作区，而实际上什么都没变。抓取本身要几秒，两次 `for-each-ref` 的代价可忽略。
				 */
				const before = await refsSignature(repo);
				const error = await fetch(repo, remoteName, pruneRemotes, pruneAllTags, true);
				if (error !== null) throw new Error(error);
				const after = await refsSignature(repo);
				const changed = before !== after;
				// 抓取以 quietWrite 执行：确有改动才补发写事件，否则面板不会白刷新。
				if (changed) notifyRepositoryWrite(repo);
				logInfo('repo', `已抓取远程${remoteName === null ? '（全部）' : `：${remoteName}`}${changed ? '，引用有更新' : '，引用无变化'}`);
				return { repo, changed };
			});
			break;
		}
		case 'addRemote':
			await respondError('addRemote', () => addRemote(repo, str('name'), str('url'), strOrNull('pushUrl'), bool('fetch')));
			break;
		case 'deleteRemote':
			await respondError('deleteRemote', () => deleteRemote(repo, str('name')));
			break;
		case 'editRemote':
			await respondError('editRemote', () => editRemote(repo, str('nameOld'), str('nameNew'), strOrNull('urlOld'), strOrNull('urlNew'), strOrNull('pushUrlOld'), strOrNull('pushUrlNew')));
			break;
		case 'pruneRemote':
			await respondError('pruneRemote', () => pruneRemote(repo, str('name')));
			break;

		/* --- Stash --- */
		case 'applyStash':
			await respondError('applyStash', () => applyStash(repo, str('selector'), bool('reinstateIndex')));
			break;
		case 'branchFromStash':
			await respondError('branchFromStash', () => branchFromStash(repo, str('selector'), str('branchName')));
			break;
		case 'dropStash':
			await respondError('dropStash', () => dropStash(repo, str('selector')));
			break;
		case 'popStash':
			await respondError('popStash', () => popStash(repo, str('selector'), bool('reinstateIndex')));
			break;
		case 'pushStash':
			await respondResult('pushStash', async () => {
				const message = str('message');
				const error = await pushStash(repo, message, bool('includeUntracked', true));
				if (error !== null) throw new Error(error);
				logInfo('repo', `已贮藏改动${message === '' ? '' : `：${message}`}`);
				return { repo };
			});
			break;

		default:
			return false;
	}
	return true;
}