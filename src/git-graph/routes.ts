/**
 * dsh-dev-git-graph 宿主路由：以 POST /dsh-dev-git-graph/gg/api 暴露 git 命令集。
 *
 * 数据层由本目录的本地实现提供：提交图与仓库信息见 ./git-query.ts，各类操作见
 * ./git-actions.ts，工作区变更见 ./working-tree.ts。前端是主文档内的 React 面板。
 */
import type http from 'node:http';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {
	getCommitComparison, getCommitDetails, getCommits, getConfig, getRepoInfo, getStashDetails,
	getTagDetails, getUncommittedDetails, repoRoot,
} from './git-query.js';
import {
	addRemote, addTag, applyStash, branchFromStash, checkoutBranch, checkoutCommit, cherrypickCommit,
	cleanUntrackedFiles, createBranch, deleteBranch, deleteRemote, deleteRemoteBranch, deleteTag,
	dropCommit, dropStash, editRemote, fetch, fetchIntoLocalBranch, merge, mergeCurrentIntoBranch, popStash,
	pruneRemote, pullBranch, pushBranchToMultipleRemotes, pushStash, pushTag, rebase, renameBranch,
	resetFileToRevision, resetToCommit, revertCommit, setConfigValue, unsetConfigValue,
} from './git-actions.js';
import { commitStaged, discardPaths, gitOrThrow, loadWorkingTree, removeWorktree, runGit, stagePaths, unstagePaths } from './working-tree.js';
import { collectDiff } from './commit-diff.js';
import { parseUnifiedDiffHunks, type DiffHunkText } from './diff-hunks.js';
import { branchesOfOtherWorktrees, discoverRepositories, loadRepoSync } from './repo-discovery.js';

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}

function sendBadRequest(res: http.ServerResponse, message: string): void {
	sendJson(res, 400, { error: message });
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			try {
				resolve(chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	let msg: Record<string, unknown>;
	try {
		msg = await readBody(req);
	} catch {
		return sendBadRequest(res, '请求体不是合法 JSON');
	}
	const repo = typeof msg.repo === 'string' ? msg.repo : '';
	if (!repo) {
		return sendBadRequest(res, '缺少 repo');
	}

	const str = (k: string): string => (typeof msg[k] === 'string' ? (msg[k] as string) : '');
	const strOrNull = (k: string): string | null => (typeof msg[k] === 'string' ? (msg[k] as string) : null);
	const bool = (k: string, dflt = false): boolean => (typeof msg[k] === 'boolean' ? (msg[k] as boolean) : dflt);
	const num = (k: string, dflt = 0): number => (typeof msg[k] === 'number' ? (msg[k] as number) : dflt);
	const arr = <T>(k: string): T[] => (Array.isArray(msg[k]) ? (msg[k] as T[]) : []);

	const respond = (payload: Record<string, unknown>): void => {
		sendJson(res, 200, payload);
	};
	const respondError = async (cmd: string, fn: () => Promise<unknown>): Promise<void> => {
		respond({ command: cmd, error: await fn() });
	};

	/**
	 * 执行一条工作区操作：成功时把返回值并入响应，失败时以 `error` 回投。
	 *
	 * 与 `respondError` 的区别是后者的函数本身返回错误值；这里的函数返回数据或抛错。
	 *
	 * @param cmd - 命令名，原样回投。
	 * @param fn - 执行体，返回值会并入响应载荷。
	 */
	const respondResult = async (cmd: string, fn: () => Promise<Record<string, unknown>>): Promise<void> => {
		try {
			respond({ command: cmd, ...(await fn()), error: null });
		} catch (error) {
			respond({ command: cmd, error: error instanceof Error ? error.message : String(error) });
		}
	};

	switch (msg.command as string) {
		/* --- 工作区变更（DSH 版新增：变更列表 / 暂存 / 提交 / 丢弃） --- */
		case 'loadWorkingTree':
			await respondResult('loadWorkingTree', async () => ({ repo, entries: await loadWorkingTree(repo) }));
			break;
		case 'stagePaths':
			await respondResult('stagePaths', async () => { await stagePaths(repo, arr<string>('paths')); return { repo }; });
			break;
		case 'unstagePaths':
			await respondResult('unstagePaths', async () => { await unstagePaths(repo, arr<string>('paths')); return { repo }; });
			break;
		case 'discardPaths':
			await respondResult('discardPaths', async () => { await discardPaths(repo, arr<string>('paths'), bool('untracked')); return { repo }; });
			break;
		case 'commitStaged':
			await respondResult('commitStaged', async () => ({ repo, hash: await commitStaged(repo, str('message'), bool('amend')) }));
			break;
		case 'removeWorktree':
			await respondResult('removeWorktree', async () => {
				const worktreePath = str('worktreePath');
				await removeWorktree(repo, worktreePath, bool('force'));
				return { repo, worktreePath };
			});
			break;
		case 'branchesContaining':
			// 分支只由尖端提交标识，中间提交的 heads 为空；按包含关系查询才能列出所属分支。
			await respondResult('branchesContaining', async () => {
				const hash = str('commitHash');
				const localOut = await gitOrThrow(['branch', '--contains', hash, '--format=%(refname:short)'], repo);
				// 别的工作树占用的分支不可删除，不作为候选；当前工作树自己的分支保留。
				const foreign = await branchesOfOtherWorktrees(repo);
				const local = localOut.split('\n').map((line) => line.trim())
					.filter((line) => line !== '' && !foreign.has(line));
				const remoteOut = await gitOrThrow(['branch', '-r', '--contains', hash, '--format=%(refname:short)'], repo);
				// 远程 HEAD 是符号引用，短名只显示远程名本身（如 `origin`），须排除。
				const remoteNames = new Set((await gitOrThrow(['remote'], repo)).split('\n').map((line) => line.trim()));
				const remote = remoteOut.split('\n').map((line) => line.trim())
					.filter((line) => line !== '' && !line.endsWith('/HEAD') && !remoteNames.has(line));
				return { repo, local, remote };
			});
			break;

		/* --- 仓库发现（DSH 版新增：≤3 层递归 + 工作树/子模块权威枚举） --- */
		case 'discoverRepositories':
			await respondResult('discoverRepositories', async () => {
				const result = await discoverRepositories(repo, { maxDepth: num('maxDepth', 3) });
				return { root: repo, nodes: result.nodes, truncated: result.truncated };
			});
			break;
		case 'loadRepoSync':
			await respondResult('loadRepoSync', async () => {
				const sync = await loadRepoSync(repo);
				return { repo, branch: sync.branch, upstream: sync.upstream, ahead: sync.ahead, behind: sync.behind };
			});
			break;

		/* --- 数据查询 --- */
		case 'loadRepoInfo': {
			let repoInfo = await getRepoInfo(repo, bool('showRemoteBranches', true), bool('showStashes', true), arr('hideRemotes'));
			let isRepo = true;
			if (repoInfo.error) {
				isRepo = (await repoRoot(repo)) !== null;
				if (!isRepo) repoInfo = { ...repoInfo, error: null };
			}
			respond({ command: 'loadRepoInfo', refreshId: num('refreshId'), ...repoInfo, isRepo });
			break;
		}
		case 'loadCommits':
			{
				// 远程列表在前端是 `Remote` 对象数组，数据层按远程名标注远程分支，这里取名字；
				// 直接传字符串数组的调用方同样接受。
				const remoteNames = arr<unknown>('remotes')
					.map((remote) => (typeof remote === 'string' ? remote : (remote as { name?: unknown } | null)?.name))
					.filter((name): name is string => typeof name === 'string' && name !== '');
				const data = await getCommits(
					repo,
					msg.branches === null || Array.isArray(msg.branches) ? (msg.branches as string[] | null) : null,
					num('maxCommits', 300),
					bool('showTags', true),
					bool('showRemoteBranches', true),
					bool('includeCommitsMentionedByReflogs'),
					bool('onlyFollowFirstParent'),
					(typeof msg.commitOrdering === 'string' ? msg.commitOrdering : 'date') as never,
					remoteNames,
					arr('hideRemotes'),
					arr('stashes'),
				);
				// 别的工作树占用的分支不是本仓库的分支：不作为标签显示（删除候选同理）。
				const foreign = await branchesOfOtherWorktrees(repo);
				const filtered = foreign.size === 0
					? data
					: {
						...data,
						commits: (data.commits ?? []).map((commit) => ({
							...commit,
							heads: (commit.heads ?? []).filter((name: string) => !foreign.has(name)),
						})),
					};
				respond({
					command: 'loadCommits',
					refreshId: num('refreshId'),
					onlyFollowFirstParent: bool('onlyFollowFirstParent'),
					...filtered,
				});
			}
			break;
		case 'loadConfig':
			respond({ command: 'loadConfig', repo, ...(await getConfig(repo, arr('remotes'))) });
			break;
		case 'commitDetails': {
			const data = msg.commitHash === '*'
				? await getUncommittedDetails(repo)
				: msg.stash === null || msg.stash === undefined
					? await getCommitDetails(repo, str('commitHash'), bool('hasParents'))
					: await getStashDetails(repo, str('commitHash'), msg.stash as never);
			respond({ command: 'commitDetails', ...data, avatar: null, codeReview: null, refresh: bool('refresh') });
			break;
		}
		case 'compareCommits':
			respond({
				command: 'compareCommits',
				commitHash: str('commitHash'),
				compareWithHash: str('compareWithHash'),
				...(await getCommitComparison(repo, str('fromHash'), str('toHash'))),
				codeReview: null,
				refresh: bool('refresh'),
			});
			break;
		case 'tagDetails':
			respond({ command: 'tagDetails', tagName: str('tagName'), commitHash: str('commitHash'), ...(await getTagDetails(repo, str('tagName'))) });
			break;

		/* --- 分支操作 --- */
		case 'checkoutBranch': {
			const errors: unknown[] = [await checkoutBranch(repo, str('branchName'), strOrNull('remoteBranch'))];
			const pull = msg.pullAfterwards as Record<string, unknown> | null;
			if (errors[0] === null && pull) {
				errors.push(await pullBranch(repo, String(pull.branchName), String(pull.remote), Boolean(pull.createNewCommit), Boolean(pull.squash)));
			}
			respond({ command: 'checkoutBranch', pullAfterwards: msg.pullAfterwards ?? null, errors });
			break;
		}
		case 'createBranch':
			respond({ command: 'createBranch', errors: await createBranch(repo, str('branchName'), str('commitHash'), bool('checkout'), bool('force')) });
			break;
		case 'deleteBranch': {
			const errors: unknown[] = [await deleteBranch(repo, str('branchName'), bool('forceDelete'))];
			if (errors[0] === null) {
				for (const remote of arr<string>('deleteOnRemotes')) {
					errors.push(await deleteRemoteBranch(repo, str('branchName'), remote));
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
				errors: await pushBranchToMultipleRemotes(repo, str('branchName'), arr('remotes'), bool('setUpstream'), (typeof msg.mode === 'string' ? msg.mode : '') as never),
			});
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
		case 'merge':
			respond({
				command: 'merge',
				actionOn: msg.actionOn,
				error: await merge(repo, str('obj'), (typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch') as never, bool('createNewCommit'), bool('squash'), bool('noCommit')),
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
		case 'rebase':
			respond({
				command: 'rebase',
				actionOn: msg.actionOn,
				interactive: bool('interactive'),
				error: await rebase(repo, str('obj'), (typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch') as never, bool('ignoreDate', true), bool('interactive')),
			});
			break;

		/* --- 标签 --- */
		case 'addTag': {
			const errors: unknown[] = [await addTag(repo, str('tagName'), str('commitHash'), (typeof msg.type === 'number' ? msg.type : 0) as never, str('message'), bool('force'))];
			if (errors[0] === null && strOrNull('pushToRemote') !== null) {
				errors.push(...(await pushTag(repo, str('tagName'), [str('pushToRemote')], str('commitHash'), bool('pushSkipRemoteCheck'))));
			}
			respond({ command: 'addTag', repo, tagName: str('tagName'), pushToRemote: strOrNull('pushToRemote'), commitHash: str('commitHash'), errors });
			break;
		}
		case 'deleteTag':
			await respondError('deleteTag', () => deleteTag(repo, str('tagName'), strOrNull('deleteOnRemote')));
			break;
		case 'pushTag':
			respond({
				command: 'pushTag',
				repo,
				tagName: str('tagName'),
				remotes: arr('remotes'),
				commitHash: str('commitHash'),
				errors: await pushTag(repo, str('tagName'), arr('remotes'), str('commitHash'), bool('skipRemoteCheck')),
			});
			break;

		/* --- 远程 --- */
		case 'fetch':
			await respondError('fetch', () => fetch(repo, strOrNull('name'), bool('prune'), bool('pruneTags')));
			break;
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
			await respondError('pushStash', () => pushStash(repo, str('message'), bool('includeUntracked', true)));
			break;

		/* --- 其它 --- */
		case 'cleanUntrackedFiles':
			await respondError('cleanUntrackedFiles', () => cleanUntrackedFiles(repo, bool('directories')));
			break;
		case 'resetFileToRevision':
			await respondError('resetFileToRevision', () => resetFileToRevision(repo, str('commitHash'), str('filePath')));
			break;
		case 'createArchive': {
			const ref = str('ref');
			const format = str('format') || 'zip';
			const outputPath = str('outputPath');
			if (!ref || !outputPath) { sendBadRequest(res, '缺少 ref 或 outputPath'); break; }
			try {
				const fmtArg = format === 'tgz' ? 'tar.gz' : format;
				await gitOrThrow(['archive', `--format=${fmtArg}`, `--output=${outputPath}`, ref], repo);
				respond({ command: 'createArchive', error: null });
			} catch (e) {
				respond({ command: 'createArchive', error: e instanceof Error ? e.message : String(e) });
			}
			break;
		}
		case 'createPullRequest':
			respond({ command: 'createPullRequest', push: bool('push'), errors: ['DSH 版本暂不支持创建 Pull Request'] });
			break;
		case 'openExtensionSettings':
		case 'openExternalDirDiff':
		case 'openExternalUrl':
		case 'openFile':
		case 'openTerminal':
		case 'viewFileAtRevision':
		case 'viewScm':
			respond({ command: msg.command, error: '该操作依赖 VS Code，DSH 版本暂不支持' });
			break;

		/* --- Diff：DSH 右侧栏无通用 git diff 页类型，与其它 VS Code 专属命令一致回错误，
		       前端收到 error 后弹提示。 --- */
		case 'viewDiff':
		case 'viewDiffWithWorkingFile':
			respond({ command: msg.command, error: 'DSH 版本暂不支持打开 Git diff，请用 git 命令或外部 diff 工具' });
			break;

		/* --- 状态 / 剪贴板（DSH 版由前端直接处理） --- */
		case 'copyToClipboard':
		case 'copyFilePath':
			respond({ command: msg.command, type: msg.type ?? null, error: null });
			break;
		case 'setGlobalViewState':
		case 'setWorkspaceViewState':
			respond({ command: msg.command, error: null });
			break;
		case 'setRepoState':
		case 'fetchAvatar':
		case 'startCodeReview':
		case 'endCodeReview':
		case 'updateCodeReview':
			respond({ command: msg.command, error: null });
			break;
		case 'showErrorMessage':
			console.error('[dsh-dev-git-graph][git-graph] ' + String(msg.message ?? ''));
			respond({ command: 'showErrorMessage' });
			break;
		case 'exportRepoConfig': {
			try {
				const config = await getConfig(repo, []);
				const repoInfo = await getRepoInfo(repo, true, true, []);
				respond({ command: 'exportRepoConfig', error: null, config: { repo, config, repoInfo } });
			} catch (e) {
				respond({ command: 'exportRepoConfig', error: e instanceof Error ? e.message : String(e), config: null });
			}
			break;
		}
		case 'fileDiffContent': {
			const filePath = str('filePath');
			const commitHash = str('commitHash');
			const staged = bool('staged');
			try {
				let oldText: string | null = null;
				let newText: string | null = null;
				if (commitHash === '*') {
					if (staged) {
						// 暂存区 vs HEAD
						try { oldText = await gitOrThrow(['show', `HEAD:${filePath}`], repo); } catch { oldText = null; }
						try { newText = await gitOrThrow(['show', `:${filePath}`], repo); } catch { newText = null; }
					} else {
						// 工作区 vs 暂存区
						try { oldText = await gitOrThrow(['show', `:${filePath}`], repo); } catch { oldText = null; }
						try {
							const fullPath = nodePath.resolve(repo, filePath);
							newText = await fs.readFile(fullPath, 'utf8');
						} catch { newText = null; }
					}
				} else {
					// 提交差异：oldText 取父提交，newText 取该提交
					try { oldText = await gitOrThrow(['show', `${commitHash}~1:${filePath}`], repo); } catch { oldText = null; }
					try { newText = await gitOrThrow(['show', `${commitHash}:${filePath}`], repo); } catch { newText = null; }
				}
				// 真实 hunk 由 git 算出：交给前端的本地 diff 在改动量超过其搜索上限时
				// 会退化成整文件「全删全加」，因此这里直接给出逐块内容。
				const hunks = await diffHunksOf(repo, commitHash, filePath, staged);
				respond({ command: 'fileDiffContent', path: filePath, oldText, newText, hunks });
			} catch (e) {
				respond({ command: 'fileDiffContent', path: filePath, oldText: null, newText: null, hunks: [], error: e instanceof Error ? e.message : String(e) });
			}
			break;
		}
		case 'rescanForRepos':
			respond({ command: 'rescanForRepos' });
			break;
		case 'deleteUserDetails': {
			const location = str('location') as 'local' | 'global';
			const errors: string[] = [];
			if (bool('name')) { try { await unsetConfigValue(repo, 'user.name', location); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			if (bool('email')) { try { await unsetConfigValue(repo, 'user.email', location); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			respond({ command: 'deleteUserDetails', errors });
			break;
		}
		case 'editUserDetails': {
			const location = str('location') as 'local' | 'global';
			const errors: string[] = [];
			const name = str('name');
			const email = str('email');
			try { await setConfigValue(repo, 'user.name', name, location); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
			try { await setConfigValue(repo, 'user.email', email, location); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
			if (bool('deleteLocalName')) { try { await unsetConfigValue(repo, 'user.name', 'local'); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			if (bool('deleteLocalEmail')) { try { await unsetConfigValue(repo, 'user.email', 'local'); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			respond({ command: 'editUserDetails', errors });
			break;
		}

		default:
			sendBadRequest(res, '未知命令: ' + String(msg.command));
	}
}

export interface GgRouteContext {
	register(spec: {
		kind: 'exact' | 'prefix';
		path: string;
		handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
	}): () => void;
}

/** AI 提交生成的依赖面。 */
export interface AiCommitDeps {
	getLlm?: () => unknown;
	getAgentDefaultModel?: () => unknown;
}

/** AI 提交生成的系统提示词。 */
const AI_COMMIT_SYSTEM_PROMPT = '你是 Git 提交信息生成器。根据给定的 diff 内容，生成一条简洁的提交信息。'
	+ '要求：第一行不超过 72 字符的 conventional commit 格式（如 `feat: ...`、`fix: ...`、`refactor: ...`）；'
	+ '如果改动较复杂，空一行后附 2-5 条要点说明，每条以 `- ` 开头。'
	+ '只输出提交信息本身，不要输出 diff、解释、markdown 代码块标记或其他内容。';

/**
 * 查模型是否声明了 `off` 推理档位。
 * @param llm - llm 服务。
 * @param provider - 供应商 id。
 * @param model - 模型 id。
 * @returns 是否可安全发送 `reasoningEffort: 'off'`。
 */
async function canDisableReasoning(llm: unknown, provider: string, model: string): Promise<boolean> {
	const svc = llm as { resolveModelInfo?: (p: string, m: string) => Promise<unknown> };
	if (!provider || !model || typeof svc.resolveModelInfo !== 'function') return false;
	try {
		const info = await svc.resolveModelInfo(provider, model) as { reasoning?: { efforts?: Array<{ id?: string }> } };
		const efforts = info?.reasoning?.efforts;
		if (!Array.isArray(efforts)) return false;
		return efforts.some((e) => e?.id === 'off');
	} catch {
		return false;
	}
}

/**
 * 取 agent 当前默认模型选择。
 * @param getAgentDefaultModel - `ctx.get('agentDefaultModel')`。
 * @returns `{ provider, model }` 或 null。
 */
function getAgentDefaultSelection(getAgentDefaultModel?: () => unknown): { provider: string; model: string } | null {
	if (typeof getAgentDefaultModel !== 'function') return null;
	try {
		const svc = getAgentDefaultModel() as { currentSelection?: () => unknown };
		const sel = svc?.currentSelection?.() as { provider?: string; model?: string } | null;
		if (sel === null || typeof sel !== 'object') return null;
		const provider = typeof sel.provider === 'string' ? sel.provider : '';
		const model = typeof sel.model === 'string' ? sel.model : '';
		return provider !== '' && model !== '' ? { provider, model } : null;
	} catch {
		return null;
	}
}

/**
 * 取某个文件差异的逐块内容。
 *
 * 由 git 用 `-U3` 生成统一差异后按 hunk 切分。提交差异与新旧内容同源，一律对比第一个
 * 父提交，因此合并提交不会落到 git 的合并差异格式（`@@@`，无法按单侧 hunk 解析）。
 * 命令失败或没有 hunk（二进制、未跟踪的新文件）时返回空数组，前端据此退回整份内容比较。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 提交哈希；`*` 表示工作区。
 * @param filePath - 文件路径（相对仓库根）。
 * @param staged - 工作区时是否比较暂存区。
 * @returns 逐块的新旧内容。
 */
async function diffHunksOf(repo: string, commitHash: string, filePath: string, staged: boolean): Promise<DiffHunkText[]> {
	const args = commitHash === '*'
		? (staged
			? ['diff', '--no-color', '--unified=3', '--cached', '--', filePath]
			: ['diff', '--no-color', '--unified=3', '--', filePath])
		: ['diff', '--no-color', '--unified=3', `${commitHash}~1`, commitHash, '--', filePath];
	try {
		return parseUnifiedDiffHunks(await gitOrThrow(args, repo));
	} catch {
		return [];
	}
}

export function registerGgRoutes(webServer: GgRouteContext, aiDeps?: AiCommitDeps): Array<() => void> {
	const disposers: Array<() => void> = [];

	// 消息 API（POST）：前端面板与宿主之间的唯一通道。
	disposers.push(
		webServer.register({
			kind: 'exact',
			path: '/dsh-dev-git-graph/gg/api',
			handler: (req, res) => {
				if (req.method !== 'POST') {
					res.writeHead(405, { allow: 'POST' });
					res.end();
					return;
				}
				void handleApi(req, res).catch((e) => {
					sendJson(res, 500, { error: String(e instanceof Error ? e.message : e) });
				});
			},
		}),
	);

	// AI 模型目录（GET）：供应商列表 + 每供应商的模型 id。
	disposers.push(
		webServer.register({
			kind: 'exact',
			path: '/dsh-dev-git-graph/gg/ai-models',
			handler: (req, res) => {
				if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return; }
				const llm = aiDeps?.getLlm?.() as { listProviders?: () => unknown[]; listModels?: (p: string) => Promise<unknown[]> } | undefined;
				if (!llm || typeof llm.listProviders !== 'function') { sendJson(res, 200, { providers: [], modelsByProvider: {} }); return; }
				const providers: Array<{ id: string; name: string }> = [];
				try {
					const raw = llm.listProviders();
					for (const p of (Array.isArray(raw) ? raw : [])) {
						const id = (p as { id?: string })?.id ?? '';
						if (id.length > 0) providers.push({ id, name: (p as { name?: string })?.name ?? id });
					}
				} catch { /* 目录不可用 */ }
				void (async () => {
					const modelsByProvider: Record<string, string[]> = {};
					for (const p of providers) {
						try {
							const list = typeof llm.listModels === 'function' ? await llm.listModels(p.id) : [];
							modelsByProvider[p.id] = (Array.isArray(list) ? list : [])
								.map((m) => (m as { id?: string })?.id ?? '')
								.filter((id) => id.length > 0);
						} catch { modelsByProvider[p.id] = []; }
					}
					const fallback = getAgentDefaultSelection(aiDeps?.getAgentDefaultModel);
					sendJson(res, 200, { providers, modelsByProvider, fallback });
				})();
			},
		}),
	);

	// AI 提交信息生成（POST，SSE 流式）：取暂存 diff → 调 llm.stream → 逐 chunk 推送。
	disposers.push(
		webServer.register({
			kind: 'exact',
			path: '/dsh-dev-git-graph/gg/ai-commit',
			handler: (req, res) => {
				if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
				void (async () => {
					const body = await readBody(req);
					const repo = typeof body.repo === 'string' ? body.repo : '';
					if (!repo) { sendJson(res, 400, { error: '缺少 repo' }); return; }
					const llm = aiDeps?.getLlm?.() as { stream?: (opts: unknown) => AsyncIterable<{ content?: string }> } | undefined;
					if (!llm || typeof llm.stream !== 'function') { sendJson(res, 503, { error: 'llm 服务不可用' }); return; }

					// 模型解析：请求指定 > agent 默认（附警告）
					let provider = typeof body.provider === 'string' ? body.provider : '';
					let model = typeof body.model === 'string' ? body.model : '';
					let warning = '';
					if (provider === '' || model === '') {
						const fallback = getAgentDefaultSelection(aiDeps?.getAgentDefaultModel);
						if (fallback !== null) { provider = fallback.provider; model = fallback.model; warning = '未配置专用模型，使用当前会话模型'; }
						else { sendJson(res, 400, { error: '未配置模型且无法获取当前会话模型' }); return; }
					}

					// 修补上一次提交时，把上一提交的改动一并纳入 diff。
					const amend = body.amend === true;
					const diff = await collectDiff(repo, amend);
					if (diff.trim() === '') { sendJson(res, 400, { error: '无 diff 可生成提交信息（暂存区与工作区均为空）' }); return; }

					const rules = typeof body.rules === 'string' ? body.rules.trim() : '';
					const systemPrompt = rules.length > 0 ? AI_COMMIT_SYSTEM_PROMPT + '\n\n' + rules : AI_COMMIT_SYSTEM_PROMPT;
					const off = await canDisableReasoning(llm, provider, model);
					const request = amend
						? `请根据以下 diff 生成提交信息（这是修补上一次提交，diff 含上一次提交的改动与本次改动）：\n\n${diff}`
						: `请根据以下 diff 生成提交信息：\n\n${diff}`;
					const streamOpts: Record<string, unknown> = {
						provider,
						model,
						system: systemPrompt,
						messages: [{ role: 'user', content: [{ type: 'text', text: request }] }],
						maxTokens: 512,
						temperature: 0,
					};
					if (off) streamOpts.reasoningEffort = 'off';

					res.writeHead(200, {
						'content-type': 'text/event-stream; charset=utf-8',
						'cache-control': 'no-store',
						'connection': 'keep-alive',
					});
					const sse = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
					if (warning !== '') sse('warning', warning);

					const startTime = Date.now();
					let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null = null;
					try {
						const stream = llm.stream(streamOpts) as AsyncIterable<{ type?: string; text?: string; reason?: { kind?: string; failure?: { code?: string; status?: number; message?: string } }; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>;
						for await (const chunk of stream) {
							if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) sse('chunk', chunk.text);
							else if (chunk.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage;
							else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
								const f = chunk.reason.failure;
								const parts = [f?.code, f?.status === undefined ? undefined : 'HTTP ' + f.status, f?.message].filter((x): x is string => typeof x === 'string' && x.length > 0);
								sse('error', parts.length > 0 ? parts.join(' ') : '模型返回错误');
							}
						}
						const elapsedSec = (Date.now() - startTime) / 1000;
						const outTok = usage?.outputTokens ?? 0;
						const tps = elapsedSec > 0 && outTok > 0 ? Math.round(outTok / elapsedSec) : 0;
						sse('stats', {
							tps,
							elapsed: elapsedSec.toFixed(1) + 's',
							inputTokens: usage?.inputTokens ?? 0,
							outputTokens: outTok,
							cacheReadTokens: usage?.cacheReadTokens ?? 0,
							cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
						});
						sse('done', '');
					} catch (e) {
						sse('error', e instanceof Error ? e.message : String(e));
					}
					res.end();
				})();
			},
		}),
	);

	return disposers;
}
