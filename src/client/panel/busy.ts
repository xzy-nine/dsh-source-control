/**
 * 忙碌状态：按「仓库 + 影响面」记录进行中的操作。
 *
 * 同一条记录可并存多份（重复触发的同类操作各记一份），移除以一份为单位。
 * 无 React 依赖，可直接单测。
 */
import type { BusyEntry, BusyFlags, BusyScope } from '../shared/types.ts';

/**
 * 记录一次操作开始。
 *
 * @param entries - 现有记录。
 * @param repo - 目标仓库路径。
 * @param scope - 操作的影响面。
 * @returns 新记录。
 */
export function addBusy(entries: readonly BusyEntry[], repo: string, scope: BusyScope): readonly BusyEntry[] {
	return entries.concat([{ repo, scope }]);
}

/**
 * 记录一次操作结束。
 *
 * 只移除一份匹配记录：同仓库同影响面的操作可重复触发，各占一份。
 *
 * @param entries - 现有记录。
 * @param repo - 目标仓库路径。
 * @param scope - 操作的影响面。
 * @returns 新记录；没有匹配记录时原样返回。
 */
export function removeBusy(entries: readonly BusyEntry[], repo: string, scope: BusyScope): readonly BusyEntry[] {
	const at = entries.findIndex((entry) => entry.repo === repo && entry.scope === scope);
	return at === -1 ? entries : [...entries.slice(0, at), ...entries.slice(at + 1)];
}

/**
 * 某个仓库是否有进行中的操作。
 *
 * @param entries - 现有记录。
 * @param repo - 仓库路径；null 表示未选中仓库。
 * @param scope - 限定的影响面；省略表示任一影响面。
 * @returns 有匹配记录时为 true。
 */
export function isRepoBusy(entries: readonly BusyEntry[], repo: string | null, scope?: BusyScope): boolean {
	if (repo === null) return false;
	return entries.some((entry) => entry.repo === repo && (scope === undefined || entry.scope === scope));
}

/**
 * 会挡住后台读取的影响面。
 *
 * 联网操作（推送、抓取、拉取）不改写本地对象库与工作区，后台读取照常进行；把它们算作阻塞
 * 会让变更列表与提交图在一次推送的整段时间里停更。
 */
const BLOCKING_SCOPES: ReadonlySet<BusyScope> = new Set<BusyScope>(['read', 'commit', 'history']);

/**
 * 某个仓库是否有会挡住后台读取的操作在跑。
 *
 * 供事件驱动的刷新与兜底轮询的门控使用：联网操作期间它们应当照常刷新。
 *
 * @param entries - 现有记录。
 * @param repo - 仓库路径；null 表示未选中仓库。
 * @returns 有会阻塞读取的记录时为 true。
 */
export function isReadBlocked(entries: readonly BusyEntry[], repo: string | null): boolean {
	if (repo === null) return false;
	return entries.some((entry) => entry.repo === repo && BLOCKING_SCOPES.has(entry.scope));
}

/**
 * 某个仓库的忙碌分级。
 *
 * @param entries - 现有记录。
 * @param repo - 仓库路径；null 时四项全为 false。
 * @returns 四个影响面各自的忙碌标志。
 */
export function busyFlagsOf(entries: readonly BusyEntry[], repo: string | null): BusyFlags {
	const has = (scope: BusyScope): boolean => isRepoBusy(entries, repo, scope);
	return { read: has('read'), commit: has('commit'), history: has('history'), network: has('network') };
}

/**
 * 是否有任一影响面在忙；顶部不定进度条据此显示。
 *
 * @param flags - 忙碌分级。
 * @returns 任一为 true 时返回 true。
 */
export function anyBusy(flags: BusyFlags): boolean {
	return flags.read || flags.commit || flags.history || flags.network;
}
