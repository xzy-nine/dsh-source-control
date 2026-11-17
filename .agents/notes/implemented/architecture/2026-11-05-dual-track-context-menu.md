# Agent Note: 右键菜单双轨兼容与退出

Status: implemented

## Problem

右键菜单原由插件自建：`context-menu.ts` 用 `createRoot` 挂一个浮层，把菜单项交给 ui-primitives 的 `Menu`，并按指针坐标喂锚点矩形；二级菜单的展开方向由一条挂在 `body` 上的属性加 CSS 补丁翻转。

宿主后来提供 `ctx.contextMenus`：菜单弹窗由宿主渲染，插件只登记 target 与动作贡献。升级到该批次后，自建浮层成了平行实现——两套弹层外观、两套键盘导航、两套视口夹取，需要各自维护。

插件曾需支持不提供该服务的宿主，因此不能在升级时直接删掉自建路径。这份兼容已随主版本提升退出：自建浮层删除，`engines.dsh` 下限抬到 `0.2.2-alpha.2`。

## Decision

插件入口用 `ctx.inject(['contextMenus'], ...)` 把服务引用交给 `useSharedContextMenu`，`showContextMenu` 走宿主共享菜单。该服务是菜单弹窗唯一的承载，引擎下限已保证宿主提供它，服务缺席时不弹出菜单。

对菜单包只有 `import type`：实体导入会让不装该包的宿主在加载插件时失败，而插件包本身不依赖它。`scripts/build-client.mjs` 的产物因此不含该包的任何运行时引用，`test/client-bundle.test.mjs` 有断言挡住回退。

`ContextMenuTargetMap` 由本插件在 `context-menu-host.ts` 内合并出 `'source-control'` 家族，携带打开编号。每次打开注册一次性贡献，注销判据是 `menus.active` 不再指向这一份（变空，或被别的目标替换），插件不跨打开保存菜单状态。宿主打开菜单的顺序是先收掉上一份、把活动目标置空，再置入新目标：这一拍的空值不是关闭，据它注销会让新贡献在弹窗出现前消失，而这次空开把活动目标留在非空态，下一次右键重演同一过程，菜单从此打不开。空值因此只作待复核信号，微任务里再看活动目标。

打开路径按「先弹出、后补齐」拆分：需要向 git 追问的包含关系由 `pendingItems` 单独返回，菜单当帧弹出后经 `observe` 的快照源触发重新解析——几个子进程的往返不再挡在弹出之前。

## 版本分界点

双轨不是一条界限，而是三条独立的分界，每项能力的引入版本不同。下表取自 deepseek-harness 的 upgrade-guide，不是推测。

| 能力 | 旧宿主 | 新宿主起始版本 | 移除前的插件侧处理 | 已应用的移除 |
|---|---|---|---|---|
| `ctx.contextMenus` 服务（共享菜单承载） | 无 | `0.2.1-rc.2` | `ctx.inject(['contextMenus'], ...)` 是否启动 | 删自建浮层分支与 `createRoot` 路径 |
| `Menu` 的 `anchorPoint` / `anchorRef` | 只有 `getAnchorRect` | `0.2.2-alpha.2` | 双传属性共存 | 删 `getAnchorRect` 与 4px 补偿，只留 CSS 锚点一代 |
| 子菜单左翻回退 | 无，固定向右且不夹取 | 与 `anchorPoint` 同批 | `usePointerGrace` 是否导出 | 删翻转属性与 CSS 补丁，删 `SUBMENU_FLIP_ATTR` |

退出后 `scripts/check-dual-track-baseline.mjs` 转为**真值门禁**：`engines.dsh` 下限不得低于 `0.2.2-alpha.2`（共享菜单与 CSS 锚点一代都就位的版本），自建浮层的独有标识符不得重现。基线 `dual-track-baseline.json` 记录 `legacyMenu: false`，旧轨重现即报红。

## Alternatives considered

**直接升级到 0.2.2-rc.1 并要求宿主 ≥ 0.2.2-alpha.3。** 否决：升级目标是稍后进行的，眼下 0.2.1-rc.5 仍是多数用户的宿主，插件会从他们那里整个消失。

**保留自建浮层，等宿主转正式版再说。** 否决：那正是这次要退出过渡态的原因；而且届时改动面会与 `Menu` 锚点 API 的迁移叠在一起，难以定位回归。

**只写文档提醒「大版本时删掉旧轨」。** 否决：只靠人记的规则会被忘掉（见[工作约定](../../../../Docs/实现/工作约定.md)）。门禁把条件写成可执行的检查，旧轨重现会报红。

**用 `ctx.get('contextMenus')` 探测。** 否决：Cordis 按 `inject` 列表校验属性访问，未声明的服务取值会抛错；`ctx.inject` 是「服务就位才启动」的语义，与服务缺席是正常状态这一前提吻合。

**改成常驻一份贡献，打开前只替换动作表。** 否决：当前动作表与补齐信号就得提到模块级、跨打开保留，插件侧多出一份必须与关闭时机对齐的可变状态；一次性贡献只多一次登记与一次注销，把注销判据收紧到「活动目标不再指向这一份」即可。判据也不能取「活动目标变空」：宿主打开菜单时先置空再置入新目标，这一拍的空值属于新的一份。

## Consequences

过渡期内两套菜单实现并存、共享菜单下丢失悬浮提示；退出后只剩共享菜单一条承载。两套承载间唯一的呈现差异是悬浮提示：`ContextMenuItem.hint` 与勾选（`checked`）随自建浮层一并删除，挑拣、还原、三档重置与强推/重置菜单不再带提示文案；菜单项与顺序在单轨下不变，调用方仍以 `ContextMenuItem` 为唯一书写面。

门禁捕获过真实缺陷，留在脚本里作为防回归：引擎下限只看 `>=` 起点（区间同时写上界时，取第一个版本号会把上界当下限），以及旧轨判定按标识符词边界而非子串（否则改名残留会被当成「已删除」）。

本决策部分取代[宿主能力面不采纳记录](../../rejected/architecture/2026-11-04-host-capability-non-adoption.md)中的右键菜单一项：那一项继续保留，因为它记录了「该服务何时才随宿主发布」这一判定依据。

## Testing

- `test/client-bundle.test.mjs`：产物不含 `dsh-client-ui-context-menu` 的运行时引用；`apply` 会探测 `contextMenus`；旧代锚点属性与翻转补丁不再出现。
- `test/primitives.test.mjs`：提交菜单是同步函数，弹出前不得 `await`，包含关系经 `pendingItems` 补齐。
- `test/context-menu-host.test.mjs`：按宿主「先置空、再置入新目标」的打开顺序，断言紧接上一份菜单再右键仍带条目；选中动作先于收尾执行；关闭后贡献注销、条目清空。
- `scripts/check-dual-track-baseline.mjs`：负向验证过一次——把引擎下限改低即报红；基线记录 `legacyMenu: false` 后旧轨重现即报红。
