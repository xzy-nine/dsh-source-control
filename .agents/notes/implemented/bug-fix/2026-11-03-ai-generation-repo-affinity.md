# Agent Note: AI 生成任务按发起仓库归属

Status: implemented

## Problem

在仓库 A 发起 AI 生成提交信息，生成过程中切换到该仓库下的子模块（子模块作为独立会话工作区打开）。生成完成后，提交消息被写入子模块的提交消息框。

根因是生成状态活在组件实例里：`useCommitComposer` 用 `useState` 存 `aiBusy` / `aiWarning` / `aiStats`，`onChunk` 直接 `setMessage(prev => prev + text)`。切换仓库会让面板换掉 `workingTreePath`、切换会话会让面板重新挂载，而生成请求的闭包捕获的仍是旧实例的 setter —— 流式回调把文本写进「当前渲染的那个提交框」。

早先用「切换仓库即中断请求」修过一次，仍有错位：中断与切换之间有竞态窗口，已到达的分片仍可能写进新仓库；而且中断本身就丢失了用户等待的结果。

## Decision

### 生成状态按仓库登记，活在模块级

`panel/generation-store.ts` 以归一化仓库路径为键登记 `{ text, busy, warning, stats }`，提供 `beginGeneration` / `appendGeneration` / `warnGeneration` / `noteGenerationStats` / `endGeneration` 与订阅。状态不随组件挂载，因此换仓库、换会话、关侧栏页都不丢。

### 发起时绑定仓库，全程只写那一份

`handleAiCommit` 在发起时 `const repo = workingTreePath`，所有流式回调写 `repo` 的登记。`generateCommitMessage` 不再接收 `AbortSignal`，组件卸载时也不再 abort —— 请求自然跑完。

### 上屏判据：当前仓库 + 生成已结束 + 在屏幕上 + 草稿已读回

`panel/generation-landing.ts` 的 `canLandGeneration` 是纯函数判据。四条同时成立才把结果写进提交框：结果属于当前仓库、该仓库生成已结束、提交框在屏幕上、该仓库草稿已读回。`takeGenerationText` 取走即清空，因此文本只交付一次，切回不会重复写入。

「在屏幕上」由 `src/client/index.ts` 从宿主契约算出：`tab.visible`（面板展开 + 本页是当前页 + 窗口活跃）且所在会话正被主视图显示。会话判定复用 `panel/repo-preload.ts` 的 `isSessionDisplayed`，与仓库预加载同一判据 —— `retainedBy.mainView` 是**引用计数**（数字），大于 0 才算显示；旧宿主回退 `current`。

### 子模块按独立工作区处理

子模块作为独立会话打开时，它有自己的仓库路径键，登记天然隔离；仓库选择器不额外列出子模块节点。

## Alternatives considered

**继续用「切换仓库即中断生成」。** 否决：这是上一次修复的做法，仍会错位 —— 中断与切换之间有竞态，已到达的分片写进新仓库；而且用户等待的结果被丢弃。

**在 `onChunk` 里比对 `workingTreePath` 与发起时的仓库，不同就丢弃。** 否决：丢弃等于中断，同样丢结果；而且闭包捕获的 `workingTreePath` 是渲染时快照，比对本身不可靠。

**把生成状态挂在 React context 上跨挂载保留。** 否决：context 仍随组件树卸载而销毁，切会话重新挂载后同样丢失；模块级登记更直接。

**上屏时只看「当前仓库」，不看侧栏页是否可见。** 否决：侧栏页关着时写进提交框，用户看不到写入动作，再打开时无法区分这是刚生成的还是自己写的。

**上屏时不检查草稿是否读回。** 否决：草稿读回是异步的，先写会被随后的 `setMessage(saved)` 覆盖，表现为「生成完但框里是旧草稿」。

## Consequences

**收益**：生成结果永远只进发起仓库的提交框；切换仓库、切换会话、关闭侧栏页都不中断生成，结果暂存到该仓库并在它回到前台时上屏；`aiBusy` 也按仓库取，切到别的仓库不会再显示「生成中」，切回 A 时若仍在生成则正确显示进行中，已完成则不显示。

**代价**：

- 生成状态不再随组件卸载消失，模块级 Map 需在无订阅且不忙时清理（`subscribeGeneration` 的退订路径已处理），否则长时间运行会按仓库累积。
- 关闭侧栏页后生成继续跑，模型调用照常计费 —— 用户看不到进度，但结果不丢。
- 上屏依赖宿主的 `tab.visible` 与会话 `retainedBy.mainView` 两个字段；宿主契约变化时这两处要同步。前者是布尔，后者是引用计数，类型不同不可混用。

## Testing

- `test/generation-store.test.mjs`：仓库归属（子模块收不到 A 的文本）、不中断、只交付一次、进行中不交付、告警与统计归属、路径写法归一、订阅与退订、清空。把 `normalizePath` 换成常量即变红。
- 同文件「生成结果上屏判据」七条：`canLandGeneration` 的每个否定条件各一条，去掉 `onScreen` 即变红。
- `test/panel-remount.test.mjs`「AI 生成按发起仓库归属」：断言发起时绑定仓库、状态按当前仓库取、源码中不再有 `aiAbortRef`。
- 同文件「提交框上屏条件取自会话判定与侧栏页可见性」：只断言传递链；判据本身按行为测。
- `test/session-visibility.test.mjs`：`isSessionDisplayed` 的五种输入（计数大于 0、为 0、缺失、旧宿主 `current`、快照为空）。把判定写成 `count === true` 即变红 —— 这正是曾让生成结果永不上屏的写法。
