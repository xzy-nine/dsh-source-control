# Agent Note: 右键菜单双轨兼容与退出条件

Status: implemented

## Problem

右键菜单原由插件自建：`context-menu.ts` 用 `createRoot` 挂一个浮层，把菜单项交给 ui-primitives 的 `Menu`，并按指针坐标喂锚点矩形；二级菜单的展开方向由一条挂在 `body` 上的属性加 CSS 补丁翻转。

宿主自 0.2.2-alpha.3 起提供 `ctx.contextMenus`：菜单弹窗由宿主渲染，插件只登记 target 与动作贡献。升级到该批次后，自建浮层成了平行实现——两套弹层外观、两套键盘导航、两套视口夹取，需要各自维护。

插件仍需支持 0.2.1-rc.5 与 0.2.2-alpha.2 等不提供该服务的宿主，因此不能在升级时直接删掉自建路径。

## Decision

`context-menu.ts` 在运行时二选一：插件入口用 `ctx.inject(['contextMenus'], ...)` 探测宿主，服务就位时把引用交给 `useSharedContextMenu`，此后 `showContextMenu` 走宿主共享菜单；服务缺席时该回调根本不启动，`sharedMenus` 保持 `null`，走自建浮层。

对菜单包只有 `import type`。实体导入会让不装该包的宿主在加载插件时失败，而插件包本身不依赖它；`scripts/build-client.mjs` 的产物里因此不含该包的任何运行时引用，`test/client-bundle.test.mjs` 有一条断言挡住回退。

两套承载对菜单项的处理差异只有两处：自建浮层的项带悬浮提示，`MenuActionView` 没有对应字段，共享菜单下提示丢弃；自建浮层的二级菜单按指针位置翻转方向，共享菜单由宿主的锚点定位自行避让。菜单项与顺序在两套承载下一致，因此 `ContextMenuItem` 仍是调用方唯一的书写面，六处调用点不需改动。

`ContextMenuTargetMap` 由本插件在本模块内合并出 `'source-control'` 家族，携带打开编号。每次打开注册一次性贡献，菜单关闭（选中、点击外部、Escape）时按 `menus.active` 变空注销，插件不跨打开保存菜单状态。

退出双轨的触发点是**本插件自己的主版本**：插件版本由 GitHub 上的 semantic-release 按 conventional commits 推导，`!` 即主版本加一。`scripts/check-dual-track-baseline.mjs` 记录退出前的 `pluginMajor`，一旦当前主版本越过它，下面两项都必须已完成，各自独立判红：删除自建浮层，以及把 `engines.dsh` 下限抬到共享菜单服务首发的 `0.2.2-alpha.3` 之上。

判据用插件版本而不是 dsh 引擎下限，因为引擎下限是本插件声明的兼容面，会随宿主发版被动跟进；发布节奏由 `!` 决定，那才是「这次大版本不再背旧兼容」的语义。

## Alternatives considered

**直接升级到 0.2.2-rc.1 并要求宿主 ≥ 0.2.2-alpha.3。** 否决：升级目标是稍后进行的，眼下 0.2.1-rc.5 仍是多数用户的宿主，插件会从他们那里整个消失。

**保留自建浮层，等宿主转正式版再说。** 否决：那正是这次要退出过渡态的原因；而且届时改动面会与 `Menu` 锚点 API 的迁移叠在一起，难以定位回归。

**只写文档提醒「大版本时删掉旧轨」。** 否决：只靠人记的规则会被忘掉（见[工作约定](../../../../Docs/实现/工作约定.md)）。门禁把条件写成可执行的成对检查，两个方向都会变红。

**用 `ctx.get('contextMenus')` 探测。** 否决：Cordis 按 `inject` 列表校验属性访问，未声明的服务取值会抛错；`ctx.inject` 是「服务就位才启动」的语义，与服务缺席是正常状态这一前提吻合。

## Consequences

代价是过渡期内两套菜单实现并存，且共享菜单下丢失悬浮提示。收益是不装该包的宿主照常工作，装了该包的宿主拿到与全站一致的菜单行为。

`hint` 字段从「必须保留的特性」降为「仅自建浮层可见」：`commit-menu.ts` 的挑拣、还原与三档重置，以及 `use-remote-sync.ts` 的两条强推/重置提示，在共享菜单下不再出现。字段本身保留，因为自建路径仍在。

门禁捕获过两次真实缺陷，都留在脚本里作为防回归：引擎下限只看 `>=` 起点（区间同时写上界时，取第一个版本号会把上界当下限），以及旧轨判定按标识符词边界而非子串（否则改名残留会被当成「已删除」）。

本决策部分取代[宿主能力面不采纳记录](../../rejected/architecture/2026-11-04-host-capability-non-adoption.md)中的右键菜单一项：那一项继续保留，因为它记录了「该服务何时才随宿主发布」这一仍需的判定依据。

## Testing

- `test/client-bundle.test.mjs`：产物不含 `dsh-client-ui-context-menu` 的运行时引用；`apply` 会探测 `contextMenus`。
- `scripts/check-dual-track-baseline.mjs`：人工验证过五个状态——1.x 且双轨仍在（通过）、2.x 且两项都没做（双红）、2.x 只删旧轨（红：下限项）、2.x 只抬下限（红：双轨项）、2.x 两项都完成（通过）。
