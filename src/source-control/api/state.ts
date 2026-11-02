/**
 * 插件状态持久化命令：设置、布局、引用筛选与仓库位置缓存。
 */
import { readEntries, readRepoLocations, writeEntry, writeRepoLocations } from '../state-store.js';
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
		default:
			return false;
	}
	return true;
}