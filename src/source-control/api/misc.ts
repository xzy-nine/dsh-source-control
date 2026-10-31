/**
 * 其余命令：清理未跟踪文件、归档、GitHub 集成、平台占位、差异内容、用户身份、缓存作废、
 * 反馈与客户端日志。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {
	cleanUntrackedFiles, resetFileToRevision, setConfigValue, unsetConfigValue,
} from '../git-actions.js';
import { ghAccount, ghCreatePullRequest, ghCreateRepo, ghOwners, ghRepoInfo } from '../gh-cli.js';
import { gitOrThrow } from '../git-exec.js';
import { getConfig, getRepoInfo } from '../git-query.js';
import { parseUnifiedDiffHunks } from '../diff-hunks.js';
import type { DiffHunkText } from '../diff-hunks.js';
import { invalidateRepo } from '../host-cache.js';
import { submitFeedback } from '../feedback.js';
import { formatBytes } from '../feedback-text.js';
import { currentLogFile, log, logDebug, logError, logInfo, logRoot, recentLogFiles } from '../logger.js';
import { sshStatus } from '../ssh-status.js';
import type { LogLevel } from '../logger.js';
import type { ApiContext } from './context.js';

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
/** 客户端一次上报的日志条数上限。 */
const MAX_CLIENT_LOG_ENTRIES = 200;

/**
 * 客户端给的级别归一化：只有调试、警告、错误三档与信息档，其余一律按信息处理。
 *
 * @param value - 客户端给出的级别字符。
 * @returns logcat 级别。
 */
function clientLogLevel(value: unknown): LogLevel {
	const level = typeof value === 'string' ? value.toUpperCase() : '';
	return level === 'D' || level === 'W' || level === 'E' ? level : 'I';
}

/**
 * 取某个文件差异的逐块内容。
 *
 * @param repo - 仓库路径。
 * @param commitHash - 提交哈希；`*` 表示工作区。
 * @param filePath - 文件路径（相对仓库根）。
 * @param staged - 工作区时是否比较暂存区。
 * @returns 逐块的新旧内容。
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

/**
 * 处理其余命令。
 *
 * @param ctx - 命令上下文。
 * @returns 是否已处理；未识别的命令返回 false。
 */
export async function handleMiscCommand(ctx: ApiContext): Promise<boolean> {
	const { msg, repo, str, strOrNull, bool, arr, aiDeps, respond, respondResult, respondResultSync, respondError, sendBadRequest } = ctx;
	switch (ctx.command) {
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
			if (!ref || !outputPath) { sendBadRequest('缺少 ref 或 outputPath'); break; }
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
			logError('panel', `面板报告前端错误：${str('message')}`);
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
			if (text === '') { sendBadRequest('缺少 text'); break; }
			if (targetLanguage === '') { sendBadRequest('缺少 targetLanguage'); break; }
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
		 *
		 * 只作废目标仓库及其祖先与后代：别的仓库的缓存与本次改动无关，全量清空会让它们
		 * 各自重取一次提交图与工作区。
		 */
		case 'invalidateCache':
			invalidateRepo(repo);
			respond({ command: 'invalidateCache', repo, error: null });
			break;

		/* --- 反馈与日志 --- */
		case 'feedbackInfo':
			// 日志目录与最近文件供反馈页展示：失败时用户据此手动提交。
			respondResultSync('feedbackInfo', {
				logDir: logRoot(),
				currentFile: currentLogFile(),
				// 体积文本由宿主给出：客户端不再自带一份格式化实现。
				files: recentLogFiles(5).map((file) => ({ ...file, sizeText: formatBytes(file.size) })),
			});
			break;
		case 'submitFeedback': {
			const type = str('type');
			if (type !== 'bug' && type !== 'suggestion' && type !== 'other') { sendBadRequest('未知反馈类型'); break; }
			if (str('title').trim() === '') { sendBadRequest('缺少标题'); break; }
			if (str('description').trim() === '') { sendBadRequest('缺少描述'); break; }
			const result = await submitFeedback({
				type,
				title: str('title'),
				description: str('description'),
				attachLogs: bool('attachLogs'),
				logFile: strOrNull('logFile') ?? undefined,
				disableRedaction: bool('disableRedaction'),
				exemptions: arr<string>('exemptions'),
				pluginVersion: str('pluginVersion'),
				cwd: repo,
			});
			if (result.error !== null) logError('feedback', `反馈提交失败，原因分类 ${result.kind}：${result.error}`);
			else logInfo('feedback', `反馈已提交，issue 地址：${result.url}${result.archive === null ? '（未附带日志）' : `，日志压缩包：${result.archive}`}`);
			respond({ command: 'submitFeedback', ...result });
			break;
		}
		case 'logEvent': {
			// 浏览器半边没有文件系统，日志经这条命令转写到宿主日志。
			const entries = arr<Record<string, unknown>>('entries').slice(0, MAX_CLIENT_LOG_ENTRIES);
			for (const entry of entries) {
				const tag = typeof entry.tag === 'string' && entry.tag !== '' ? entry.tag : 'panel';
				const message = typeof entry.message === 'string' ? entry.message : '';
				if (message === '') continue;
				log(clientLogLevel(entry.level), `client/${tag}`, message);
			}
			respondResultSync('logEvent', { accepted: entries.length });
			// 客户端上报是插件唯一看不到落盘结果的一环：收几条就记一条，便于确认上报通路是否通。
			if (entries.length > 0) logDebug('api', `已接收 ${String(entries.length)} 条客户端日志`);
			break;
		}
		default:
			return false;
	}
	return true;
}