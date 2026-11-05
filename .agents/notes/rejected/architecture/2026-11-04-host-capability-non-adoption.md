# Agent Note: 不迁往宿主能力面的判定

Status: rejected — 每项在数据模型、作用域或生命周期上与宿主能力不对齐

## Problem

审计插件中"应当使用宿主能力却自行实现"的位置时，有若干项看似是重复造轮子。逐项核对宿主能力后，它们各自在数据模型、作用域或生命周期上与宿主提供的语义不对齐，迁过去会改变行为而非消除重复。本记录保存这些判定及其依据，避免反复重新评估。

## Proposal

按宿主能力归组，逐组说明为什么不采用。

### 日志：不换成 `ctx.logger`

`logger.ts` 自建 logcat 格式、级别门控、缓冲合并写、保留期与体积淘汰，运行在 `pluginHome()` 下按启动分文件的日志里。

`ctx.logger` 只把结构化 `Message { sn, ts, name, type, level, args }` 分发给注册的 `Exporter`，自身不写文件；DSH base bundle 里没有文件 exporter。两个消费方 `session-log-deepseek` 与 `session-telemetry-otel` 以 `sessionId` 为键，经 OTLP 上报到远端 collector，且 `FEEDBACK_ONLY` 模式下只在用户显式提交反馈后才释放该会话的日志前缀。

本插件要的是"按启动分文件、有保留期、可被反馈页读取并脱敏打包"。换成 `ctx.logger` 会让 `recentLogFiles` / `currentLogFile` / `readLogForAttach` 与反馈 outbox 整条链路失去数据源。`client/api/log.ts` 的队列与 `logEvent` 命令批量上报存在的目的正是把浏览器侧日志送回宿主写进那个文件——浏览器侧 `ctx.logger` 没有 exporter 即只到 console，等于丢日志。两者是同一条链路，一并保留。

### 设置：不换成 `ctx.settings` + `SettingsForm`

`SettingsForm` 原语与 `ctx.settings` 硬绑定：需要 namespace 声明、路径式 `mutate(ops, expectedRevision)`、**暂存-保存**模型（原语文档写明"Only a save writes. Leaving the page drops every staged edit"且无 discard 控件）与 revision fencing。

本插件的设置是**按工作区的即时开关**：改动即生效并刷新，存储在插件自己的 storage domain 里。换过去会变成全局（写 profile patch）且需手动保存，属功能回退而非重构。只取 UI 外观则要自建等价的暂存模型，等于把 `settings.ts` 的 296 行重写一遍。

### 提交草稿：不搬进宿主持久化

草稿现放在浏览器 `sessionStorage`（`ggg-commit-msg:<仓库根>`），随标签页消失。

草稿是瞬时意图，用户关掉标签页即放弃这次提交；搬进宿主会让下次启动冒出半截提交信息，是噪声不是便利。`git commit` 本身没有草稿概念（`COMMIT_EDITMSG` 会被下次提交覆盖），持久化等于发明 git 没有的语义。需要跨会话保留的是提交模板这类规则，那归 `aiCommitRules` 设置，不是逐仓库草稿。

### 工作区：不换成 `ctx.workspaces`

`client/index.ts` 的 `startWorkspacePreload` 与 `repo-preload.ts` 从 `ctx.sessions` 快照推当前工作区根。

`ctx.workspaces` 与 `ctx.sessions` 是正交的两套模型，三个缺口使其无法替代：`WorkspaceView.path` 是工作区根目录，而本插件的仓库发现以**会话 `cwd`** 为根向下扫（会话可在工作区任意子目录启动，用 `path` 会扫错层级）；`WorkspaceSnapshot` 只有 `sessionIds` 有序数组，没有"当前显示哪个"的概念（那属于 `ui-workspace` 的导航状态，真正的判据仍是 `retainInfo(id).retainedBy.mainView`）；工作区不给 `origin`，无法排除子代理会话。`ctx.workspaces` 管的是目录分组 / 排序 / 归档 / 置顶，与会话身份与 cwd 无关。

### ssh：不换成 `ctx.ssh`

`ssh-status.ts` 自写探测（`BatchMode`、`~/.ssh` 私钥扫描、认证判定）。

`ctx.ssh` 是"部署方持有远端执行世界"的连接 owner，配置要求 host、远端 helper 路径与 SHA-256，把 `ctx.fs` / `ctx.subprocess` 整体搬到远端。本插件要的是**本机诊断**（装没装、有哪些私钥、能否认证 github.com），未装载 ssh 包时也要能给出"未安装"。两者方向与前提都不同，`ctx.ssh` 不覆盖 Windows 客户端探测。此外 base bundle 与 desktop profile 都没有安装该包。

### 右键菜单：已改走双轨兼容

`context-menu.ts` 现按宿主能力二选一：`ctx.inject(['contextMenus'])` 探测到服务时走宿主共享菜单，否则保留自建浮层。决策与退出条件见[双轨兼容记录](../../implemented/architecture/2026-11-05-dual-track-context-menu.md)。

本记录只保留当时的判定依据：`ctx.contextMenus`（`open` / `register` / `notify`）所在的 `packages/client/ui-context-menu` 在提交 `411f157983`（2026-10-22）引入主干，直到 `dsh-v0.2.2-alpha.3`（2026-11-03）才随宿主发布；0.2.1-rc.5 里 `contextMenus` / `useContextMenu` 零命中，因此不能直接切换。

### 其余保留项

- `webServer.register` 路由注册本身：`webServer` 就是官方 seam。
- `host-cache.ts` 的按仓库作废、`repo-watcher.ts` 的结构判定、`git-exec.ts` 的 `isGitIdle` 门控：git 语义业务逻辑，无 DSH 对应。
- `pruneWorkspaces` 的 30 天 / 200 条淘汰：业务策略，storage domain 不提供淘汰。
- `native-open.ts`、`terminal-run.ts`、`file-diff.tsx` 的 `useCodeHighlighter`：已在用宿主能力。
- `worktree-remove.ts` 自跑 `git worktree remove`：`ctx.worktrees` 只创建、且是未进 base 与 web-app 组合的实验包。
- 插件自身持久化与日志（`pluginHome()` 下的 `state.json`、日志、反馈 outbox）：这些路径在 `writableRoots` 之外，走 `ctx.fs` 会得到 `FS_SANDBOX_DENIED`。
- 测试进程用 `test/host-fixture.mjs` 以 Node 原生实现填满同一份能力面：生产代码没有原生回退，测试进程也没有宿主，替身只服务测试。

## Alternatives considered

**逐项迁过去，接受行为变化。** 否决：设置从按工作区变全局、草稿从瞬时变永久、日志从本地文件变远端上报，这些都不是重构而是功能回退，且回退方向与用户已经表达的偏好相反。

**保留但不再评估，不记录理由。** 否决：这正是本记录要防止的——每项都看似是重复造轮子，没有记录就会反复重新评估，且评估本身需要读宿主源码与打探针（Typert 一项耗时约 40 分钟）。

**只为日志注册一个自建文件 exporter，复用 `ctx.logger` 的分发。** 否决：`Exporter` 只给 `{ sn, ts, name, type, level, args }`，logcat 格式、保留期与体积淘汰一行都省不掉；而 `Message` 没有"本次启动"这个维度，无法表达"一次启动一个文件"的语义。

## Consequences

这些位置维持自行实现。代价是插件在这几处与宿主能力面并行，需要各自维护；收益是行为语义不变，且与第三方插件的通行做法一致。

判定依据保存在此，后续若宿主能力变化（如 `api-remotes` 开放第三方贡献、`ctx.logger` 增加文件 exporter、`contextMenus` 进入支持的版本区间），应重新评估并新增记录，而不是修改本记录。
