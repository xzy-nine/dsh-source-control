/**
 * 上游引用形态的归一与拆分。
 *
 * 上游的完整引用由 git 给出（`%(upstream)` 与 `branch.upstream`），本模块是拆分它的唯一一处：
 * 有了完整引用就不必从短名猜种类，也不会把本地分支当成远程跟踪引用。
 */

/** 上游所属远程与源分支。 */
export interface UpstreamParts {
	/** 远程名；上游是本地分支时为 null。 */
	readonly remote: string | null;
	/** 该远程上的分支名，或本地分支名。 */
	readonly branch: string;
}

/**
 * 把上游的完整引用拆成远程名与分支名。
 *
 * 引用前缀本身说明种类：`refs/remotes/<远程>/<分支>` 是远程跟踪引用，
 * `refs/heads/<分支>` 是本地分支（`branch.<名字>.remote` 为 `.`），后者没有远程可抓。
 *
 * @param upstreamRef - 上游完整引用。
 * @returns 拆分结果；不是可识别的上游引用时为 null。
 */
export function upstreamPartsFromRef(upstreamRef: string | null | undefined): UpstreamParts | null {
	if (typeof upstreamRef !== 'string' || upstreamRef === '') return null;
	const heads = 'refs/heads/';
	if (upstreamRef.startsWith(heads)) {
		const branch = upstreamRef.slice(heads.length);
		return branch === '' ? null : { remote: null, branch };
	}
	const remotes = 'refs/remotes/';
	if (!upstreamRef.startsWith(remotes)) return null;
	const rest = upstreamRef.slice(remotes.length);
	const at = rest.indexOf('/');
	if (at <= 0 || at === rest.length - 1) return null;
	return { remote: rest.slice(0, at), branch: rest.slice(at + 1) };
}

/**
 * 上游短名所属的远程名。
 *
 * 只在没有完整引用时作为回退：短名形如 `<远程>/<分支>`，首个斜杠前的部分即远程名。
 *
 * @param upstream - 上游短名。
 * @returns 远程名与分支名；无法判定时为 null。
 */
export function upstreamPartsFromShortName(upstream: string | null | undefined): UpstreamParts | null {
	if (typeof upstream !== 'string' || upstream === '') return null;
	const at = upstream.indexOf('/');
	if (at <= 0 || at === upstream.length - 1) return null;
	return { remote: upstream.slice(0, at), branch: upstream.slice(at + 1) };
}
