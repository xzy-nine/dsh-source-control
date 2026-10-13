/**
 * 引用与提交图的纯计算：引用收集、自动分支集合、按引用过滤、领先/落后集合。
 */
import type { Commit, RefItem } from '../types.ts';

/**
 * 从提交列表收集所有引用（分支、远程、标签），去重后按类型排序。
 *
 * @param commits - 提交列表。
 * @returns 引用列表。
 */
export function collectRefs(commits: readonly Commit[]): RefItem[] {
	const seen = new Set<string>();
	const refs: RefItem[] = [];
	for (const commit of commits) {
		for (const name of commit.heads ?? []) {
			const key = `b:${name}`;
			if (!seen.has(key)) { seen.add(key); refs.push({ name, hash: commit.hash, type: 'branch', kind: '分支' }); }
		}
		for (const remote of commit.remotes ?? []) {
			const key = `r:${remote.name}`;
			if (!seen.has(key)) { seen.add(key); refs.push({ name: remote.name, hash: commit.hash, type: 'remote', kind: '远程' }); }
		}
		for (const tag of commit.tags ?? []) {
			const key = `t:${tag.name}`;
			if (!seen.has(key)) { seen.add(key); refs.push({ name: tag.name, hash: commit.hash, type: 'tag', kind: '标记' }); }
		}
	}
	return refs;
}

/**
 * 计算「自动」模式应显示的分支：当前分支及向其合并的分支（祖先提交上的分支）。
 *
 * @param commits - 提交列表。
 * @param head - 当前分支名。
 * @returns 分支名称集合。
 */
export function computeAutoRefs(commits: readonly Commit[], head: string | null): Set<string> {
	if (head === null) return new Set();
	const commitByHash = new Map<string, Commit>();
	for (const commit of commits) {
		if (commit.hash !== '*') commitByHash.set(commit.hash, commit);
	}
	let headHash: string | null = null;
	for (const commit of commits) {
		if ((commit.heads ?? []).includes(head)) { headHash = commit.hash; break; }
	}
	if (headHash === null) return new Set();
	// 祖先提交（含 HEAD 自身）
	const ancestorHashes = new Set<string>();
	const queue = [headHash];
	while (queue.length > 0) {
		const hash = queue.shift() as string;
		if (ancestorHashes.has(hash)) continue;
		ancestorHashes.add(hash);
		const commit = commitByHash.get(hash);
		if (commit !== undefined) for (const p of commit.parents ?? []) queue.push(p);
	}
	// 收集祖先提交上的分支名
	const result = new Set<string>();
	for (const hash of ancestorHashes) for (const name of commitByHash.get(hash)?.heads ?? []) result.add(name);
	return result;
}

/**
 * 取当前分支可达的提交哈希集合（含分支尖端自身）。
 *
 * 提交图可能被加载上限截断，此时窗口外的提交不在集合内。
 *
 * @param commits - 提交列表。
 * @param head - 当前分支名。
 * @returns 可达提交哈希集合；无法确定当前分支时为空集。
 */
export function currentBranchHashes(commits: readonly Commit[], head: string | null): Set<string> {
	if (head === null) return new Set();
	const commitByHash = new Map<string, Commit>();
	for (const commit of commits) {
		if (commit.hash !== '*') commitByHash.set(commit.hash, commit);
	}
	let headHash: string | null = null;
	for (const commit of commits) {
		if ((commit.heads ?? []).includes(head)) { headHash = commit.hash; break; }
	}
	if (headHash === null) return new Set();
	const reachable = new Set<string>();
	const queue = [headHash];
	while (queue.length > 0) {
		const hash = queue.shift() as string;
		if (reachable.has(hash)) continue;
		reachable.add(hash);
		const commit = commitByHash.get(hash);
		if (commit !== undefined) for (const p of commit.parents ?? []) queue.push(p);
	}
	return reachable;
}

/**
 * 按选中的引用名称过滤提交列表：仅保留选中引用可达的提交（含工作区伪提交）。
 *
 * @param commits - 全部提交。
 * @param selectedNames - 选中的引用名称集合；空集表示不过滤。
 * @returns 过滤后的提交列表。
 */
export function filterCommitsByRefs(commits: readonly Commit[], selectedNames: ReadonlySet<string>): readonly Commit[] {
	if (selectedNames.size === 0) return commits;
	const commitByHash = new Map<string, Commit>();
	for (const commit of commits) {
		if (commit.hash !== '*') commitByHash.set(commit.hash, commit);
	}
	const rootHashes = new Set<string>();
	for (const commit of commits) {
		if (commit.hash === '*') continue;
		for (const name of commit.heads ?? []) if (selectedNames.has(name)) rootHashes.add(commit.hash);
		for (const remote of commit.remotes ?? []) if (selectedNames.has(remote.name)) rootHashes.add(commit.hash);
		for (const tag of commit.tags ?? []) if (selectedNames.has(tag.name)) rootHashes.add(commit.hash);
	}
	const reachable = new Set<string>();
	const queue = [...rootHashes];
	while (queue.length > 0) {
		const hash = queue.shift() as string;
		if (reachable.has(hash)) continue;
		reachable.add(hash);
		const commit = commitByHash.get(hash);
		if (commit !== undefined) for (const p of commit.parents ?? []) queue.push(p);
	}
	return commits.filter((commit) => commit.hash === '*' || reachable.has(commit.hash));
}

/**
 * 计算用远程色标出的提交哈希集合。
 *
 * 本地领先时取云端可达的全部提交，使领先部分（未推送）保持泳道原色、已同步部分标为远程色；
 * 否则只标云端独有的提交。
 *
 * @param commits - 提交列表。
 * @param head - 本地分支名。
 * @param upstream - 远程跟踪分支名（如 origin/main）。
 * @returns 需要标为远程色的哈希集合；无上游时为空集。
 */
export function computeRemoteHashes(
	commits: readonly Commit[], head: string | null, upstream: string | null,
): Set<string> {
	if (head === null || upstream === null) return new Set();
	const commitByHash = new Map<string, Commit>();
	for (const commit of commits) {
		if (commit.hash !== '*') commitByHash.set(commit.hash, commit);
	}
	// 找本地 HEAD 和远程跟踪分支的提交哈希
	let localHash: string | null = null;
	let remoteHash: string | null = null;
	for (const commit of commits) {
		if (commit.hash === '*') continue;
		if (localHash === null && (commit.heads ?? []).includes(head)) localHash = commit.hash;
		for (const remote of commit.remotes ?? []) {
			if (remote.name === upstream) remoteHash = commit.hash;
		}
	}
	if (localHash === null || remoteHash === null) return new Set();
	// 收集各自祖先
	const ancestorsOf = (rootHash: string): Set<string> => {
		const seen = new Set<string>();
		const queue = [rootHash];
		while (queue.length > 0) {
			const hash = queue.shift() as string;
			if (seen.has(hash)) continue;
			seen.add(hash);
			const commit = commitByHash.get(hash);
			if (commit !== undefined) for (const p of commit.parents ?? []) queue.push(p);
		}
		return seen;
	};
	const localAncestors = ancestorsOf(localHash);
	const remoteAncestors = ancestorsOf(remoteHash);
	const ahead = new Set<string>();
	for (const hash of localAncestors) if (!remoteAncestors.has(hash)) ahead.add(hash);
	// 本地领先时返回云端可达的全部提交，已同步部分因此标为远程色、未推送部分保持泳道原色。
	if (ahead.size > 0) return remoteAncestors;
	// 否则只标云端独有的提交（云端领先本地）。
	const behind = new Set<string>();
	for (const hash of remoteAncestors) if (!localAncestors.has(hash)) behind.add(hash);
	return behind;
}
