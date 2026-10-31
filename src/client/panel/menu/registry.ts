/**
 * 右键菜单操作注册表：把各域的处理函数按 datablock 里的 id 合成一张表。
 *
 * 新增一项操作 = 在 `menu-actions.json` 里加一条 + 在对应域模块里补一个同 id 的处理函数；
 * 缺一个会在本文件的类型检查处报错。
 */
import type { ContextMenuItem } from '../../ui/context-menu.ts';
import type { MenuActionMeta } from '../menu-actions.ts';
import type { MenuContext } from './shared.ts';
import * as branch from './branch.ts';
import * as remoteBranch from './remote-branch.ts';
import * as tag from './tag.ts';
import * as stash from './stash.ts';
import * as commit from './commit.ts';

/** 各操作的处理函数；键为 menu-actions.json 里给出的 id。 */
export const BUILDERS: Readonly<Record<string, (ctx: MenuContext, meta: MenuActionMeta) => ContextMenuItem | null>> = {
	...branch.BUILDERS,
	...remoteBranch.BUILDERS,
	...tag.BUILDERS,
	...stash.BUILDERS,
	...commit.BUILDERS,
};
