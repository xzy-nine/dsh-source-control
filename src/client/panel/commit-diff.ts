/**
 * 提交列表与工作区条目的逐字段比对。
 *
 * 刷新时用它对上一次的数据与本次取回的数据做比对：未变化时调用方可以保持原数组引用，
 * 使下游按引用记忆化的泳道布局与变更树计算不重算。纯函数、无 React 依赖，可直接单测。
 *
 * 比对字段与参考实现 vscode-git-graph 的 `loadCommits` 一致：只比对影响图形的字段，
 * 不比对提交信息、作者与时间这类展示字段，也不比对对象引用。
 */
import type { Commit, CommitRemote, CommitStash, CommitTag, Remote, WorkingTreeEntry } from '../shared/types.ts';

/**
 * 两个可选字符串数组是否严格相等。
 *
 * 顺序敏感：`heads` 与 `parents` 的顺序会影响图形绘制。
 *
 * @param left - 左侧数组；undefined 按空数组处理。
 * @param right - 右侧数组；undefined 按空数组处理。
 * @returns 长度相同且逐项全等时为 true。
 */
function stringsEqual(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	const a = left ?? [];
	const b = right ?? [];
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index += 1) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

/**
 * 取标签的附注标记。
 *
 * 客户端 `CommitTag` 只声明了 `name`，宿主响应里另有 `annotated`；按可选字段读取。
 *
 * @param tag - 标签。
 * @returns 附注标记；缺失时为 undefined。
 */
function annotatedOf(tag: CommitTag): unknown {
	return (tag as { readonly annotated?: unknown }).annotated;
}

/**
 * 两个标签列表是否相等。
 *
 * @param left - 左侧列表；undefined 按空列表处理。
 * @param right - 右侧列表；undefined 按空列表处理。
 * @returns 长度相同且逐项 `name` 与 `annotated` 全等时为 true。
 */
function tagsEqual(left: readonly CommitTag[] | undefined, right: readonly CommitTag[] | undefined): boolean {
	const a = left ?? [];
	const b = right ?? [];
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index += 1) {
		if (a[index].name !== b[index].name) return false;
		if (annotatedOf(a[index]) !== annotatedOf(b[index])) return false;
	}
	return true;
}

/**
 * 两个远程引用列表是否相等。
 *
 * @param left - 左侧列表；undefined 按空列表处理。
 * @param right - 右侧列表；undefined 按空列表处理。
 * @returns 长度相同且逐项 `name` 与 `remote` 全等时为 true。
 */
function remotesEqual(left: readonly CommitRemote[] | undefined, right: readonly CommitRemote[] | undefined): boolean {
	const a = left ?? [];
	const b = right ?? [];
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index += 1) {
		if (a[index].name !== b[index].name) return false;
		if (a[index].remote !== b[index].remote) return false;
	}
	return true;
}

/**
 * 两个贮藏标记是否相等。
 *
 * 两侧都为 null（或都缺失）视为相等；一侧有、另一侧没有视为不等；两侧都有时只比选择器。
 *
 * @param left - 左侧标记。
 * @param right - 右侧标记。
 * @returns 相等时为 true。
 */
function stashEqual(left: CommitStash | null | undefined, right: CommitStash | null | undefined): boolean {
	const a = left ?? null;
	const b = right ?? null;
	if (a === null || b === null) return a === b;
	return a.selector === b.selector;
}

/**
 * 逐字段比对两条提交。
 *
 * @param left - 左侧提交。
 * @param right - 右侧提交。
 * @returns 影响图形的字段全等时为 true。
 */
export function commitsEqual(left: Commit, right: Commit): boolean {
	if (left.hash !== right.hash) return false;
	if (!stringsEqual(left.parents, right.parents)) return false;
	if (!stringsEqual(left.heads, right.heads)) return false;
	if (!tagsEqual(left.tags, right.tags)) return false;
	if (!remotesEqual(left.remotes, right.remotes)) return false;
	return stashEqual(left.stash, right.stash);
}

/**
 * 逐条比对两个提交列表。
 *
 * @param left - 左侧列表。
 * @param right - 右侧列表。
 * @returns 长度相同且逐条相等时为 true。
 */
export function commitsListEqual(left: readonly Commit[], right: readonly Commit[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (!commitsEqual(left[index], right[index])) return false;
	}
	return true;
}

/**
 * 未提交伪提交的文案：与宿主 `git-parse.ts` 的 `assembleCommits` 同格式。
 *
 * 客户端按工作区条目数本地重算该行，因此两边必须给出同一串文本。
 */
const UNCOMMITTED_MESSAGE = /^Uncommitted Changes \((\d+)\)$/;

/** 未提交伪提交的哈希标记，与宿主 `git-parse.ts` 的 `UNCOMMITTED` 一致。 */
const UNCOMMITTED_HASH = '*';

/**
 * 按工作区条目数修正未提交伪提交行。
 *
 * 该行的文案是当时的条目数。宿主不在提交图里插入该行（为它读一次工作区会让提交图的返回时刻
 * 取决于 `git status`），因此这里按条目数补出并修正：条目数变化时改写文案，条目清空时去掉该行，
 * 条目数由零变正且该行尚不存在时补出该行。
 *
 * @param commits - 当前提交列表。
 * @param count - 当前工作区条目数。
 * @param head - 可作为该行父提交的哈希，须已在列表中（见 {@link uncommittedParentOf}）；不可用时传 null。
 * @returns 修正后的列表；无需改动时返回原引用。
 */
export function withUncommittedCount(commits: Commit[], count: number, head: string | null = null): Commit[] {
	const existing = commits.length > 0 && commits[0].hash === UNCOMMITTED_HASH ? commits[0] : undefined;
	if (count <= 0) {
		if (existing === undefined) return commits;
		return commits.slice(1);
	}
	const message = `Uncommitted Changes (${count})`;
	if (existing !== undefined) {
		const match = UNCOMMITTED_MESSAGE.exec(existing.message);
		if (match !== null && Number.parseInt(match[1], 10) === count) return commits;
		return [{ ...existing, message }, ...commits.slice(1)];
	}
	// 仓库此前干净（列表里没有该行），首次产生改动时补出它；没有 HEAD 时无法给出父提交，留给下一次取图。
	if (head === null || head === '') return commits;
	return [{
		hash: UNCOMMITTED_HASH, parents: [head], heads: [], tags: [], remotes: [], stash: null,
		message, author: '*', email: '', date: Math.round(Date.now() / 1000),
	}, ...commits];
}

/**
 * 取未提交伪提交行可以挂载的父提交哈希。
 *
 * 该行的父提交必须出现在提交列表里，否则泳道图在该处断线：提交列表与工作区快照可能读自不同的
 * 时刻，HEAD 已被别的进程移动时快照给出的哈希不在列表中，此时返回 null，由调用方按「不补出
 * 该行」处理。
 *
 * @param commits - 当前提交列表。
 * @param head - 工作区快照给出的 HEAD 哈希；缺失时为 null。
 * @returns 可用的父提交哈希；不在列表中时为 null。
 */
export function uncommittedParentOf(commits: readonly Commit[], head: string | null | undefined): string | null {
	if (typeof head !== 'string' || head === '') return null;
	return commits.some((commit) => commit.hash === head) ? head : null;
}

/**
 * 逐条比对两个远程列表。
 *
 * @param left - 左侧列表。
 * @param right - 右侧列表。
 * @returns 长度相同且逐条 `name`、`url`、`pushUrl` 全等时为 true。
 */
export function remotesListEqual(left: readonly Remote[], right: readonly Remote[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (a.name !== b.name) return false;
		if ((a.url ?? null) !== (b.url ?? null)) return false;
		if ((a.pushUrl ?? null) !== (b.pushUrl ?? null)) return false;
	}
	return true;
}

/**
 * 逐条比对两个工作区条目列表。
 *
 * 顺序敏感：快照已按路径排序，顺序变化本身说明条目集合变了。
 *
 * @param left - 左侧列表。
 * @param right - 右侧列表。
 * @returns 长度相同且逐条四字段全等时为 true。
 */
export function entriesEqual(left: readonly WorkingTreeEntry[], right: readonly WorkingTreeEntry[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (a.path !== b.path) return false;
		if ((a.origPath ?? null) !== (b.origPath ?? null)) return false;
		if (a.index !== b.index) return false;
		if (a.worktree !== b.worktree) return false;
	}
	return true;
}
