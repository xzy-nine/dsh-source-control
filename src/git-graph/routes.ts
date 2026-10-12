/**
 * dsh-dev-git-graph 宿主路由：以 POST /dsh-dev-git-graph/gg/api 暴露 git 命令集，
 * 数据层复用 vendor/git-graph/dataSource.ts（源码级移植，见 vendor/git-graph/LICENSE），
 * 工作区变更命令见 ./working-tree.ts。前端是主文档内的 React 面板，不再有静态页。
 */
import type http from 'node:http';
import { DataSource } from '../../vendor/git-graph/dataSource.js';
import { findGitExecutable } from '../../vendor/git-graph/gg-shims/utilsShim.js';
import { commitStaged, discardPaths, loadWorkingTree, stagePaths, unstagePaths } from './working-tree.js';
import { discoverRepositories, loadRepoSync } from './repo-discovery.js';

let dataSourcePromise: Promise<DataSource> | null = null;

function getDataSource(): Promise<DataSource> {
	if (dataSourcePromise === null) {
		dataSourcePromise = findGitExecutable().then((git) => new DataSource(git));
	}
	return dataSourcePromise;
}

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
	const ds = await getDataSource();
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
			const repoInfo = await ds.getRepoInfo(repo, bool('showRemoteBranches', true), bool('showStashes', true), arr('hideRemotes'));
			let isRepo = true;
			if (repoInfo.error) {
				isRepo = (await ds.repoRoot(repo)) !== null;
				if (!isRepo) repoInfo.error = null;
			}
			respond({ command: 'loadRepoInfo', refreshId: num('refreshId'), ...repoInfo, isRepo });
			break;
		}
		case 'loadCommits':
			respond({
				command: 'loadCommits',
				refreshId: num('refreshId'),
				onlyFollowFirstParent: bool('onlyFollowFirstParent'),
				...(await ds.getCommits(
					repo,
					msg.branches === null || Array.isArray(msg.branches) ? (msg.branches as string[] | null) : null,
					num('maxCommits', 300),
					bool('showTags', true),
					bool('showRemoteBranches', true),
					bool('includeCommitsMentionedByReflogs'),
					bool('onlyFollowFirstParent'),
					(typeof msg.commitOrdering === 'string' ? msg.commitOrdering : 'date') as never,
					arr('remotes'),
					arr('hideRemotes'),
					arr('stashes'),
				)),
			});
			break;
		case 'loadConfig':
			respond({ command: 'loadConfig', repo, ...(await ds.getConfig(repo, arr('remotes'))) });
			break;
		case 'commitDetails': {
			const data = msg.commitHash === '*'
				? await ds.getUncommittedDetails(repo)
				: msg.stash === null || msg.stash === undefined
					? await ds.getCommitDetails(repo, str('commitHash'), bool('hasParents'))
					: await ds.getStashDetails(repo, str('commitHash'), msg.stash as never);
			respond({ command: 'commitDetails', ...data, avatar: null, codeReview: null, refresh: bool('refresh') });
			break;
		}
		case 'compareCommits':
			respond({
				command: 'compareCommits',
				commitHash: str('commitHash'),
				compareWithHash: str('compareWithHash'),
				...(await ds.getCommitComparison(repo, str('fromHash'), str('toHash'))),
				codeReview: null,
				refresh: bool('refresh'),
			});
			break;
		case 'tagDetails':
			respond({ command: 'tagDetails', tagName: str('tagName'), commitHash: str('commitHash'), ...(await ds.getTagDetails(repo, str('tagName'))) });
			break;

		/* --- 分支操作 --- */
		case 'checkoutBranch': {
			const errors: unknown[] = [await ds.checkoutBranch(repo, str('branchName'), strOrNull('remoteBranch'))];
			const pull = msg.pullAfterwards as Record<string, unknown> | null;
			if (errors[0] === null && pull) {
				errors.push(await ds.pullBranch(repo, String(pull.branchName), String(pull.remote), Boolean(pull.createNewCommit), Boolean(pull.squash)));
			}
			respond({ command: 'checkoutBranch', pullAfterwards: msg.pullAfterwards ?? null, errors });
			break;
		}
		case 'createBranch':
			respond({ command: 'createBranch', errors: await ds.createBranch(repo, str('branchName'), str('commitHash'), bool('checkout'), bool('force')) });
			break;
		case 'deleteBranch': {
			const errors: unknown[] = [await ds.deleteBranch(repo, str('branchName'), bool('forceDelete'))];
			if (errors[0] === null) {
				for (const remote of arr<string>('deleteOnRemotes')) {
					errors.push(await ds.deleteRemoteBranch(repo, str('branchName'), remote));
				}
			}
			respond({ command: 'deleteBranch', repo, branchName: str('branchName'), deleteOnRemotes: arr('deleteOnRemotes'), errors });
			break;
		}
		case 'deleteRemoteBranch':
			await respondError('deleteRemoteBranch', () => ds.deleteRemoteBranch(repo, str('branchName'), str('remote')));
			break;
		case 'renameBranch':
			await respondError('renameBranch', () => ds.renameBranch(repo, str('oldName'), str('newName')));
			break;
		case 'fetchIntoLocalBranch':
			await respondError('fetchIntoLocalBranch', () => ds.fetchIntoLocalBranch(repo, str('remote'), str('remoteBranch'), str('localBranch'), bool('force')));
			break;
		case 'pullBranch':
			await respondError('pullBranch', () => ds.pullBranch(repo, str('branchName'), str('remote'), bool('createNewCommit'), bool('squash')));
			break;
		case 'pushBranch':
			respond({
				command: 'pushBranch',
				willUpdateBranchConfig: bool('willUpdateBranchConfig'),
				errors: await ds.pushBranchToMultipleRemotes(repo, str('branchName'), arr('remotes'), bool('setUpstream'), (typeof msg.mode === 'string' ? msg.mode : '') as never),
			});
			break;

		/* --- 提交操作 --- */
		case 'checkoutCommit':
			await respondError('checkoutCommit', () => ds.checkoutCommit(repo, str('commitHash')));
			break;
		case 'cherrypickCommit':
			respond({ command: 'cherrypickCommit', errors: [await ds.cherrypickCommit(repo, str('commitHash'), num('parentIndex'), bool('recordOrigin'), bool('noCommit'))] });
			break;
		case 'dropCommit':
			await respondError('dropCommit', () => ds.dropCommit(repo, str('commitHash')));
			break;
		case 'resetToCommit':
			await respondError('resetToCommit', () => ds.resetToCommit(repo, str('commit'), (typeof msg.resetMode === 'string' ? msg.resetMode : 'mixed') as never));
			break;
		case 'revertCommit':
			await respondError('revertCommit', () => ds.revertCommit(repo, str('commitHash'), num('parentIndex')));
			break;
		case 'merge':
			respond({
				command: 'merge',
				actionOn: msg.actionOn,
				error: await ds.merge(repo, str('obj'), (typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch') as never, bool('createNewCommit'), bool('squash'), bool('noCommit')),
			});
			break;
		case 'rebase':
			respond({
				command: 'rebase',
				actionOn: msg.actionOn,
				interactive: bool('interactive'),
				error: await ds.rebase(repo, str('obj'), (typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch') as never, bool('ignoreDate', true), bool('interactive')),
			});
			break;

		/* --- 标签 --- */
		case 'addTag': {
			const errors: unknown[] = [await ds.addTag(repo, str('tagName'), str('commitHash'), (typeof msg.type === 'number' ? msg.type : 0) as never, str('message'), bool('force'))];
			if (errors[0] === null && strOrNull('pushToRemote') !== null) {
				errors.push(...(await ds.pushTag(repo, str('tagName'), [str('pushToRemote')], str('commitHash'), bool('pushSkipRemoteCheck'))));
			}
			respond({ command: 'addTag', repo, tagName: str('tagName'), pushToRemote: strOrNull('pushToRemote'), commitHash: str('commitHash'), errors });
			break;
		}
		case 'deleteTag':
			await respondError('deleteTag', () => ds.deleteTag(repo, str('tagName'), strOrNull('deleteOnRemote')));
			break;
		case 'pushTag':
			respond({
				command: 'pushTag',
				repo,
				tagName: str('tagName'),
				remotes: arr('remotes'),
				commitHash: str('commitHash'),
				errors: await ds.pushTag(repo, str('tagName'), arr('remotes'), str('commitHash'), bool('skipRemoteCheck')),
			});
			break;

		/* --- 远程 --- */
		case 'fetch':
			await respondError('fetch', () => ds.fetch(repo, strOrNull('name'), bool('prune'), bool('pruneTags')));
			break;
		case 'addRemote':
			await respondError('addRemote', () => ds.addRemote(repo, str('name'), str('url'), strOrNull('pushUrl'), bool('fetch')));
			break;
		case 'deleteRemote':
			await respondError('deleteRemote', () => ds.deleteRemote(repo, str('name')));
			break;
		case 'editRemote':
			await respondError('editRemote', () => ds.editRemote(repo, str('nameOld'), str('nameNew'), strOrNull('urlOld'), strOrNull('urlNew'), strOrNull('pushUrlOld'), strOrNull('pushUrlNew')));
			break;
		case 'pruneRemote':
			await respondError('pruneRemote', () => ds.pruneRemote(repo, str('name')));
			break;

		/* --- Stash --- */
		case 'applyStash':
			await respondError('applyStash', () => ds.applyStash(repo, str('selector'), bool('reinstateIndex')));
			break;
		case 'branchFromStash':
			await respondError('branchFromStash', () => ds.branchFromStash(repo, str('selector'), str('branchName')));
			break;
		case 'dropStash':
			await respondError('dropStash', () => ds.dropStash(repo, str('selector')));
			break;
		case 'popStash':
			await respondError('popStash', () => ds.popStash(repo, str('selector'), bool('reinstateIndex')));
			break;
		case 'pushStash':
			await respondError('pushStash', () => ds.pushStash(repo, str('message'), bool('includeUntracked', true)));
			break;

		/* --- 其它 --- */
		case 'cleanUntrackedFiles':
			await respondError('cleanUntrackedFiles', () => ds.cleanUntrackedFiles(repo, bool('directories')));
			break;
		case 'resetFileToRevision':
			await respondError('resetFileToRevision', () => ds.resetFileToRevision(repo, str('commitHash'), str('filePath')));
			break;
		case 'createArchive':
			respond({ command: 'createArchive', error: 'DSH 版本暂不支持导出归档' });
			break;
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
		       前端收到 error 后弹提示（vendor/git-graph/web/main.ts 的 viewDiff 分支）。 --- */
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
		case 'exportRepoConfig':
			respond({ command: 'exportRepoConfig', error: null });
			break;
		case 'rescanForRepos':
			respond({ command: 'rescanForRepos' });
			break;
		case 'deleteUserDetails': {
			const location = str('location') as 'local' | 'global';
			const errors: string[] = [];
			if (bool('name')) { try { await ds.unsetConfigValue(repo, 'user.name' as any, location as any); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			if (bool('email')) { try { await ds.unsetConfigValue(repo, 'user.email' as any, location as any); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			respond({ command: 'deleteUserDetails', errors });
			break;
		}
		case 'editUserDetails': {
			const location = str('location') as 'local' | 'global';
			const errors: string[] = [];
			const name = str('name');
			const email = str('email');
			try { await ds.setConfigValue(repo, 'user.name' as any, name, location as any); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
			try { await ds.setConfigValue(repo, 'user.email' as any, email, location as any); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); }
			if (bool('deleteLocalName')) { try { await ds.unsetConfigValue(repo, 'user.name' as any, 'local' as any); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
			if (bool('deleteLocalEmail')) { try { await ds.unsetConfigValue(repo, 'user.email' as any, 'local' as any); } catch (e) { errors.push(String(e instanceof Error ? e.message : e)); } }
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

export function registerGgRoutes(webServer: GgRouteContext): Array<() => void> {
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

	return disposers;
}
