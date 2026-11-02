/**
 * 提交图与仓库信息查询命令：仓库信息、提交窗口、引用、分叉来源、配置、提交详情与两提交对比。
 */
import {
	getBranchBase, getCommitComparison, getCommitDetails, getCommits, getConfig, getRefSummaries,
	getRepoInfo, getRemoteNames, getStashDetails, getStashes, getUncommittedDetails, repoRoot,
} from '../git-query.js';
import { branchesOfOtherWorktrees } from '../repo-discovery.js';
import { graphKey, readGraph, readRepoInfo, writeGraph, writeRepoInfo } from '../host-cache.js';
import { repoHead } from '../repo-facts.js';
import { whenGitIdle, whenWorktreeIdle } from '../git-exec.js';
import { logDebug } from '../logger.js';
import type { StashEntry } from '../git-types.js';
import type { ApiContext } from './context.js';

/**
 * 拼提交图窗口取数参数的可读描述。
 *
 * 键里含全部影响结果的参数，日志也要含它们：只给 skip 与 limit 时，同一秒内几次未命中
 * 无法判断是重复请求还是不同窗口。
 *
 * @param params - 取数参数。
 * @returns 一段可直接接在仓库路径后的描述。
 */
function graphParamsLog(params: Parameters<typeof graphKey>[1]): string {
	const flags: string[] = [];
	if (params.skip !== 0) flags.push(`skip=${String(params.skip)}`);
	flags.push(`limit=${String(params.maxCommits)}`);
	if (params.ordering !== 'topo') flags.push(`排序=${params.ordering}`);
	if (!params.showTags) flags.push('无标签');
	if (!params.showRemoteBranches) flags.push('无远程分支');
	if (!params.showStashes) flags.push('无贮藏');
	if (params.onlyFollowFirstParent) flags.push('只跟第一个父提交');
	if (params.includeCommitsMentionedByReflogs) flags.push('含 reflog 提及');
	if (params.hideRemotes.length > 0) flags.push(`隐藏远程 ${params.hideRemotes.join(',')}`);
	if (params.branches !== null) flags.push(`引用 ${params.branches.length > 0 ? params.branches.join(',') : '（空）'}`);
	if (params.remotes.length > 0) flags.push(`远程 ${params.remotes.join(',')}`);
	// 贮藏键在调用方未给列表时是 `*`：与「确实没有贮藏」不是同一批提交行。
	if (params.stashes.length > 0) flags.push(`贮藏 ${params.stashes.join(',')}`);
	const head = params.head === null ? '分离头指针或未提交' : params.head.slice(0, 8);
	return `（HEAD ${head}，${flags.join('，')}）`;
}

/**
 * 处理提交图与仓库信息查询的一条命令。
 *
 * @param ctx - 命令上下文。
 * @returns 是否已处理；未识别的命令返回 false。
 */
export async function handleGraphCommand(ctx: ApiContext): Promise<boolean> {
	const { msg, repo, str, bool, num, arr, isRepoPath, respond, respondResult } = ctx;
	switch (ctx.command) {
		case 'loadRepoInfo': {
			// 读远程与贮藏列表：不碰工作区，抓取期间照常读。
			await whenWorktreeIdle(repo);
			/*
			 * 非仓库路径直接回空信息，不起子进程。原先靠 getRepoInfo 失败后再启一次
			 * `git rev-parse` 反判，等于先失败一遍再确认。
			 */
			if (!(await isRepoPath(repo))) {
				logDebug('repo', `目标路径不是 git 仓库，按空仓库信息返回：${repo}`);
				respond({
					command: 'loadRepoInfo', refreshId: num('refreshId'),
					branches: [], head: null, remotes: [], stashes: [], error: null, isRepo: false,
				});
				break;
			}
			const showRemoteBranches = bool('showRemoteBranches', true);
			const showStashes = bool('showStashes', true);
			const hideRemotes = arr<string>('hideRemotes');
			let repoInfo = readRepoInfo(repo, { showRemoteBranches, showStashes, hideRemotes });
			if (repoInfo !== undefined) logDebug('cache', `仓库信息命中缓存：${repo}`);
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
			/*
			 * 非仓库路径直接回空窗口：对工作区根取提交图必然失败，且每次要起 git log、
			 * for-each-ref 与 config 三条子进程。
			 */
			if (!(await isRepoPath(repo))) {
				logDebug('repo', `目标路径不是 git 仓库，按空提交图返回：${repo}`);
				respond({
					command: 'loadCommits',
					refreshId: num('refreshId'),
					error: null,
					onlyFollowFirstParent: bool('onlyFollowFirstParent'),
					commits: [],
					head: null,
					branch: null,
					tags: [],
					moreCommitsAvailable: false,
					nextSkip: 0,
					nextCursor: null,
					foreignBranches: [],
					repoInfo: null,
				});
				break;
			}
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
				 * 客户端首次取数后即持有远程列表并随每次刷新传入。空列表与「未提供」不同：仓库确实没有
				 * 远程时客户端传的是空列表，此时不能回退去读远程名，否则无远程的仓库每次刷新都多起一个
				 * 子进程。
				 */
				const remotesGiven = Array.isArray(msg.remotes);
				const givenRemotes = arr<unknown>('remotes')
					.map((remote) => (typeof remote === 'string' ? remote : (remote as { name?: unknown } | null)?.name))
					.filter((name): name is string => typeof name === 'string' && name !== '');
				/*
				 * 缓存键含全部会改变 `getCommits` 结果的参数：除排序、分页与引用筛选外，贮藏标识与
				 * 远程名也参与组装提交行，参数不同必须落到不同的窗口。HEAD 同样参与：提交集的
				 * 起点含 HEAD，外部进程的提交不产生写事件，只有键随 HEAD 变化才能自然失配。
				 *
				 * HEAD 由 `HEAD` 文件与分支引用解析，不起子进程；同一次读取还给出当前分支名，随响应
				 * 回投供客户端在未取仓库信息时填补 `head`。
				 */
				const head = await repoHead(repo);
				const graphParams = {
					head: head?.hash ?? null,
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
					logDebug('cache', `提交图窗口命中缓存：${repo}${graphParamsLog(graphParams)}`);
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
						branch: cachedGraph.branch,
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
				 * 该批含仓库信息（内含引用与分支列表）、贮藏枚举与工作树分支，三者互不依赖，同批并行。
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
				 * 仓库信息批：仓库信息（含引用与分支列表，一次 `for-each-ref` 同时得到两者）、贮藏与
				 * 别的工作树占用分支，三者互不依赖，同批并行。
				 *
				 * 提交图的引用标记不再来自这里：它取自同一次 `git log` 的装饰。
				 */
				const batchSource = withRepoInfo
					? Promise.all([
						getRepoInfo(repo, showRemoteBranches, showStashes, hideRemotes),
						stashesSource,
						branchesOfOtherWorktrees(repo),
					]).then(([info, stashes, foreign]) => ({ info, stashes, foreign }), () => null)
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
					: remotesGiven ? givenRemotes : getRemoteNames(repo).catch(() => [] as string[]);
				// getCommits 内部已按「多取一条作哨兵」判断是否还有更多。
				logDebug('cache', `提交图窗口未命中缓存，重新取数：${repo}${graphParamsLog(graphParams)}`);
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
					head?.hash ?? null,
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
						commits: all, head: data.head, branch: head?.branch ?? null, tags: data.tags,
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
					// 当前分支名：与缓存键里的 HEAD 哈希是两个值，未取仓库信息时由客户端用它填补 `head`。
					branch: head?.branch ?? null,
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
		case 'loadRefs':
			// 引用筛选弹窗与手选校验用：只在需要时读，刷新路径不调用。
			await respondResult('loadRefs', async () => ({ repo, refs: await getRefSummaries(repo, bool('showRemoteBranches', true)) }));
			break;
		case 'loadBranchBase':
			// 当前分支的分叉来源：自动筛选把它并入取数起点。
			await respondResult('loadBranchBase', async () => ({ repo, ...(await getBranchBase(repo)) }));
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
		default:
			return false;
	}
	return true;
}