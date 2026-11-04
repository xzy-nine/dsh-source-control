# Agent Note: 持久化维度改为工作区与仓库

Status: implemented

## Problem

类型化状态文档把「选中仓库」与「展开集合」按 `sessionId` 分区（`sessions[sessionId]`），同时把已知仓库位置按工作区根分区（`repoLocations[normCwd]`）。这带来两个问题：

- **同一工作区在不同对话里状态割裂**。树状态是「这个地方长什么样、上次看到哪」，属于工作区，不属于某一轮对话。同一个仓库根下开两个对话，选中与展开各记一份，切过去就是另一副样子；实测 `state.json` 里同一工作区根对应多条 sessionId 记录（如多条都指向 `E:\GitHubCode\02DSH`）。
- **两个分区维度并存**。`sessions` 与 `repoLocations` 都是「按某层目录分键」，一个用会话 id、一个用归一化路径，读写要分别记两套约定。

此外，`sessionId` 会随对话不断新增，而没有任何映射能把旧会话键还原成工作区。

## Decision

### 工作区是唯一的分区单位

`schemaVersion` 升到 3，`workspaces[normCwd] = { selectedRepo, expandedRepos, repos, updatedAt }` 取代原来的 `sessions` 与 `repoLocations` 两个分区：工作区根一个键承载该工作区根的全部状态，同一工作区下的多个对话共享同一份树状态。仓库位置并入同一表（`writeWorkspace` 的 `repos` 字段），`readRepoLocations` / `writeRepoLocations` / `listRepoLocationWorkspaces` 退化为经工作区的薄访问器。

`writeWorkspace` 合并部分更新、刷 `updatedAt`，并在树状态都空且无仓库位置时删除该工作区；`pruneWorkspaces` 在宿主启动时清理过期（30 天）与超量（200 条上限）工作区。

### 迁移：从 DSH 会话存储还原工作区

旧记录按 `sessionId` 分键，没有工作区信息。`dsh-session-cwd.ts` 从 `ctx.sessionPersistence.list()` 的 `snapshot.header.cwd` 读取该会话的工作区根——这是唯一能把旧会话键还原成工作区的来源，只在迁移时读一次列表，header 缺失或字段不可用时丢弃该条。读取方式见 [状态改由 storage domain 与 DSH 会话存储承载](2026-11-04-storage-domain-and-session-persistence.md)。

`migrateV1ToV3`（平铺 entries + 顶层 `repos`）与 `migrateV2ToV3`（`sessions` + `repoLocations`）把它作为注入的解析器参数，因此可脱离真实 DSH 存储单测。同一工作区落到多条会话时按 `updatedAt` 取最新一条：选中与展开是「上次离开这里时的样子」，取最近一次才符合预期，求并集会把用户从未在此工作区展开过的节点带进来。

树状态与仓库位置是不同字段、不同来源，合并时**不互相覆盖也不互相阻碍**：仓库位置只有一个来源，树状态在会话之间竞争；`updatedAt` 取各来源的最大值，只有仓库位置的工作区用迁移时刻兜底，否则会被立即判为过期。

### 客户端按工作区分键

`panel/storage.ts` 的 `getSession` / `setSession` 换成 `getWorkspace` / `setWorkspace`，入参是工作区根路径而非会话 id。`repo-tree.ts` 的 `loadSelection` / `saveSelection` / `loadExpanded` / `saveExpanded` 与 `use-repos.ts` 随之改为按 `cwd` 键；`useRepos` 不再需要 `sessionId`。

## Alternatives considered

**保留按会话分区，只把同一工作区的记录做展示时合并。** 否决：合并只发生在读取侧，写回仍按会话各存一份，下一次进入又会分叉；维度错了要在每一处读取点补偿。

**按仓库键而非工作区键。** 否决：选中与展开的最小单位是「工作区根下的一棵树」，一个工作区根常常包含多个仓库；按仓库键会让「展开工作区根」这类跨仓库状态无处安放。

**迁移时丢弃旧会话记录。** 否决：实测 53 条旧记录都能还原出工作区根，丢弃等于让用户在每个工作区重新选一次仓库、重新展开。

**读 `.dsh/sessions/<编码工作区>/<sessionId>` 目录名反解工作区。** 否决：目录名是转义后的编码（非 ASCII 段变成 `~XXXX~`），反解不可靠；会话持久化服务的 header 里有原始 `cwd` 字符串。

**客户端延迟重键：首次带 cwd 写入时合并该会话的旧记录。** 否决：旧记录要等用户下次进入对应会话才归位，在此之前状态一直是错的；宿主有解析器可用时应当一次迁完。

## Consequences

状态文档的分区维度统一为工作区与仓库，`sessions` 与 `repoLocations` 两个分区合并为 `workspaces`。同一工作区下的多个对话共享选中与展开，不再各记一份。旧记录经 DSH 会话存储一次性还原，无法还原的丢弃。`schemaVersion` 从 2 升到 3，`load()` 对 v1 与 v2 文档分别自动迁移并落盘。新增 `dsh-session-cwd.ts` 读取 DSH 会话存储，是插件唯一依赖 DSH 内部存储格式的地方。`test/state-store.test.mjs` 覆盖两版迁移、工作区合并与清理、仓库位置访问器。

## Related

- [类型化状态文档](2026-11-03-typed-state-document.md)：本文改动的直接前身，类型化分区与宿主单点迁移的机制沿用，分区维度由会话改为工作区。
