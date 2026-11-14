# Agent Note: 冲突条目在差异页显示并可就地解决

Status: implemented

## Problem

冲突（未合并）条目在面板里既没有可读的差异，也没有解决入口，用户必须切到终端。实测本机 git 与现有代码，原因是三处叠加：

- 工作区作用域用 `git diff -- <path>`，未合并路径输出 `diff --cc` 与 `@@@ … @@@` 三路 hunk 头，`parseUnifiedDiffHunks` 只认两路 `@@`，解析结果是 0 个 hunk；
- 新旧正文用 `git show :<path>`，未合并路径没有 stage 0，命令以 `path is in the index, but not at stage 0` 失败，两侧都变成 null，文件状态因此被误判成新增；
- `changeOf` 把「索引列非空」判为已暂存，而冲突条目的两列是 `U`/`A`/`D` 的组合，于是 `UU` 同时落进「暂存的更改」与「更改」两组。

另有一条隐含缺陷：丢弃对冲突必然失败，`git restore -- <未合并路径>` 一律回 `path '<p>' is unmerged`。

## Decision

**分组按白名单判定。** 索引列只认 `M`/`A`/`D`/`R`/`C`，工作区列只认 `M`/`D`/`R`/`A`/`T`（与 VS Code git 扩展 `repository.ts` 的 status 分派同一口径）。未合并码不属于任一侧，因此冲突不会重复出现，不必逐条排除。第三组「合并冲突」常驻在前，没有冲突时不渲染。

**冲突种类两端只有一份定义。** `src/shared/conflict-kind.ts` 给出七种 XY 组合、种类名、展示文案与「是否仍有冲突标记」的判据；宿主据此给 `WorkingTreeEntry` 补 `unmerged`，客户端分组、动作可用性与差异页读同一份。宿主与客户端分别打包，因此该模块放进两端都有的 `src/shared/`。

**差异改按阶段取源。** `fileDiffContent` 先查 `ls-files -u`；命中冲突时按种类决定两侧：双方都留下内容（`UU`/`AA`）比 `HEAD` 与工作区，`DU` 比 `:1:` 与 `:3:`，`UD` 比 `:1:` 与 `:2:`。取源与 VS Code 的 `getLeftResource`/`getRightResource` 一致，但比较方式换成 `git diff <左> <右> -- <路径>`：两侧都是 blob 时不经工作区也成立。回投 `conflict`、`conflictKind` 与 `conflictStages`，前端据此渲染冲突操作条并给三种标记行着色。

**解决动作分两种粒度。** 行内与右键给「采用我方」「采用对方」「删除文件」「标记为已解决」，另在菜单里给「重新生成冲突标记」。采用一侧落 `git checkout-index -f -u --stage=2|3` 再 `add`：`git checkout --ours` 在该侧缺失时整条命令失败且报错随种类变化，而 `checkout-index` 的失败判据固定。该侧缺失（我方删除取我方）时不做无意义复制，改为把对方内容或删除落进索引。`markResolved` 先 `add -A`，失败再 `rm -f` 兜住「文件已不在工作区」的情形。`checkout-index` 补进 `INDEX_ONLY_WRITES`，否则会被当作历史写操作白作废提交图窗口。

**冲突未解决时禁止提交。** 与 VS Code 的 action button 同一判据：存在未解决冲突时提交按钮禁用。git 本会以 `not possible because you have unmerged files` 拒绝，提前禁用并把原因写进提示行比让它失败更清楚。

## Alternatives considered

**解析 `git diff --cc` 的三路输出。** 否决：`@@@` 头与双列前缀要另写一套解析与行号映射，还要改 forge 的渲染契约；`git diff HEAD` 已经给出普通两路 hunk，冲突标记作为新增行天然可见。

**只排除 `U` 码，不加第三分组。** 否决：冲突条目仍需一组解决动作，混在「更改」组里会让暂存与丢弃按钮出现在对它们无效的行上。

**用 `git checkout --ours/--theirs` 承担采用一侧。** 否决：该侧缺失时整条命令失败，且「我方删除」这类冲突下用户要的其实是「保留对方」，一条命令表达不了。

**在差异页做三方并排视图。** 否决：VS Code 的三方视图来自独立的 merge editor，本插件没有编辑器承载；单文件 forge 视图加阶段取源已能读出结果，取舍写在下面的代价里。

**给冲突条目保留一个「取基线」按钮。** 否决：`:1:` 只是共同祖先，很少是用户想要的最终内容；宿主侧的取源已按种类使用它，不需要单独暴露成动作。

## Consequences

**收益**：冲突条目有了独立分组、可读差异与就地解决入口；`UU` 不再重复出现；丢弃按钮不再出现在对它必然失败的行上；提交按钮的禁用理由与 git 的拒绝理由一致。

**代价**：

- `fileDiffContent` 多一次 `ls-files -u` 与一次 `status` 探测；两者都只读，且仅在打开差异页时发生。
- 差异页只有「基线或 HEAD → 对侧或工作区」两栏，看不到两侧同时对照的三方视图。
- 「采用我方」把该阶段内容写进索引即视为已解决；用户在差异页上看到的仍是解决前的快照，需要重取本页才能看到结果。
- 关闭自动刷新时，在差异页解决冲突后变更区不会自动更新，需要手动刷新。

## Testing

- `test/conflict-entry.test.mjs`：七种 XY 到种类的映射、分组白名单（冲突不进另外两组）、动作可用性矩阵、冲突标记检测、已暂存计数排除未合并条目。
- `test/api-conflict.test.mjs`：经真实路由与临时仓库构造 `UU`/`AA`/`DU`/`UD`，断言差异有 hunk 且新侧含冲突标记、阶段取值、五种动作的结局、已解决路径与缺失阶段的报错、单条失败不影响同批；另有一条负向用例证明 `git restore` 与 `show :<path>` 对未合并路径都会失败，因此丢弃不能复用。
- `test/status-snapshot.test.mjs`、`test/submit-state.test.mjs`、`test/forge-adapter.test.mjs`：分别为未合并标记、冲突未解决时不可提交、冲突操作条与标记行着色。
