# Agent Note: 状态改由 storage domain 与 DSH 会话存储承载

Status: implemented

## Problem

类型化状态文档把数据落在插件自己的 `$DSH_HOME/dsh-source-control/state.json`，并用插件自写的 `schemaVersion` + 原子 tmp+rename 维护它；会话工作区根则靠解析 `$DSH_HOME/storages/session_projcache/sessions/<id>.json` 的文件布局。

这两处都在复刻宿主已有的能力：宿主提供 `ctx.storageDomain`（类型化单元、单点 schema 校验、版本演进）与 `ctx.sessionPersistence`（权威的会话头，含 `cwd`）。插件自写的版本号与原子写因此是第二套持久化语义，而 `session_projcache` 的文件布局是宿主的内部实现细节，随宿主升级即失效。

此外 `$DSH_HOME` 的解析在三个位置各写一套。

## Decision

### state-store 走 storage domain

`state-store.ts` 改为 `ctx.storageDomain.open(defineDomain({ name: 'source_control', version: 1, global: { schema: DocumentSchema, initial: emptyDocument() }, tables: {} }))`，`DocumentSchema` 是 zod 全局槽，与 `StateDocument` 一一对应。

旧的 `state.json`（v1 / v2 / v3）在域为空时（`writtenAt === 0`）导入一次，导入后旧文件**不改不删**：它只是迁移来源，不再是数据源。域未就位时写请求排队重试；重试耗尽后回退旧文件并保留同步 tmp+rename 原子写。`writeFileAtomic` 的异步版本试过后移除，因为异步写让同进程读回旧文件落后一轮事件循环。

### 会话工作区根改读会话持久化服务

`dsh-session-cwd.ts` 不再读 `session_projcache` 的文件布局，改从 `ctx.sessionPersistence.list()` 的 `snapshot.header` 取 `id → cwd`。解析器仍是可注入的参数，因此可脱离真实 DSH 存储单测；服务缺失或 `list` 抛错时会话条目丢弃、不抛错。

### 单一 home 解析器

新增 `source-control/dsh-home.ts`，`DSH_SOURCE_CONTROL_HOME` 优先、否则 `resolveDshHome()`。状态文档、日志根、旧会话解析三处收敛到它。插件自己的数据目录与日志永远不经 `ctx.fs`：它们在 `writableRoots` 之外，走 seam 会得到 `FS_SANDBOX_DENIED`。

### 会话可见性判据改用官方快照

`isSessionDisplayed(retain)` 与 `activeWorkspaceOf(infos)` 不再自行推断，只读官方 `SessionRetainInfo`（`retainedBy.mainView`）与显式传入的会话信息。组件路径用席位标准 hook `useSessionRetainInfo`，模块级预加载用 `ctx.sessions.list` 与 `ctx.sessions.retainInfo(id)`。

### 客户端快照存储改用 client-store

`panel/generation-store.ts` 的模块级登记表改由 `@deepseek-ai/dsh-client-store` 的 `createSnapshotStore` 承载（immer 草稿 + 订阅发布），按仓库键的归属语义与"空闲且无人订阅即删"保留。

## Alternatives considered

**保留自写 `schemaVersion` 与原子写。** 否决：宿主的 storage domain 已经拥有类型化单元与版本演进，两套版本号会各自漂移；且 domain 的写入语义与宿主其余存储一致，便于跨插件观测。

**导入旧文件后删除它。** 否决：旧文件是唯一的迁移来源，删掉即无法回滚；保持只读不删让升级可逆，代价仅是磁盘上一份陈旧副本。

**用 `writeFileAtomic` 的异步版本做 domain 之外的回退写。** 否决：异步 API 让同进程读回旧文件落后一轮事件循环，测试与迁移都会读到上一步的内容；回退路径保留同步实现。

**继续解析 `session_projcache` 目录布局。** 否决：那是宿主内部实现，字段与层级随版本变化；`ctx.sessionPersistence` 是公开 seam，且是权威副本。

**会话可见性自行推断（比较 cwd、比较 origin）。** 否决：`retainInfo` 的引用计数就是"谁在显示这个会话"，自行推断在子代理与多视图并存时会给出错误答案。

**插件数据目录也走 `ctx.fs`。** 否决：`$DSH_HOME` 下的插件目录在沙箱 `writableRoots` 之外，写入会被 `FS_SANDBOX_DENIED` 拒绝。这些路径由插件自己拥有，与工作区文件是两回事。

## Consequences

状态落在宿主的 storage domain（`$DSH_HOME/storages/source_control.json`），旧 `state.json` 冻结为迁移来源。会话工作区根从公开 seam 读取，不再依赖宿主内部文件布局。`$DSH_HOME` 只有一个解析入口。

代价是插件持久化依赖 `ctx.storageDomain` 与 `ctx.sessionPersistence` 的可用性：前者缺失时退回旧文件路径，后者缺失时会话条目丢弃（迁移因此可能不完整，但不抛错）。

## Testing

`test/state-store.test.mjs` 覆盖 v1 / v2 / v3 迁移、域为空时的导入与域不可用时的回退；`test/repo-workspace.test.mjs` 覆盖"命中持久化位置"；`test/generation-store.test.mjs` 覆盖快照存储的订阅与释放。
