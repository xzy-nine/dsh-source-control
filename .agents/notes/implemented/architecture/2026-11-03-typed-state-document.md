# Agent Note: 类型化状态文档与宿主单点迁移

Status: implemented

## Problem

插件状态落在 `$DSH_HOME/dsh-source-control/state.json`，旧结构（v1）是一张平铺 entries 表，键带命名空间前缀（`dsh-source-control-selection:*`、`dsh-source-control-repos:*`、`dsh-source-control-settings`、`dsh-source-control-expanded:*`、`dsh-source-control-ref-filter:*`、`ggg-commit-msg:*`），外加顶层 `repos` 数组与散落的 `version` / `dsh-source-control-migrated` 标记。六类问题：

- **混合命名空间平铺袋**：所有分区挤在一张 `entries` 表里，键前缀是唯一的分区线索，读写要靠字符串匹配。
- **expanded 双形态**：有时是数组、有时是 `JSON.stringify` 后的字符串，读取端要两种分支。
- **ref-filter 双结构**：全局表（`repoPath -> "all"`）与旧按仓库键（`{mode, selected}`）并存，后者还用引用短名而非完整名。
- **仓库列表双写**：`entries["dsh-source-control-repos:*"]` 与顶层 `repos[...]` 各存一份。
- **路径键未归一**：`e:/githubcode/...` 与 `E:\GitHubCode\...` 混存，同一仓库被当成两个键。
- **树状态无聚合、无清理**：selection 与 expanded 分两个键，没有 `updatedAt`，也没有淘汰。

## Decision

### 宿主：单一类型化文档

`state-store.ts` 持久化一份带 `schemaVersion` 的类型化文档，所有读写经分区访问器，`readSnapshot` 一次返回首屏所需的全量快照。`save` 是唯一写入口，原子 tmp+rename。具体分区与版本号由 [持久化维度改为工作区与仓库](2026-11-03-workspace-partitioned-state.md) 拥有。

路径键统一经 `normalizePath`（`\`→`/`、去尾斜杠、盘符小写），与客户端 `path-key.ts` 对齐。ref-filter 收敛为「`'all'` 或完整引用 id 列表」，自动模式不落盘。expanded 统一为 `string[]`。草稿从 `ggg-commit-msg:*` 移入 `drafts.commitMessages[normPath]`。

### 迁移：宿主统一调度

`load()` 首次读取时检测 `schemaVersion`，旧版文档原地迁移并落盘。分类逻辑是纯函数，文档迁移与 `mergeLegacyEntries` 共用。浏览器旧键迁移由客户端 `migrateLegacyState` 收集 localStorage / sessionStorage 里的旧键原样发给宿主 `mergeLegacyEntries` 命令——浏览器不持久化，也不承担格式转换，分类与合并全在宿主。搬完清掉浏览器旧键即幂等。

### 工作区清理

`pruneWorkspaces` 在宿主启动时调用：超过 30 天未更新的工作区删除，剩余超过 200 条按 `updatedAt` 升序删最旧。

### 客户端：类型化门面

`panel/storage.ts` 持有 `StateSnapshot` 内存缓存，`primeStorage` 预取，`dispatch(mutateCache, flush)` 更新缓存并异步写宿主。各消费者（`settings-model.ts`、`use-panel-layout.ts`、`repo-tree.ts`、`index.ts` 的 ref-filter、`use-commit-composer.ts`）经类型化 getter / setter 读写，不再各自拼键名。

## Alternatives considered

**保留平铺 entries，只加归一与去重。** 否决：前缀匹配是唯一的分区线索，后续每加一个分区都要再造一套前缀约定，类型安全无从落地。

**客户端做浏览器旧键分类后分类型化命令发宿主。** 否决：浏览器不持久化，分类逻辑会与宿主 `migrateV1ToV2` 重复且无法共享模块（宿主不导入客户端），`mergeLegacyEntries` 让宿主单点分类消除了这层重复。

**分区不清理，靠重启自然丢弃。** 否决：长期使用的实例会累积数百条，`readSnapshot` 每次全量序列化，首屏退化。

## Consequences

状态文档从一张前缀袋变成类型化分区，读写经访问器而非字符串键拼接，路径键统一归一。旧版用户首次进入时 `load()` 自动迁移并落盘。浏览器旧键迁移一次性完成后宿主是唯一数据源。分区有 `updatedAt` 与容量上限，不再无限增长。新增 `test/state-store.test.mjs` 覆盖归一、迁移、合并与清理、草稿读写。
