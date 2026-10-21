/**
 * dsh-source-control 宿主路由：以 POST /dsh-source-control/gg/api 暴露 git 命令集。
 *
 * 数据层由本目录的本地实现提供：提交图与仓库信息见 ./git-query.ts，各类操作见
 * ./git-actions.ts，工作区变更见 ./working-tree.ts。前端是主文档内的 React 面板。
 */
import type http from 'node:http';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {
	getCommitComparison, getCommitDetails, getCommits, getConfig, getRepoInfo, getStashDetails,
	getRefsAndBranches, getRefsForGraph, getRemoteNames, getStashes, getUncommittedDetails, getWorkingTreeSnapshot, repoRoot,
} from './git-query.js';
import {
	addRemote, addTag, applyStash, branchFromStash, checkoutBranch, checkoutCommit, cherrypickCommit,
	abortMerge, cleanUntrackedFiles, createBranch, deleteBranch, deleteRemote, deleteRemoteBranch, deleteTag,
	dropCommit, dropStash, editRemote, fetch, fetchIntoLocalBranch, merge, mergeCurrentIntoBranch, popStash,
	pruneRemote, pullBranch, pushBranchToMultipleRemotes, pushStash, pushTag, pushUpstream, rebase, renameBranch,
	resetFileToRevision, resetToCommit, revertCommit, setConfigValue, unsetConfigValue,
} from './git-actions.js';
import { commitStaged, discardPaths, gitOrThrow, initSubmodule, loadWorkingTree, onRepositoryWrite, removeWorktree, runGit, stagePaths, unstagePaths, whenGitIdle } from './working-tree.js';
import { collectDiff } from './commit-diff.js';
import { parseUnifiedDiffHunks, type DiffHunkText } from './diff-hunks.js';
import { branchesOfOtherWorktrees, clearDiscoveryCache, discoverWorkspace, enrichRepositories, loadRepoSync, loadReposSync, type RepoNode } from './repo-discovery.js';
import { closeRepositoryWatchers, onRepositoryTreeChange, watchRepositories, watchWorkspace } from './repo-watcher.js';
import { ghAccount, ghCreatePullRequest, ghCreateRepo, ghOwners, ghRepoInfo } from './gh-cli.js';
import { detectHooks } from './hooks.js';
import { addToGitignore, addToLocalExclude, localExcludeState } from './ignore.js';
import {
	clearHostCache, readGraph, readRepoInfo, readSnapshot, writeGraph, writeRepoInfo, writeSnapshot,
} from './host-cache.js';
import { sshStatus } from './ssh-status.js';
import { AI_COMMIT_PROMPTS, fillPrompt } from './ai-commit-prompts.js';
import { readEntries, readRepoLocations, writeEntry, writeRepoLocations } from './state-store.js';
import type { StashEntry } from './git-types.js';

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
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
		req.on('error', reject);
	});
}

/** 事件流连接的保活间隔（毫秒）。 */
const EVENTS_HEARTBEAT_MS = 25000;

/** 事件流连接数上限：每个连接占一个响应流，不设上限时页面反复重连会累积。 */
const MAX_EVENT_STREAMS = 16;

/** 当前打开的事件流连接。 */
const eventStreams = new Set<http.ServerResponse>();

/**
 * 取节点树里全部可用节点的路径。
 *
 * 只有磁盘上确实存在的节点才纳入：目录已删除的工作树与子模块留在监视集合里，会让此后每一条
 * 名字缺失的事件都判定为仓库集合变化。
 *
 * @param nodes - 仓库节点列表。
 * @returns 全部可用路径，含工作树与子模块。
 */
function flattenRepoPaths(nodes: readonly RepoNode[]): string[] {
	const paths: string[] = [];
	const walk = (list: readonly RepoNode[]): void => {
		for (const node of list) {
			if (node.available) paths.push(node.path);
			walk(node.children);
		}
	};
	walk(nodes);
	return paths;
}

/**
 * 向所有事件流连接推送一条仓库变更。
 *
 * @param repo - 发生变更的仓库路径。
 * @returns 无。
 */
function broadcastRepositoryWrite(repo: string): void {
	broadcastEvent('repository-write', repo);
}

/**
 * 向所有事件流连接推送一条仓库结构变更。
 *
 * 结构变更指工作树登记、子模块目录或 `.gitmodules` 的变化；接收方据此重新枚举仓库树。
 *
 * @param repo - 结构发生变化的仓库路径。
 * @returns 无。
 */
function broadcastRepositoryTree(repo: string): void {
	broadcastEvent('repository-tree', repo);
}

/**
 * 向所有事件流连接推送一条事件帧。
 *
 * @param event - 事件名。
 * @param repo - 仓库路径。
 * @returns 无。
 */
function broadcastEvent(event: string, repo: string): void {
	const frame = `event: ${event}\ndata: ${JSON.stringify({ repo })}\n\n`;
	for (const stream of eventStreams) {
		try {
			stream.write(frame);
		} catch {
			/* 连接已断开时由 close 事件清理 */
		}
	}
}

/**
 * 处理一条事件流连接。
 *
 * 通道只做一件事：把本进程里任何**成功**的仓库写操作推给所有面板，让别的会话、别的工作区与
 * 外部进程造成的改动也能即时反映。推送不携带数据，接收方自行重读。
 *
 * @param req - 请求。
 * @param res - 响应。
 * @returns 无。
 */
function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
	if (eventStreams.size >= MAX_EVENT_STREAMS) {
		sendJson(res, 503, { error: '事件流连接数已达上限' });
		return;
	}
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-store',
		'connection': 'keep-alive',
	});
	res.write(': connected\n\n');
	eventStreams.add(res);
	const heartbeat = setInterval(() => {
		try {
			res.write(': ping\n\n');
		} catch {
			/* 写失败由 close 事件清理 */
		}
	}, EVENTS_HEARTBEAT_MS);
	// 保活不应阻止宿主退出。
	if (typeof heartbeat.unref === 'function') heartbeat.unref();
	const close = (): void => {
		clearInterval(heartbeat);
		eventStreams.delete(res);
	};
	req.on('close', close);
	res.on('close', close);
}

/**
 * 处理一条 API 命令。
 *
 * @param req - 请求。
 * @param res - 响应。
 * @param aiDeps - AI 与翻译依赖面；翻译服务可选装载，缺失时相关命令降级。
 */
async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, aiDeps?: AiCommitDeps): Promise<void> {
	let msg: Record<string, unknown>;
	try {
		msg = await readBody(req);
	} catch {
		sendBadRequest(res, '请求体不是合法 JSON');
		return;
	}
	const repo = typeof msg.repo === 'string' ? msg.repo : '';
	if (!repo) {
		sendBadRequest(res, '缺少 repo');
		return;
	}

	const str = (k: string): string => (typeof msg[k] === 'string' ? msg[k] : '');
	const strOrNull = (k: string): string | null => (typeof msg[k] === 'string' ? msg[k] : null);
	const bool = (k: string, dflt = false): boolean => (typeof msg[k] === 'boolean' ? msg[k] : dflt);
	const num = (k: string, dflt = 0): number => (typeof msg[k] === 'number' ? msg[k] : dflt);
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
	const respondResult = async (cmd: string, fn: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<void> => {
		try {
			respond({ command: cmd, ...(await fn()), error: null });
		} catch (error) {
			respond({ command: cmd, error: error instanceof Error ? error.message : String(error) });
		}
	};

	switch (msg.command as string) {
		/* --- 工作区变更（DSH 版新增：变更列表 / 暂存 / 提交 / 丢弃） --- */
		case 'loadWorkingTree':
			await respondResult('loadWorkingTree', async () => {
				// 写操作（暂存/提交/检出等）未结束时先等它结束：否则会读到写了一半的工作区。
				await whenGitIdle(repo);
				return { repo, entries: await loadWorkingTree(repo) };
			});
			break;
		case 'loadWorkingTreeSnapshot': {
			// 结果自带 error 字段，因此不经 respondResult —— 它会在展开后再写一次 error: null。
			await whenGitIdle(repo);
			const cachedSnapshot = readSnapshot(repo);
			if (cachedSnapshot !== undefined) {
				respond({ command: 'loadWorkingTreeSnapshot', repo, ...cachedSnapshot });
				break;
			}
			const snapshot = await getWorkingTreeSnapshot(repo);
			// 失败结果同样缓存：紧接着的重试会命中，避免连续失败反复起 git。
			writeSnapshot(repo, snapshot);
			respond({ command: 'loadWorkingTreeSnapshot', repo, ...snapshot });
			break;
		}
		case 'stagePaths':
			await respondResult('stagePaths', async () => { await stagePaths(repo, arr<string>('paths')); return { repo }; });
			break;
		case 'unstagePaths':
			await respondResult('unstagePaths', async () => { await unstagePaths(repo, arr<string>('paths')); return { repo }; });
			break;
		case 'discardPaths':
			await respondResult('discardPaths', async () => {
				const outcome = await discardPaths(repo, arr<string>('paths'), bool('untracked'));
				return { repo, ...outcome };
			});
			break;
		case 'commitStaged':
			await respondResult('commitStaged', async () => ({ repo, hash: await commitStaged(repo, str('message'), bool('amend'), bool('skipHooks')) }));
			break;
		case 'addToGitignore':
			await respondResult('addToGitignore', async () => ({ result: await addToGitignore(repo, str('path')) }));
			break;
		case 'addToLocalExclude':
			await respondResult('addToLocalExclude', async () => ({ state: await addToLocalExclude(repo, str('path')) }));
			break;
		case 'localExcludeState':
			await respondResult('localExcludeState', async () => ({ state: await localExcludeState(repo) }));
			break;
		case 'removeWorktree':
			await respondResult('removeWorktree', async () => {
				const worktreePath = str('worktreePath');
				await removeWorktree(repo, worktreePath, bool('force'));
				return { repo, worktreePath };
			});
			break;
		case 'initSubmodule':
			await respondResult('initSubmodule', async () => {
				const submodulePath = str('submodulePath');
				await initSubmodule(repo, submodulePath);
				return { repo, submodulePath };
			});
			break;
		case 'hooksState':
			await respondResult('hooksState', async () => {
				/*
				 * `core.hooksPath` 由 git 解析（含 includeIf 等条件），因此读它的取值而不是只看
				 * `.git/hooks`；读取失败时按未配置处理，退回默认钩子目录。
				 */
				const configured = await runGit(['config', '--get', 'core.hooksPath'], repo);
				const hooksPath = configured.code === 0 ? configured.stdout.trim() : '';
				const state = await detectHooks(repo, hooksPath);
				return { repo, commit: state.commit, push: state.push, directory: state.directory };
			});
			break;
		case 'branchesContaining':
			// 分支只由尖端提交标识，中间提交的 heads 为空；按包含关系查询才能列出所属分支。
			await respondResult('branchesContaining', async () => {
				const hash = str('commitHash');
				const localOut = await gitOrThrow(['branch', '--contains', hash, '--format=%(refname:short)'], repo);
				// 别的工作树占用的分支不可删除，不作为删除候选；`foreign` 另行回投，供调用方禁用相关操作。
				const foreign = await branchesOfOtherWorktrees(repo);
				const local = localOut.split('\n').map((line) => line.trim())
					.filter((line) => line !== '' && !foreign.has(line));
				const remoteOut = await gitOrThrow(['branch', '-r', '--contains', hash, '--format=%(refname:short)'], repo);
				// 远程 HEAD 是符号引用，短名只显示远程名本身（如 `origin`），须排除。
				const remoteNames = new Set((await gitOrThrow(['remote'], repo)).split('\n').map((line) => line.trim()));
				const remote = remoteOut.split('\n').map((line) => line.trim())
					.filter((line) => line !== '' && !line.endsWith('/HEAD') && !remoteNames.has(line));
				return { repo, local, remote, foreign: [...foreign] };
			});
			break;

		/* --- 仓库发现（DSH 版新增：≤3 层递归 + 工作树/子模块权威枚举） --- */
		/* --- 插件状态持久化：设置、布局、引用筛选、仓库位置缓存（落 $DSH_HOME/dsh-source-control/） --- */
		case 'readState':
			await respondResult('readState', () => ({ entries: readEntries() }));
			break;
		case 'writeState':
			await respondResult('writeState', () => {
				writeEntry(str('key'), msg.value === undefined ? null : msg.value);
				return { repo };
			});
			break;
		case 'readRepoLocations':
			await respondResult('readRepoLocations', () => ({ repos: readRepoLocations(repo) }));
			break;
		case 'writeRepoLocations':
			await respondResult('writeRepoLocations', () => {
				const repos = arr<{ path?: unknown; name?: unknown }>('repos')
					.filter((item) => typeof item.path === 'string' && item.path !== '')
					.map((item) => ({ path: item.path as string, name: typeof item.name === 'string' ? item.name : '' }));
				writeRepoLocations(repo, repos);
				return { repo };
			});
			break;
		case 'discoverRepositories':
			await respondResult('discoverRepositories', async () => {
				// knownRepos 命中时走快路径：只核对已知路径，不逐层扫描目录。
				const knownRepos = arr<string>('knownRepos').filter((path) => typeof path === 'string' && path !== '');
				const result = await discoverWorkspace(repo, {
					shallow: bool('shallow'),
					fullScan: bool('fullScan'),
					maxDepth: num('maxDepth', 3),
					knownRepos: knownRepos.length > 0 ? knownRepos : undefined,
				});
				// 顶层仓库纳入结构监视：工作树与子模块的增删由此即时反映。
				watchRepositories(result.nodes.filter((node) => node.kind === 'repo').map((node) => node.path));
				// 工作区根本身纳入监视：新建或删除的仓库此前没有任何句柄，只能由这一层发现。
				watchWorkspace(repo);
				return { root: repo, nodes: result.nodes, truncated: result.truncated, usedCache: result.usedCache };
			});
			break;
		case 'enrichRepositories':
			await respondResult('enrichRepositories', async () => {
				// 入参为空时不扫目录：nodes 为空数组。
				const repos = arr<string>('repos').filter((path) => typeof path === 'string' && path !== '');
				if (repos.length === 0) return { nodes: [] };
				const nodes = await enrichRepositories(repos);
				// 补齐结果里的工作树与子模块同样纳入监视：它们的登记项增删要即时反映。
				watchRepositories(flattenRepoPaths(nodes));
				return { nodes };
			});
			break;
		case 'loadRepoSync':
			await respondResult('loadRepoSync', async () => {
				await whenGitIdle(repo);
				const sync = await loadRepoSync(repo);
				return { repo, branch: sync.branch, upstream: sync.upstream, ahead: sync.ahead, behind: sync.behind };
			});
			break;
		case 'loadReposSync':
			await respondResult('loadReposSync', async () => {
				// 入参路径逐个回显：结果按 path 与入参一一对应。
				const repos = arr<string>('repos').filter((path) => typeof path === 'string' && path !== '');
				// 空列表不读仓库：results 为空数组。
				if (repos.length === 0) return { repo, results: [] };
				await whenGitIdle(repo);
				return { repo, results: await loadReposSync(repos) };
			});
			break;

		/* --- 数据查询 --- */
		case 'loadRepoInfo': {
			await whenGitIdle(repo);
			const showRemoteBranches = bool('showRemoteBranches', true);
			const showStashes = bool('showStashes', true);
			const hideRemotes = arr<string>('hideRemotes');
			let repoInfo = readRepoInfo(repo, { showRemoteBranches, showStashes, hideRemotes });
			if (repoInfo === undefined) {
				repoInfo = await getRepoInfo(repo, showRemoteBranches, showStashes, hideRemotes);
				// 只缓存成功的读取：失败文本可能来自瞬时故障，缓存会让它停留整个 TTL。
				if (repoInfo.error === null) writeRepoInfo(repo, { showRemoteBranches, showStashes, hideRemotes }, repoInfo);
			}
			let isRepo = true;
			if (repoInfo.error) {
				isRepo = (await repoRoot(repo)) !== null;
				if (!isRepo) repoInfo = { ...repoInfo, error: null };
			}
			respond({ command: 'loadRepoInfo', refreshId: num('refreshId'), ...repoInfo, isRepo });
			break;
		}
		case 'loadCommits':
			// 提交图同样等写操作结束：写操作可能正在改写引用。
			await whenGitIdle(repo);
			{
				/*
				 * 偏移分页：客户端传 `skip`（已加载条数）与 `limit`，git 跳过前 skip 条再输出本页。
				 *
				 * 用偏移而不是 hash 游标：hash 游标只能从一个提交往更早方向走，向上回看时无法用它定位；
				 * 偏移则正反向都能取，代价是 git 端多遍历 skip 条（纯指针跳转，无 IO）。
				 */
				const limit = num('limit', num('maxCommits', 32));
				const skip = num('skip', 0);
				const showStashes = bool('showStashes', true);
				const showRemoteBranches = bool('showRemoteBranches', true);
				const hideRemotes = arr<string>('hideRemotes');
				const branchesArg = msg.branches === null || Array.isArray(msg.branches) ? (msg.branches as string[] | null) : null;
				/*
				 * 贮藏：调用方给出列表时以它为准（空数组同样表示没有贮藏）；未给出时按 `showStashes`
				 * 单独枚举。该取值同时交给仓库信息批与 `getCommits`，两者因此共用一次读取。
				 */
				const givenStashes = Array.isArray(msg.stashes) ? (msg.stashes as StashEntry[]) : null;
				/*
				 * 远程名：调用方在前端是 `Remote` 对象数组，数据层按远程名标注远程分支的归属，
				 * 这里取名字；直接传字符串数组的调用方同样接受。
				 *
				 * 客户端首次取数后即持有远程列表并随每次刷新传入，因此空列表只在调用方未提供时出现。
				 */
				const givenRemotes = arr<unknown>('remotes')
					.map((remote) => (typeof remote === 'string' ? remote : (remote as { name?: unknown } | null)?.name))
					.filter((name): name is string => typeof name === 'string' && name !== '');
				/*
				 * 缓存键含全部会改变 `getCommits` 结果的参数：除排序、分页与引用筛选外，贮藏标识与
				 * 远程名也参与组装提交行，参数不同必须落到不同的窗口。
				 */
				const graphParams = {
					maxCommits: limit, skip,
					ordering: (typeof msg.commitOrdering === 'string' ? msg.commitOrdering : 'topo'),
					showTags: bool('showTags', true),
					showRemoteBranches,
					showStashes,
					onlyFollowFirstParent: bool('onlyFollowFirstParent'),
					includeCommitsMentionedByReflogs: bool('includeCommitsMentionedByReflogs'),
					hideRemotes,
					branches: branchesArg,
					remotes: givenRemotes,
					/*
					 * 贮藏标识：调用方未给出时为 `*`，表示由宿主按 `showStashes` 自行枚举——那份
					 * 结果通常非空，与「给出空列表」不是同一批提交行。
					 */
					stashes: givenStashes === null ? ['*'] : givenStashes.map((stash) => stash.hash),
				};
				/*
				 * 窗口缓存留在宿主内存：切回同一仓库、翻页回看已取过的窗口都命中，客户端不必
				 * 跨会话搬运数据。任何成功的仓库写操作都会清空该缓存。
				 */
				const cachedGraph = readGraph(repo, graphParams);
				if (cachedGraph !== undefined) {
					const lastCached = cachedGraph.commits.at(-1);
					/*
					 * 仓库信息同样来自宿主缓存：命中窗口时一并回投，客户端不必为远程与贮藏
					 * 再发一次请求。缓存里没有时留给客户端按需补取。
					 */
					const cachedInfo = readRepoInfo(repo, { showRemoteBranches, showStashes, hideRemotes }) ?? null;
					respond({
						command: 'loadCommits',
						refreshId: num('refreshId'),
						error: null,
						onlyFollowFirstParent: graphParams.onlyFollowFirstParent,
						commits: cachedGraph.commits,
						head: cachedGraph.head,
						tags: cachedGraph.tags,
						moreCommitsAvailable: cachedGraph.moreCommitsAvailable,
						nextSkip: cachedGraph.nextSkip,
						nextCursor: cachedGraph.moreCommitsAvailable && lastCached !== undefined ? lastCached.hash : null,
						foreignBranches: cachedGraph.foreignBranches,
						repoInfo: cachedInfo,
					});
					break;
				}
				/*
				 * 仓库信息批由 `withRepoInfo` 显式控制，与「是否首屏」无关：刷新（skip 为 0）不必
				 * 重取仓库信息，调用方把已知的远程与贮藏随请求传入。
				 *
				 * 该批含仓库信息、引用集合、贮藏枚举与工作树分支，四者互不依赖，同批并行。
				 * 仓库信息以 `repoInfo` 随响应发回，客户端首次进入因此只发一次请求。
				 */
				const withRepoInfo = msg.withRepoInfo === true;
				/*
				 * 贮藏取自前面已解析的 `givenStashes`：给出列表时以它为准（空数组同样表示没有贮藏）；
				 * 未给出时按 `showStashes` 单独枚举。该取值同时交给仓库信息批与 `getCommits`，
				 * 两者因此共用一次读取。
				 */
				const stashesSource: Promise<StashEntry[]> = givenStashes !== null
					? Promise.resolve(givenStashes)
					: showStashes ? getStashes(repo) : Promise.resolve<StashEntry[]>([]);
				/*
				 * 引用集合与分支列表读自同一批引用，只取值不同：一次 `for-each-ref` 同时得到两者。
				 * 首屏（`withRepoInfo`）下两者都有人要，合并后少起一个子进程；刷新路径只有提交图
				 * 需要引用，因此只在首屏预先发起。
				 */
				const refsAndBranchesSource = withRepoInfo
					? getRefsAndBranches(repo, showRemoteBranches, hideRemotes)
					: null;
				const batchSource = withRepoInfo
					? Promise.all([
						getRepoInfo(repo, showRemoteBranches, showStashes, hideRemotes, refsAndBranchesSource ?? undefined),
						refsAndBranchesSource?.then((parsed) => parsed.refs) ?? getRefsForGraph(repo, showRemoteBranches, hideRemotes),
						stashesSource,
						branchesOfOtherWorktrees(repo),
					]).then(([info, refs, stashes, foreign]) => ({ info, refs, stashes, foreign }), () => null)
					: null;
				const stashes = await stashesSource;
				/*
				 * 别的工作树占用的分支：仓库信息批里已含该结果时直接取用，否则单独判定。
				 * 该判定对没有链接工作树的仓库只读文件系统，不启动 git；先发出去，不占关键路径。
				 *
				 * 同样先挂吞错分支：下游提前失败时，未处理的 rejection 会让宿主进程直接退出。
				 */
				const foreignSource: Promise<Set<string>> = (batchSource !== null
					? batchSource.then((batch) => batch?.foreign ?? branchesOfOtherWorktrees(repo))
					: branchesOfOtherWorktrees(repo)).catch(() => new Set<string>());
				/*
				 * 远程名可能来自仓库信息批，也可能需要单独读取。后者是一个 Promise：若下游在它
				 * 落地前就失败，未处理的 rejection 会让宿主进程直接退出（表现为 fatal load failure），
				 * 因此先挂一个吞错分支，真正的错误仍由 getCommits 内部的 catch 转成 error 字段。
				 */
				const remoteNames: readonly string[] | Promise<readonly string[]> = batchSource !== null
					? batchSource.then((batch) => batch?.info.remotes.map((remote) => remote.name) ?? givenRemotes)
					: givenRemotes.length > 0 ? givenRemotes : getRemoteNames(repo).catch(() => [] as string[]);
				// getCommits 内部已按「多取一条作哨兵」判断是否还有更多。
				const data = await getCommits(
					repo,
					branchesArg,
					limit,
					graphParams.showTags,
					showRemoteBranches,
					graphParams.includeCommitsMentionedByReflogs,
					graphParams.onlyFollowFirstParent,
					graphParams.ordering as never,
					remoteNames,
					hideRemotes,
					stashes,
					skip,
					batchSource?.then((batch) => batch?.refs ?? getRefsForGraph(repo, showRemoteBranches, hideRemotes)) ?? undefined,
				);
				const batch = batchSource === null ? null : await batchSource;
				// 仓库信息成功取回时写入缓存，后续命中窗口的请求因此能一并回投它。
				if (batch !== null && batch.info.error === null) {
					writeRepoInfo(repo, { showRemoteBranches, showStashes, hideRemotes }, batch.info);
				}
				/*
				 * 别的工作树占用的分支照常作为标签显示：它们确实指向该提交，只是不能在本工作树里
				 * 检出或删除。这类分支名随响应回投，客户端据此禁用相应操作。
				 */
				const foreign = await foreignSource;
				const all = data.commits;
				// 游标取本页最后一条：git 会从该提交重新输出它，由客户端按 hash 去重。
				const last = all.at(-1);
				// 只缓存成功的读取：失败文本可能来自瞬时故障，缓存会让它停留整个 TTL。
				if (data.error === null) {
					writeGraph(repo, graphParams, {
						commits: all, head: data.head, tags: data.tags,
						moreCommitsAvailable: data.moreCommitsAvailable, nextSkip: data.nextSkip,
						foreignBranches: [...foreign],
					});
				}
				respond({
					command: 'loadCommits',
					refreshId: num('refreshId'),
					// 成功路径的 error 恒为 null：既有契约要求该字段存在。
					error: null,
					onlyFollowFirstParent: graphParams.onlyFollowFirstParent,
					commits: all,
					head: data.head,
					tags: data.tags,
					moreCommitsAvailable: data.moreCommitsAvailable,
					nextSkip: data.nextSkip,
					nextCursor: data.moreCommitsAvailable && last !== undefined ? last.hash : null,
					// 别的工作树占用的分支：客户端据此禁用检出、删除与重命名。
					foreignBranches: [...foreign],
					// 带 `withRepoInfo` 时随响应取回的仓库信息；其余请求为 null。
					repoInfo: batch?.info ?? null,
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
		case 'merge':
			respond({
				command: 'merge',
				actionOn: msg.actionOn,
				error: await merge(repo, str('obj'), typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch', bool('createNewCommit'), bool('squash'), bool('noCommit')),
			});
			break;
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
		case 'rebase':
			respond({
				command: 'rebase',
				actionOn: msg.actionOn,
				interactive: bool('interactive'),
				error: await rebase(repo, str('obj'), typeof msg.actionOn === 'string' ? msg.actionOn : 'Branch', bool('ignoreDate', true), bool('interactive')),
			});
			break;

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
			// 用 gh CLI 创建 PR：非交互，标题与正文由前端给出。
			await respondResult('createPullRequest', async () => ({
				url: await ghCreatePullRequest(repo, {
					head: str('head'),
					base: str('base'),
					title: str('title'),
					body: str('body'),
					draft: bool('draft'),
				}),
			}));
			break;

		/* --- GitHub 集成（gh CLI） --- */
		case 'ghAccount':
			await respondResult('ghAccount', async () => ({ account: await ghAccount(repo) }));
			break;
		case 'ghOwners':
			await respondResult('ghOwners', async () => ({ owners: await ghOwners(repo) }));
			break;
		case 'ghRepoInfo':
			await respondResult('ghRepoInfo', async () => ({ info: await ghRepoInfo(repo) }));
			break;
		case 'ghCreateRepo':
			await respondResult('ghCreateRepo', async () => ({
				url: await ghCreateRepo(repo, {
					name: str('name'),
					owner: str('owner'),
					private: bool('private'),
					description: str('description'),
					remote: str('remote') === '' ? 'origin' : str('remote'),
					protocol: str('protocol') === 'ssh' ? 'ssh' : 'https',
				}),
			}));
			break;
		case 'sshStatus':
			await respondResult('sshStatus', async () => ({
				status: await sshStatus(str('host') === '' ? 'github.com' : str('host'), str('refresh') === 'true'),
			}));
			break;
		case 'openExtensionSettings':
		case 'openExternalDirDiff':
		case 'openExternalUrl':
		case 'openFile':
		case 'openTerminal':
		case 'viewFileAtRevision':
		case 'viewScm':
			respond({ command: msg.command, error: '该操作在当前版本中暂不支持' });
			break;

		/* --- Diff：DSH 右侧栏无通用 git diff 页类型，与其它专属命令一致回错误，
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
			console.error('[dsh-source-control] ' + (typeof msg.message === 'string' ? msg.message : ''));
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
			const baseHash = str('baseHash');
			const staged = bool('staged');
			try {
				let oldText: string | null = null;
				let newText: string | null = null;
				if (baseHash !== '') {
					// 两提交对比：旧侧取 baseHash，新侧取 commitHash（'*' 表示工作区文件）。
					try { oldText = await gitOrThrow(['show', `${baseHash}:${filePath}`], repo); } catch { oldText = null; }
					if (commitHash === '*') {
						try { newText = await fs.readFile(nodePath.resolve(repo, filePath), 'utf8'); } catch { newText = null; }
					} else {
						try { newText = await gitOrThrow(['show', `${commitHash}:${filePath}`], repo); } catch { newText = null; }
					}
				} else if (commitHash === '*') {
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
				const hunks = await diffHunksOf(repo, commitHash, filePath, staged, baseHash);
				respond({ command: 'fileDiffContent', path: filePath, oldText, newText, hunks });
			} catch (e) {
				respond({ command: 'fileDiffContent', path: filePath, oldText: null, newText: null, hunks: [], error: e instanceof Error ? e.message : String(e) });
			}
			break;
		}
		case 'rescanForRepos':
			respond({ command: 'rescanForRepos' });
			break;
		case 'translateAvailable':
			// 翻译服务由 cot-translation bundle 可选装载；未装载时前端不显示翻译入口。
			respond({ command: 'translateAvailable', available: usableTranslator(aiDeps?.getTranslator?.()) !== undefined });
			break;
		case 'translateText': {
			// 逐段翻译：调用方按标题与正文行拆分后分别请求，避免整段被译成一行。
			const text = str('text');
			const targetLanguage = str('targetLanguage');
			if (text === '') { sendBadRequest(res, '缺少 text'); break; }
			if (targetLanguage === '') { sendBadRequest(res, '缺少 targetLanguage'); break; }
			await respondResult('translateText', async () => ({
				text: await translateWithService(aiDeps?.getTranslator?.(), text, targetLanguage),
			}));
			break;
		}
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
		/*
		 * 主动作废宿主缓存：用户点刷新时使用。
		 *
		 * 写操作已由执行层自动作废该仓库的缓存；这个命令覆盖「外部进程改了仓库、但没有经过本插件」
		 * 的情形——那种改动不产生写事件，宿主无从得知。
		 */
		case 'invalidateCache':
			clearHostCache();
			respond({ command: 'invalidateCache', repo, error: null });
			break;

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
	/** 取官方 translator 服务；未装载时为 undefined，翻译入口据此降级。 */
	getTranslator?: () => unknown;
}

/**
 * 语言提示词：告知模型用哪种语言写提交信息。
 *
 * 模型带提示词缓存，改语言会命中不同缓存；因此只在调用方给出语言时追加，
 * 未给出（空串）时提示词与以往完全一致，不破坏既有缓存。
 *
 * @param language - 语言标签，如 `zh-CN`；空串表示不指定。
 * @returns 追加到系统提示词末尾的一段文本；不指定时为空串。
 */
function languageDirective(language: string): string {
	if (language === '') return '';
	return '\n\n' + fillPrompt(AI_COMMIT_PROMPTS.language, { language });
}

/**
 * 取官方 translator 服务；未装载时返回 undefined。
 *
 * @param translator - 依赖面给出的服务实例。
 * @returns 具备 resolve 与 translate 的服务；不可用时为 undefined。
 */
function usableTranslator(translator: unknown): { resolve: (request: { text: string; targetLanguage: string }) => unknown; translate: (spec: unknown) => Promise<string> } | undefined {
	const service = translator as {
		resolve?: (request: { text: string; targetLanguage: string }) => unknown;
		translate?: (spec: unknown) => Promise<string>;
	} | undefined;
	if (service === undefined || typeof service.resolve !== 'function' || typeof service.translate !== 'function') return undefined;
	return service as { resolve: (request: { text: string; targetLanguage: string }) => unknown; translate: (spec: unknown) => Promise<string> };
}

/**
 * 用官方 translator 服务翻译一段文本。
 *
 * 该服务由 cot-translation bundle 可选装载；不可用时抛出可读错误，前端另有
 * `translateAvailable` 查询，正常情况下不会走到这里。
 *
 * @param translator - translator 服务实例。
 * @param text - 待翻译文本。
 * @param targetLanguage - 目标语言标签。
 * @returns 译文。
 */
async function translateWithService(translator: unknown, text: string, targetLanguage: string): Promise<string> {
	const service = usableTranslator(translator);
	if (service === undefined) throw new Error('未装载翻译服务（translator），无法翻译');
	return await service.translate(service.resolve({ text, targetLanguage }));
}

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
		const efforts = info.reasoning?.efforts;
		if (!Array.isArray(efforts)) return false;
		return efforts.some((e) => e.id === 'off');
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
		const sel = svc.currentSelection?.() as { provider?: string; model?: string } | null;
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
/**
 * 取某个文件的逐块差异。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 目标提交；`*` 表示工作区。
 * @param filePath - 文件路径（相对仓库根）。
 * @param staged - 工作区时是否取暂存区内容。
 * @param baseHash - 旧侧提交；非空时按 `baseHash → commitHash` 对比。
 * @returns 逐块差异；取不到时为空数组。
 */
async function diffHunksOf(repo: string, commitHash: string, filePath: string, staged: boolean, baseHash = ''): Promise<DiffHunkText[]> {
	const args = baseHash !== ''
		? ['diff', '--no-color', '--unified=3', baseHash, commitHash === '*' ? '' : commitHash, '--', filePath].filter((part) => part !== '')
		: commitHash === '*'
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

	/**
	 * 注册一条只接受单一 HTTP 方法的精确路由。
	 *
	 * 方法不符时回 405 并给出 `allow`；符合时执行 `handler`。
	 *
	 * @param path - 路由路径。
	 * @param method - 允许的方法。
	 * @param handler - 方法符合时的处理函数。
	 * @returns 无。
	 */
	const registerMethodRoute = (
		path: string,
		method: 'GET' | 'POST',
		handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
	): void => {
		disposers.push(
			webServer.register({
				kind: 'exact',
				path,
				handler: (req, res) => {
					if (req.method !== method) {
						res.writeHead(405, { allow: method });
						res.end();
						return;
					}
					handler(req, res);
				},
			}),
		);
	};

	// 仓库写操作（含别的会话、别的工作区与外部进程触发的）推给所有面板。
	disposers.push(onRepositoryWrite(broadcastRepositoryWrite));

	// 工作树登记、子模块目录与 `.gitmodules` 的变化推给所有面板：这类变化不经过执行层。
	disposers.push(onRepositoryTreeChange((repo) => {
		// 结构已变：发现结果缓存立即作废，重取才能看到新增或消失的工作树与子模块。
		clearDiscoveryCache();
		broadcastRepositoryTree(repo);
	}));
	disposers.push(closeRepositoryWatchers);

	// 事件流（GET）：面板据此即时反映别处的写操作。
	registerMethodRoute('/dsh-source-control/gg/events', 'GET', (req, res) => { handleEvents(req, res); });

	// 消息 API（POST）：前端面板与宿主之间的唯一通道。
	registerMethodRoute('/dsh-source-control/gg/api', 'POST', (req, res) => {
		void handleApi(req, res, aiDeps).catch((e: unknown) => {
			sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
		});
	});

	// AI 模型目录（GET）：供应商列表 + 每供应商的模型 id。
	registerMethodRoute('/dsh-source-control/gg/ai-models', 'GET', (req, res) => {
		const llm = aiDeps?.getLlm?.() as { listProviders?: () => unknown[]; listModels?: (p: string) => Promise<unknown[]> } | undefined;
		if (!llm || typeof llm.listProviders !== 'function') { sendJson(res, 200, { providers: [], modelsByProvider: {} }); return; }
		const providers: Array<{ id: string; name: string }> = [];
		try {
			const raw = llm.listProviders();
			for (const p of (Array.isArray(raw) ? raw : [])) {
				const id = (p as { id?: string }).id ?? '';
				if (id.length > 0) providers.push({ id, name: (p as { name?: string }).name ?? id });
			}
		} catch { /* 目录不可用 */ }
		void (async () => {
			const modelsByProvider: Record<string, string[]> = {};
			for (const p of providers) {
				try {
					const list = typeof llm.listModels === 'function' ? await llm.listModels(p.id) : [];
					modelsByProvider[p.id] = (Array.isArray(list) ? list : [])
						.map((m) => (m as { id?: string }).id ?? '')
						.filter((id) => id.length > 0);
				} catch { modelsByProvider[p.id] = []; }
			}
			const fallback = getAgentDefaultSelection(aiDeps?.getAgentDefaultModel);
			sendJson(res, 200, { providers, modelsByProvider, fallback });
		})();
	});

	// AI 提交信息生成（POST，SSE 流式）：取暂存 diff → 调 llm.stream → 逐 chunk 推送。
	registerMethodRoute('/dsh-source-control/gg/ai-commit', 'POST', (req, res) => {
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
			if (diff.trim() === '') {
				sendJson(res, 400, { error: amend ? '无 diff 可生成提交信息（上一次提交与工作区均无改动）' : '无 diff 可生成提交信息（暂存区与工作区均为空）' });
				return;
			}

			const rules = typeof body.rules === 'string' ? body.rules.trim() : '';
			// 语言由前端给出（取自 DSH 当前界面语言）；空串时提示词与以往一致。
			const language = typeof body.language === 'string' ? body.language.trim() : '';
			const systemPrompt = AI_COMMIT_PROMPTS.system
				+ languageDirective(language)
				+ (rules.length > 0 ? '\n\n' + rules : '');
			const off = await canDisableReasoning(llm, provider, model);
			const request = fillPrompt(amend ? AI_COMMIT_PROMPTS.requestAmend : AI_COMMIT_PROMPTS.request, { diff });
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
			/*
			 * 首个输出增量到达的时刻，作为 tok/s 的计时起点。
			 *
			 * 起点不含请求上传与提示词处理时间。`text-delta` 与 `reasoning-delta` 都算
			 * 输出：`usage.outputTokens` 包含推理 token。
			 */
			let firstOutputTime: number | null = null;
			let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null = null;
			try {
				const stream = llm.stream(streamOpts) as AsyncIterable<{ type?: string; text?: string; reason?: { kind?: string; failure?: { code?: string; status?: number; message?: string } }; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>;
				for await (const chunk of stream) {
					if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
						if (firstOutputTime === null) firstOutputTime = Date.now();
						sse('chunk', chunk.text);
					} else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
						if (firstOutputTime === null) firstOutputTime = Date.now();
					} else if (chunk.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage;
					else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
						const f = chunk.reason.failure;
						const parts = [f?.code, f?.status === undefined ? undefined : `HTTP ${f.status}`, f?.message].filter((x): x is string => typeof x === 'string' && x.length > 0);
						sse('error', parts.length > 0 ? parts.join(' ') : '模型返回错误');
					}
				}
				const endTime = Date.now();
				const totalSec = (endTime - startTime) / 1000;
				/*
				 * 时长拆两段：`elapsed` 为解码时长（总时长扣除首 token 延迟），
				 * `ttft` 为首 token 延迟。全程无输出时 ttft 为 0、elapsed 为总时长。
				 */
				const ttftSec = firstOutputTime === null ? 0 : (firstOutputTime - startTime) / 1000;
				const elapsedSec = totalSec - ttftSec;
				const outTok = usage?.outputTokens ?? 0;
				const tps = elapsedSec > 0 && outTok > 0 ? Math.round(outTok / elapsedSec) : 0;
				sse('stats', {
					tps,
					elapsed: elapsedSec.toFixed(1) + 's',
					ttft: ttftSec.toFixed(1) + 's',
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
		})().catch((e: unknown) => {
			/*
			 * 响应头发出前的失败（读请求体、取 diff、解析模型）按 JSON 回 500；此时没有
			 * 可用的 SSE 通道，不能走 `sse()`。响应头已发出时只结束响应。
			 */
			if (res.headersSent) {
				res.end();
				return;
			}
			sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
		});
	});

	return disposers;
}
