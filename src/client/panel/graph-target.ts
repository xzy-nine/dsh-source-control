/**
 * 提交图定位的纯计算：定出「当前历史」对应的提交，并给出定位推进的下一步。
 *
 * 提交图是「从最新提交开始的前缀」，目标可能落在已加载窗口之外——例如当前分支落后于上游时，
 * HEAD 之前已排着几百条别的分支的提交。定位因此分两步：先补齐目标所属的那一页，再滚动过去。
 */
import { UNCOMMITTED_HASH } from './commit-diff.ts';
import type { Commit } from '../shared/types.ts';

/** 定位推进的下一步。 */
export type JumpStep = 'scroll' | 'page' | 'wait' | 'stop';

/**
 * 取「当前历史」对应的提交哈希。
 *
 * 快照给出的 `headHash` 是权威值：分离头指针同样成立，也不受列表里别的分支尖端影响。没有它时
 * 按当前分支名在列表里找，再退回列表里最新的一条真实提交；未提交伪提交不是提交，一律跳过。
 *
 * @param commits - 已加载的提交列表。
 * @param head - 当前分支短名；分离头指针时为 null。
 * @param headHash - 快照给出的 HEAD 提交哈希。
 * @returns 目标提交哈希；没有快照值且列表里没有真实提交时为 null。
 */
export function headTargetOf(commits: readonly Commit[], head: string | null, headHash: string | null | undefined): string | null {
	if (typeof headHash === 'string' && headHash !== '') return headHash;
	const branch = head ?? '';
	const named = commits.find((commit) => commit.hash !== UNCOMMITTED_HASH && (commit.heads ?? []).includes(branch));
	if (named !== undefined) return named.hash;
	return commits.find((commit) => commit.hash !== UNCOMMITTED_HASH)?.hash ?? null;
}

/**
 * 定出一次定位的下一步。
 *
 * @param target - 目标提交哈希。
 * @param commits - 已加载的提交列表。
 * @param more - 是否还有更早的提交可取。
 * @param paged - 是否已为这一份列表发过翻页请求。
 * @returns 目标已加载为 `scroll`；还能取下一页为 `page`；等这一页回来为 `wait`；取完仍没有为 `stop`。
 */
export function jumpStepOf(target: string, commits: readonly Commit[], more: boolean, paged: boolean): JumpStep {
	if (commits.some((commit) => commit.hash === target)) return 'scroll';
	if (!more) return 'stop';
	if (paged) return 'wait';
	return 'page';
}
