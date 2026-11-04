/**
 * 插件状态持久化命令：设置、布局、引用筛选、工作区、仓库位置缓存与草稿。
 */
import {
	clearDraft, coerceRefFilters, mergeLegacyEntries, readDraft, readRepoLocations, readSnapshot,
	writeLayout, writeRefFilters, writeRepoLocations, writeWorkspace, writeSettings,
} from '../state-store.js';
import type { ApiContext } from './context.js';

/**
 * 处理状态持久化的一条命令。
 *
 * @param ctx - 命令上下文。
 * @returns 是否已处理；未识别的命令返回 false。
 */
export async function handleStateCommand(ctx: ApiContext): Promise<boolean> {
	const { msg, repo, str, arr, respondResult } = ctx;
	switch (ctx.command) {
		case 'readState':
			await respondResult('readState', () => readSnapshot());
			break;
		case 'writeSettings':
			await respondResult('writeSettings', () => {
				writeSettings(msg.settings !== null && typeof msg.settings === 'object' ? msg.settings as Record<string, unknown> : null);
				return { repo };
			});
			break;
		case 'writeLayout':
			await respondResult('writeLayout', () => {
				writeLayout(coerceLayout(msg.layout));
				return { repo };
			});
			break;
		case 'writeRefFilters':
			await respondResult('writeRefFilters', () => {
				writeRefFilters(coerceRefFilters(msg.refFilters));
				return { repo };
			});
			break;
		case 'writeWorkspace':
			await respondResult('writeWorkspace', () => {
				const cwd = str('cwd');
				const partial: { selectedRepo?: string | null; expandedRepos?: string[] } = {};
				if (msg.selectedRepo !== undefined) partial.selectedRepo = typeof msg.selectedRepo === 'string' ? msg.selectedRepo : null;
				if (Array.isArray(msg.expandedRepos)) partial.expandedRepos = msg.expandedRepos.filter((x): x is string => typeof x === 'string');
				writeWorkspace(cwd, partial);
				return { repo };
			});
			break;
		case 'mergeLegacyEntries':
			await respondResult('mergeLegacyEntries', () => {
				mergeLegacyEntries(msg.entries !== null && typeof msg.entries === 'object' ? msg.entries as Record<string, unknown> : {});
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
		case 'readDraft':
			await respondResult('readDraft', () => ({ draft: readDraft(str('repoPath')) }));
			break;
		case 'clearDraft':
			await respondResult('clearDraft', () => { clearDraft(str('repoPath')); return { repo }; });
			break;
		default:
			return false;
	}
	return true;
}

/**
 * 把请求里的布局对象收敛成可存形态。
 *
 * @param value - 请求体 layout 字段。
 * @returns 布局或 null。
 */
function coerceLayout(value: unknown): { repoOpen: boolean; graphOpen: boolean; graphHeight: number; repoHeight: number } | null {
	if (value === null || typeof value !== 'object') return null;
	const v = value as Record<string, unknown>;
	return {
		repoOpen: typeof v.repoOpen === 'boolean' ? v.repoOpen : true,
		graphOpen: typeof v.graphOpen === 'boolean' ? v.graphOpen : true,
		graphHeight: typeof v.graphHeight === 'number' ? v.graphHeight : 320,
		repoHeight: typeof v.repoHeight === 'number' ? v.repoHeight : 200,
	};
}

