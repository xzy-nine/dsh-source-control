## 一、宿主侧服务与能力 seam

| # | 位置 | 现状（自行实现） | 应使用 | 依据 | 优先级 | 优势 | 劣势与风险 |
|---|---|---|---|---|---|---|---|
| 9 | [routes.ts:340](src/source-control/routes.ts#L340)、[api/http.ts:17](src/source-control/api/http.ts#L17)、[api/events.ts:81](src/source-control/api/events.ts#L81)、[client/api/http.ts](src/client/api/http.ts)、[client/api/stream.ts](src/client/api/stream.ts) | 自建 `/dsh-source-control/gg/api` 命令分派、手写 JSON 请求体、自写 SSE 事件流与客户端 fetch 传输 | Typert Remote（`@Remote` + `ctx.remote.<ns>`）+ API Gateway 的 Remote stream | [adding-a-remote-api.zh.md](E:/GitHubCode/02DSH/deepseek-harness/docs/cookbook/adding-a-remote-api.zh.md)、[web-client.zh.md:28-34](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/web-client.zh.md#L28-L34) | P2 | 生成式类型契约、取消、`RemoteError` 码表、logical stream 与 generation 重连、鉴权与 trust 归 connection，去掉手写 JSON、SSE 与 400 | 改动面等于整个面板：约 40 条命令、并发合并、命令耗时汇总、SSE 广播与 400 语义都要重新表达；需 TypertRemoteService + 两个生成入口 + 构建期生成器（本仓库现为 tsc + esbuild）；新增 typert-protocol peer 依赖。建议先在新命令上试点 |

## 二、客户端服务与 UI 原语

| # | 位置 | 现状（自行实现） | 应使用 | 依据 | 优先级 | 优势 | 劣势与风险 |
|---|---|---|---|---|---|---|---|
| 18 | [context-menu.ts:209](src/client/ui/context-menu.ts#L209) | 自建右键浮层（`createRoot` + 自定位 + 二级菜单翻向补丁） | `ctx.contextMenus`（`open` / `register` / `notify`） | `packages/client/ui-context-menu`（提交 `411f157983`） | **暂缓** | 原生定位、键盘、子菜单与视口夹取，自动 dismiss 并与 modal 层协作，删掉自建 createRoot 与翻向补丁 | 暂缓原因：该包 `dsh-v0.2.2-alpha.3` 才发布——`dsh-v0.2.1-rc.2`、`dsh-v0.2.1-rc.5`、`dsh-v0.2.2-alpha.2` 三个 tag 都没有 `packages/client/ui-context-menu`，本机 app.asar（0.2.1-rc.5）里 `contextMenus` / `useContextMenu` 零命中；`docs/upgrade-guide/v0.2.1-rc.2/context-menu-services/` 只说明 `ctx.menus → ctx.contextMenus` 改名，不代表该版本有包。恢复条件：engines 下限抬到 `>=0.2.2-alpha.3`，届时本机 0.2.1-rc.5 会因区间不符拒绝加载本插件。另：菜单项现由 JSON 元数据加闭包命令式构造，要改成 target 与 contribution 注册模型，10 处调用点全部重写，`hint` 在 `MenuActionView` 无对应字段会丢 |

## 三、判定为可保留（不列入改造）

- `webServer.register` 路由注册本身：`webServer` 就是官方 seam（[web-server.zh.md](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/web-server.zh.md)），问题只在 #9 的 RPC 与事件流形态。
- `host-cache.ts` 的按仓库作废、`repo-watcher.ts` 的结构判定、`git-exec.ts` 的 `isGitIdle` 门控：git 语义业务逻辑，无 DSH 对应。
- `pruneWorkspaces` 的 30 天 / 200 条淘汰：业务策略，storage domain 不提供淘汰。
- `native-open.ts`、`terminal-run.ts`、`file-diff.tsx` 的 `useCodeHighlighter`：已在用宿主能力。
- `worktree-remove.ts` 自跑 `git worktree remove`：`ctx.worktrees` 只创建、且是未进 base 与 web-app 组合的 experimental 包，为一条 remove 引入它不划算。
- 插件自身持久化与日志（`pluginHome()` 下的 `state.json`、日志、反馈 outbox）：这些路径在 `writableRoots` 之外，`workspace-write` 下走 `ctx.fs` 会被 `FS_SANDBOX_DENIED` 拒绝，因此永久保留 `node:fs`。
- 测试进程用 `test/host-fixture.mjs` 以 Node 原生实现填满同一份能力面：生产代码没有原生回退，测试进程也没有宿主，替身只服务测试。
- `logger.ts` 自建 logcat 格式、级别门控、保留期与体积淘汰：`ctx.logger`（[logger.ts](E:/GitHubCode/02DSH/deepseek-harness/vendor/cordis/src/logger.ts)）只把结构化 `Message` 分发给注册的 `Exporter`，自身不写文件；DSH base bundle 里没有文件 exporter，两个消费方（`session-log-deepseek`、`session-telemetry-otel`）以 `sessionId` 为键并经 OTLP 上报远端 collector，只在用户显式提交反馈后释放。本插件要的是「按启动分文件、有保留期、可被反馈页读取并脱敏打包」，换成它会让 `recentLogFiles` / `currentLogFile` / `readLogForAttach` / outbox 整条链路失去数据源。
- `client/api/log.ts` 的队列 + `logEvent` 命令批量上报：浏览器侧 `ctx.logger` 没有 exporter 即只到 console，等于丢日志；它存在的目的正是把客户端日志送回宿主，写进上面那个按启动分文件的日志。与 `logger.ts` 同一条链路，一并保留。
- 提交草稿存 `sessionStorage`（`ggg-commit-msg:<仓库根>`）：草稿是**瞬时意图**，随标签页消失即用户放弃这次提交；搬进宿主会让下次启动冒出半截提交信息，是噪声不是便利。`git commit` 本身没有草稿概念（`COMMIT_EDITMSG` 会被下次提交覆盖），持久化等于发明 git 没有的语义。需要跨会话保留的是提交模板这类规则，归 `aiCommitRules` 设置，不是逐仓库草稿。
- 设置页自绘（`settings.ts` 与 `settings-model.ts`）：`SettingsForm` 原语与 `ctx.settings` 硬绑定——需要 namespace 声明、路径式 `mutate`、**暂存-保存**模型（离开页面丢弃、无 discard 控件）与 revision fencing。本插件设置是**按工作区的即时开关**（改动即生效并刷新），换过去会变成全局（profile patch）且需手动保存，属功能回退；只取 UI 外观则要自建等价的暂存模型，等于把 296 行重写一遍。
- 自取 `sessions` 快照推工作区（`client/index.ts` 的 `startWorkspacePreload` 与 `repo-preload.ts`）：`ctx.workspaces` 与 `ctx.sessions` 是正交的两套模型，三个缺口使其无法替代——①`WorkspaceView.path` 是工作区根目录，而本插件的仓库发现以**会话 `cwd`** 为根向下扫，会话可在工作区任意子目录启动，用 `path` 会扫错层级；②`WorkspaceSnapshot` 只有 `sessionIds` 有序数组，没有「当前显示哪个」的概念，那属于 `ui-workspace` 的导航状态，真正的判据仍是 `retainInfo(id).retainedBy.mainView`；③工作区不给 `origin`，无法排除子代理会话。`ctx.workspaces` 管的是目录分组 / 排序 / 归档 / 置顶，与会话身份与 cwd 无关。
- `ssh-status.ts` 自写 ssh 探测（`BatchMode`、`~/.ssh` 私钥扫描、认证判定）：`ctx.ssh`（[ssh.zh.md](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/ssh.zh.md)）是「部署方持有远端执行世界」的连接 owner，配置要求 host、远端 helper 路径与 SHA-256，把 `ctx.fs` / `ctx.subprocess` 整体搬到远端；本插件要的是**本机诊断**（装没装、有哪些私钥、能否认证 github.com），未装载 ssh 包时也要能给出「未安装」。两者方向与前提都不同，`ctx.ssh` 不覆盖 Windows 客户端探测。另：base bundle 与 desktop profile 都没有安装该包。

## 四、已完成（本轮已落地，从表中移除）

| # | 项 | 落地内容 |
|---|---|---|
| 1 | storage domain | `state-store.ts` 改为 `ctx.storageDomain.open(defineDomain(...))`，zod 校验全局槽；v1 / v2 / v3 旧文件统一在域为空时导入一次，旧文件不改不删；域未就位时有界重试，最终回退旧文件 |
| 2 | 原子写 | 回退路径保留同步 tmp + rename；`writeFileAtomic` 试过后移除——异步 API 让同进程读回旧文件落后一轮事件循环 |
| 3 | home-paths | 新增 `source-control/dsh-home.ts`，`DSH_SOURCE_CONTROL_HOME` → `resolveDshHome()`；状态文档、日志根、旧会话解析三处收敛到它 |
| 19 | writeClipboard | 删除 `copyText` 及其 `execCommand` 回退，6 处调用点改用 primitives 的 `writeClipboard` |
| 28 | md5 声明 | 删除 `client/shared/md5.d.ts` 与 `blueimp-md5` devDependency |
| 22 | relativeTime | 相对时间分档改由 primitives 的 `relativeTime(at, now)` 提供；`refresh-status.ts` 只留纯函数 `refreshTextOf(bucket)` 与文案表（新增天/月/年档），新模块 `panel/refresh-time.ts` 做分档到文案的代入 |
| 23 | fileSizeText | 宿主侧 `formatBytes` 整体删除、issue 正文不再写体积，宿主只回字节数；客户端日志文件列表改用 primitives 的 `fileSizeText` |
| 20 | toast 挂载 | `showToast(text)` 投常驻 `OverlayHost`（`installOverlay` 注册进根级 list 席位 `shell.overlay`），不再 `createRoot` + `document.body`；删除 `ToastTone` / `ToastOptions` / `HOLD_OF` / `holdFor`，只留信息类提示 |
| 16 | 会话工作区根 | `dsh-session-cwd.ts` 不再读 `session_projcache` 文件布局，改从 `ctx.sessionPersistence.list()` 的 `snapshot.header` 取 `id → cwd`；解析器仍可注入，服务缺失或 `list` 抛错时会话条目丢弃、不抛错 |
| 24 | 会话可见性判据 | `isSessionDisplayed(retain)` 与 `activeWorkspaceOf(infos)` 改为只读官方 `SessionRetainInfo` 与显式传入的会话信息；组件路径用席位标准 hook `useSessionRetainInfo`，模块级预加载用 `ctx.sessions.list` + `ctx.sessions.retainInfo(id)` |
| 25 | generation-store | 模块级登记表改由 `@deepseek-ai/dsh-client-store` 的 `createSnapshotStore` 承载（immer 草稿 + 订阅发布），按仓库键的归属语义与「空闲且无人订阅即删」保留 |
| 10 | 子进程 seam | 新增 `host-runtime.ts` 的 `runCollect`：走 `ctx.subprocess` 受管范围（整树终止、显式 stdio、`graceMs`、`DSH_*` 清理）；`git-exec.ts`、`gh-cli.ts`、`feedback.ts`、`log-archive.ts`、`ssh-status.ts` 五处调用点统一改走它。原生回退与 `child-process.ts` 已删除，缺服务即装载失败 |
| 11 | 进程树终止 | 自写 `taskkill /t /f` 整段删除，终止一律按 `SubprocessHandle.terminate()` 的受管范围下发 |
| 12 | 目录监视 | `repo-watcher.ts` 的 `node:fs` `watch` 改走 `watchDirAt`。`ctx.fs.watch` 只观察直接子项、不给名字与类型，因此工作区级监视补一层：给每个直接子目录各挂句柄，并按 `PROBE_DEPTH` 枚举仓库集合快照，未变即不通知 |
| 13 | 文件读取 | `repo-node.ts`、`repo-enrich.ts`、`worktree-branches.ts`、`repo-facts.ts`、`hooks.ts`、`repo-watcher.ts` 的 stat/readFile/readdir 改走 `probePathAt` / `readTextAt` / `listDirAt` / `statAt`；新鲜度守卫改用 seam 的 `version` 令牌 |
| 6 | 差异视图偏好 | `diff-view.ts` 改为纯映射（`diffViewOf` / `withDiffView`），选择并入 `Settings` 的 `diffSplit` / `diffWrap`，与其它视图开关同源并随宿主持久化；新增 `diff/use-diff-view.ts` 的 `useDiffView(cwd)` 负责预取后回填与写回 |
| 7 | 浏览器存储豁免标注 | `api/state.ts` 的旧键迁移与 `panel/storage.ts` 的会话级草稿各自标注为「浏览器不持久化」的唯一例外，并说明草稿随标签页消失正是期望行为 |
| 17 | 缓存淘汰收口 | 新增 `src/shared/lru-map.ts`（`LruMap` + `CacheLimit` + `TRIM_RATIO`），宿主 `host-cache.ts` / `repo-facts.ts` 与客户端 `client/shared/cache.ts` 共用同一份容量与淘汰顺序；`putCached` / `getCached` 去掉 `limit` 形参，TTL 包装仍留 host-cache |
| 21 | 弹窗挂载 | `runDialog` 改为投 `OverlayHost` 的 FIFO 队列（不再是每次一个 React 根）；新增 `showError(message)` 错误弹窗，正文可滚动可整段复制，错误类提示全部由 toast 改为弹窗 |
