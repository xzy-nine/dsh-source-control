# Agent Note: 远程操作不阻塞同仓库的读取视图

Status: implemented

## Problem

仓库 X 执行远程分支操作（推送、删除远程分支、抓取）期间，另开一个会话、切走再切回、新开标签页或在面板内重进，仓库 X 的变更列表与提交图都停在占位，直到远程操作结束才恢复。

日志里可见的形态：一次 `git push origin --delete` 执行 156.7 秒，同一轮的提交图墙钟也是 156.8 秒；同期该仓库只有 1 条只读命令被执行（另一次网络操作期间为 0 条）。

三处独立耦合叠加：

- **宿主门控过宽**：`loadCommits` 等 `whenGitIdle`，而 `isGitIdle` 只排除只读类别，`network`（`push` / `fetch` / `pull` / `ls-remote` / `clone`）因此被判为忙。一次推送挂几十秒到几分钟，提交图就等这么久。
- **客户端门控同样过宽**：事件驱动的刷新、兜底轮询与文件改动刷新都用 `isRepoBusy`，任一影响面在忙就挂起，包括 `network`。
- **单一阶段标志**：`PanelState.phase` 只在两路取数都返回后写 `ready`，而更改区与图形区都用它判占位。快照先回、`entries` 已写入也不改 `phase`，于是已经取到的变更列表继续显示占位。

## Decision

### 宿主：读取路径等「本地状态稳定」

`git-exec.ts` 新增 `isLocalSettled` / `whenLocalSettled`：与 `isGitIdle` 的差别是排除 `network`。推送与抓取期间本地对象库与工作区都不被改写，引用由 git 逐个原子更新（写临时文件再重命名），读到的要么是命令前、要么是命令后的一致状态。

`whenWorktreeIdle` 与 `isWorktreeIdle` 合并进这一对：两者原来的实现完全相同（都是「非只读且非 network」），分开命名会让读者以为工作区与引用有不同的判据。工作区快照、提交图、仓库信息三处读取路径都改用它。写操作与需要独占仓库的联网操作仍用含联网命令的 `whenGitIdle`。

### 客户端：后台读取不被联网操作挂起

`panel/busy.ts` 新增 `isReadBlocked(entries, repo)`：只把 `read` / `commit` / `history` 三档算作阻塞。`use-file-change-refresh.ts`、`use-graph-polling.ts`、`use-repository-write-events.ts` 三处门控改用它。`use-auto-fetch.ts` 保持 `isRepoBusy` 全量门控 —— 抓取自身是一次网络往返，不该与其它网络操作叠加。

### 客户端：两个分区各有自己的就绪阶段

`PanelState` 增加 `entriesPhase: 'loading' | 'ready'`。`mergeSnapshot`（快照落地的唯一入口，`refresh` 与兜底轮询都经它）把它置 `ready`；`phase` 仍只由提交图那一路推进。更改区读 `entriesPhase`，图形区读 `phase`。

## Alternatives considered

**让 `loadCommits` 完全不等任何操作。** 否决：提交、检出、合并会连续改写多个引用与索引，中途读到的组合不一致，提交图会短暂画出与工作区不匹配的状态。

**只改宿主，不动客户端门控。** 否决：宿主不再等之后，客户端仍会在推送期间挂起写事件触发的刷新与轮询，恢复慢一拍；两处判据不同源也会在后续改动里再次分叉。

**只改客户端，不动宿主门控。** 否决：主因在宿主，提交图请求本身就会挂到推送结束，客户端做什么都来不及。

**把 `phase` 改成两个字段但保留 `whenWorktreeIdle` 的独立命名。** 否决：两者实现完全相同，保留两个名字只会让人以为判据不同；合并后调用点也更少。

**在推送期间显示旧数据并标记「更新中」。** 不在本次范围：读取本身已不再被挡住，先解决阻塞；陈旧数据展示是另一项可见行为决策。

## Consequences

**收益**：远程操作进行中，同仓库的变更列表与提交图照常取数与渲染；变更列表在快照返回时即可显示，不再等提交图。实测用例中，一次阻塞 6 秒的推送期间读取耗时从 5,370 ms（等到推送结束）降到 200 ms 量级。

**代价**：

- 推送正在改写远程跟踪引用的瞬间，提交图可能读到「推送前」的远程分支列表，下一次刷新即修正。
- `isReadBlocked` 与 `isLocalSettled` 是同一判据的两处实现（客户端与宿主各一份），改影响面语义时两处都要动。
- `entriesPhase` 让 `PanelState` 多一个字段，`rememberPanelState` 与 `graph-state.ts` 的合并都要维护它。

## Testing

- `test/fetch-path.test.mjs`「远程操作进行中，提交图与工作区快照照常返回」：裸仓库的 `pre-receive` 钩子睡 6 秒让推送真的挂住，再断言读取在 4 秒内返回。把 `loadCommits` 的门控换回 `whenGitIdle` 即变红（实测等 5,370 ms）。钩子必须带 shebang，否则 git 起不来钩子、推送秒回，用例会假绿。
- `test/panel-busy.test.mjs`「联网操作不挡住后台读取」「本地写操作挡住后台读取」：`isReadBlocked` 的四条边界。
- `test/graph-state.test.mjs`「快照落地即把变更列表那一路置为就绪，提交图仍是加载中」：去掉 `mergeSnapshot` 里的 `entriesPhase` 即变红。
- `test/panel-remount.test.mjs`「变更列表与提交图各有自己的就绪阶段」：源码结构断言，两个分区各读哪个字段。
