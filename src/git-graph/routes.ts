/**
 * dsh-dev-git-graph git-graph 宿主路由：
 * - 静态服务 media/ 下打包好的 git-graph 前端（iframe 加载）。
 * - 以 POST /dsh-dev-git-graph/gg/api 暴露原扩展 gitGraphView.respondToMessage 的命令集，
 *   数据层复用 vendor/git-graph/dataSource.ts（源码级移植，见 vendor/git-graph/LICENSE）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type http from 'node:http';
import { DataSource } from '../../vendor/git-graph/dataSource.js';
import { findGitExecutable } from '../../vendor/git-graph/gg-shims/utilsShim.js';
import {
	createDefaultRepos,
	createDefaultViewConfig,
	DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE,
	DEFAULT_GIT_GRAPH_VIEW_WORKSPACE_STATE,
} from './defaultConfig.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
// lib/src/git-graph/routes.js -> 包根
const pkgRoot = join(moduleDir, '..', '..', '..');
const mediaDir = join(pkgRoot, 'media');

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
};

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

function buildIndexHtml(repo: string): string {
	const template = readFileSync(join(mediaDir, 'index.html'), 'utf8');
	const boot = {
		apiBase: '/dsh-dev-git-graph/gg',
		repo,
		initialState: {
			config: createDefaultViewConfig(),
			lastActiveRepo: repo,
			loadViewTo: null,
			repos: createDefaultRepos(repo),
			loadRepoInfoRefreshId: 0,
			loadCommitsRefreshId: 0,
		},
		globalState: DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE,
		workspaceState: DEFAULT_GIT_GRAPH_VIEW_WORKSPACE_STATE,
	};
	const bootScript = `<script>window.__DSH_GG_BOOT__=${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>`;
	return template.replace('</head>', bootScript + '\n</head>');
}

// 静态资源进程内缓存 + gzip 预压缩：media 在启动后不变，重复打开面板无需重读盘/重压缩。
// index.html 含 per-repo boot，不进缓存。
const staticCache = new Map<string, { raw: Buffer; gz: Buffer; mime: string }>();

function getStatic(name: string): { raw: Buffer; gz: Buffer; mime: string } | null {
	const safe = name.replace(/[^a-zA-Z0-9._-]/g, '');
	const hit = staticCache.get(safe);
	if (hit) return hit;
	const file = join(mediaDir, safe);
	if (!existsSync(file)) return null;
	const raw = readFileSync(file);
	const ext = safe.slice(safe.lastIndexOf('.'));
	const entry = { raw, gz: gzipSync(raw), mime: MIME[ext] ?? 'application/octet-stream' };
	staticCache.set(safe, entry);
	return entry;
}

function sendMaybeGzip(req: http.IncomingMessage, res: http.ServerResponse, entry: { raw: Buffer; gz: Buffer; mime: string }, cacheControl: string): void {
	const accept = String(req.headers['accept-encoding'] ?? '');
	const headers: Record<string, string> = { 'content-type': entry.mime, 'cache-control': cacheControl };
	if (accept.includes('gzip')) {
		headers['content-encoding'] = 'gzip';
		res.writeHead(200, headers);
		res.end(entry.gz);
	} else {
		res.writeHead(200, headers);
		res.end(entry.raw);
	}
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, name: string, repo: string | null): boolean {
	const safe = name.replace(/[^a-zA-Z0-9._-]/g, '');
	if (safe === 'index.html') {
		// per-repo boot 注入，实时构建但 no-store
		const file = join(mediaDir, 'index.html');
		if (!existsSync(file)) return false;
		res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
		res.end(buildIndexHtml(repo ?? ''));
		return true;
	}
	const entry = getStatic(safe);
	if (!entry) return false;
	// JS/CSS 内容指纹稳定（启动后不变），允许长缓存避免重复传输
	sendMaybeGzip(req, res, entry, 'public, max-age=3600');
	return true;
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
	if (!repo && msg.command !== 'loadRepos') {
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

	switch (msg.command as string) {
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
		case 'loadRepos':
			respond({ command: 'loadRepos', repos: createDefaultRepos(repo), lastActiveRepo: repo || null, loadViewTo: null });
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
		case 'deleteUserDetails':
		case 'editUserDetails':
			respond({ command: msg.command, errors: ['DSH 版本暂不支持修改 git 用户配置'] });
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

export function registerGgRoutes(webServer: GgRouteContext): Array<() => void> {
	const disposers: Array<() => void> = [];

	// 前端入口/静态资源（真实 webServer 前缀规则：path 不带尾斜杠，/dsh-dev-git-graph/gg 同时匹配自身与 /dsh-dev-git-graph/gg/...）
	disposers.push(
		webServer.register({
			kind: 'prefix',
			path: '/dsh-dev-git-graph/gg',
			handler: (req, res) => {
				const url = new URL(req.url ?? '/', 'http://x');
				const repo = url.searchParams.get('repo');
				const sub = url.pathname.slice('/dsh-dev-git-graph/gg'.length).replace(/^\//, '');
				if (sub === '' || sub === 'index.html') {
					if (!serveStatic(req, res, 'index.html', repo)) {
						sendJson(res, 404, { error: 'git-graph 前端未构建（缺少 media/index.html）' });
					}
					return;
				}
				if (!serveStatic(req, res, sub, repo)) {
					sendJson(res, 404, { error: 'not found: ' + sub });
				}
			},
		}),
	);

	// 消息 API（POST）
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
