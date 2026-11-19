/**
 * 未合并条目的种类：宿主侧解析、客户端分组与差异页共用同一份判定。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

/** 未合并条目在 `git status --porcelain` 两列上的七种组合。 */
export type ConflictKind =
	| 'both-modified'
	| 'both-added'
	| 'added-by-us'
	| 'added-by-them'
	| 'deleted-by-us'
	| 'deleted-by-them'
	| 'both-deleted';

/**
 * XY 两列到冲突种类的映射。
 *
 * 这七组取值是 git 判定未合并的唯一输出；其余组合都是普通的暂存或工作区改动。
 */
export const CONFLICT_KINDS: Readonly<Record<string, ConflictKind>> = {
	UU: 'both-modified',
	AA: 'both-added',
	AU: 'added-by-us',
	UA: 'added-by-them',
	DU: 'deleted-by-us',
	UD: 'deleted-by-them',
	DD: 'both-deleted',
};

/** 冲突种类的展示文案。 */
export const CONFLICT_KIND_TEXT: Readonly<Record<ConflictKind, string>> = {
	'both-modified': '冲突：双方修改',
	'both-added': '冲突：双方新增',
	'added-by-us': '冲突：我方新增',
	'added-by-them': '冲突：对方新增',
	'deleted-by-us': '冲突：我方删除',
	'deleted-by-them': '冲突：对方删除',
	'both-deleted': '冲突：双方删除',
};

/** 冲突种类在两列上的写法；状态字符列与菜单文案共用。 */
export const CONFLICT_KIND_CODE: Readonly<Record<ConflictKind, string>> = {
	'both-modified': 'UU',
	'both-added': 'AA',
	'added-by-us': 'AU',
	'added-by-them': 'UA',
	'deleted-by-us': 'DU',
	'deleted-by-them': 'UD',
	'both-deleted': 'DD',
};

/**
 * 由冲突种类还原出一条可以用来判定动作可用性的条目。
 *
 * 差异页只拿到种类与阶段（没有 `status` 条目），而动作可用性按条目判定，因此这里把
 * 种类反推回两列码。两列码本身就是种类的唯一写法，反推是精确的。
 *
 * @param path - 文件路径，相对仓库根。
 * @param kind - 冲突种类。
 * @returns 只带路径与两列码的条目。
 */
export function conflictEntryOf(path: string, kind: ConflictKind): { readonly path: string; readonly index: string; readonly worktree: string; readonly unmerged: true } {
	const code = CONFLICT_KIND_CODE[kind];
	return { path, index: code.slice(0, 1), worktree: code.slice(1, 2), unmerged: true };
}

/**
 * 取两列码对应的冲突种类。
 *
 * @param index - 索引列状态码。
 * @param worktree - 工作区列状态码。
 * @returns 冲突种类；不是未合并组合时为 null。
 */
export function conflictKindOfPair(index: string, worktree: string): ConflictKind | null {
	return CONFLICT_KINDS[`${index}${worktree}`] ?? null;
}

/** 工作区里仍带有未解决的冲突标记：起首标记行、分隔行或结束标记行。 */
const CONFLICT_MARKER = /^(?:<{7}\s|={7}$|>{7}\s)/m;

/**
 * 判断文件文本里是否还有冲突标记。
 *
 * 判据与 git 写入的三行一致：`<<<<<<< <标签>`、整行七等号、`>>>>>>> <标签>`。
 *
 * @param text - 文件全文。
 * @returns 含未解决标记时为 true。
 */
export function hasConflictMarkers(text: string): boolean {
	return CONFLICT_MARKER.test(text);
}
