## 一、持久化与键位

| # | 位置 | 现状（自行实现） | 应使用 | 依据 | 优先级 | 优势 | 劣势与风险 |
|---|---|---|---|---|---|---|---|
| 4 | [logger.ts:55](src/source-control/logger.ts#L55)（全文） | 自建 logcat 格式、级别门控、缓冲合并写、保留期与体积淘汰 | `ctx.logger(name)`（Cordis logger 服务，exporter 由宿主安装） | [context.zh.md:133](E:/GitHubCode/02DSH/deepseek-harness/docs/cordis-api/context.zh.md#L133) | P1 | 级别与 exporter 由宿主统一，去掉自建格式与缓冲 | 反馈功能的日志打包读的是本插件按启动分文件、有保留期与脱敏的日志；改后文件位置与格式不归本插件，feedback / log-archive / log-retention 整条链路要重做。宜只接诊断输出，文件日志保留 |
| 5 | [storage.ts:8](src/client/panel/storage.ts#L8)、[:244](src/client/panel/storage.ts#L244) | 浏览器 `sessionStorage` 存提交草稿（`ggg-commit-msg:*`），不经宿主 | 宿主持久化（同 storage domain 的草稿表，或会话级持久化 seam） | [typed-state-document.md](.agents/notes/implemented/architecture/2026-11-03-workspace-partitioned-state.md)「浏览器不持久化」 | P1 | 换浏览器与清缓存不丢，与「浏览器不持久化」一致 | 草稿是会话级易失数据，搬宿主后跨会话可见需新的归属规则；每次输入要防抖往返，现挂载时同步读；随标签页消失可能正是期望行为 |
| 6 | [diff-view.ts:20](src/client/diff/diff-view.ts#L20) | 模块级 `Map` 存 split/wrap，刷新即丢 | `panel/storage.ts` 同一出口（宿主持久化） | 同上 | P1 | 刷新后保留 split/wrap | 纯视图偏好，宿主往返成本高于收益；更合适的落点是并入设置项，与其它视图设置同源 |
| 7 | [state.ts:158](src/client/api/state.ts#L158) | 直接遍历 `localStorage` / `sessionStorage` 旧键 | 迁移例外可留，但应作为唯一豁免点显式标注 | 同上 | P2 | — | 这是唯一访问浏览器存储的迁移例外；在代码处标注豁免即可 |
| 8 | [settings.ts:80](src/client/panel/settings.ts#L80) + [settings-model.ts](src/client/panel/settings-model.ts) | 自绘设置页与设置 JSON 形状 | `ctx.settings` 的 Config schema 表单 + `SettingsForm` 原语 | [adding-a-settings-card.zh.md](E:/GitHubCode/02DSH/deepseek-harness/docs/cookbook/adding-a-settings-card.zh.md)、[settings.zh.md](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/settings.zh.md) | P1（仅表单原语） | 原生设置卡片、revision 冲突保护、profile patch 持久化 | 本插件设置是按工作区的运行时开关，`ctx.settings` 投影的是插件 Config（profile 级、schemastery），语义不同；搬过去会变成全局生效并写 profile patch。可取部分仅是用 `SettingsForm` 原语渲染，数据仍留本插件 |
| 16 | [dsh-session-cwd.ts:34](src/source-control/dsh-session-cwd.ts#L34) | 直读 `$DSH_HOME/storages/session_projcache/sessions/<id>.json` 内部文件格式 | `ctx.sessionProjectionCache.cachedSnapshot(header)` / `ctx.sessions` | [session-projection.zh.md:230-254](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/session-projection.zh.md#L230-L254) | P1 | 不再依赖其它子系统的私有文件布局 | `cachedSnapshot` 要 SessionHeader 而非 sessionId；该代码只服务 v1 文档迁移，新装用户走不到，直接删迁移比换 API 更省 |
| 17 | [host-cache.ts:164](src/source-control/host-cache.ts#L164)（`putCached`/`getCached`） | 自写 TTL + LRU 淘汰 | 与 [client/shared/cache.ts](src/client/shared/cache.ts) 的 `LruMap` 重复，应收口一处 | 项目内部重复 | P1 | 宿主与客户端共用一份 TTL/LRU 实现，消除漂移 | `client/shared/cache.ts` 无 TTL，需加过期包装；宿主侧键的 `\0` 分隔与按仓库作废语义仍留 host-cache |

## 二、宿主侧服务与能力 seam

| # | 位置 | 现状（自行实现） | 应使用 | 依据 | 优先级 | 优势 | 劣势与风险 |
|---|---|---|---|---|---|---|---|
| 9 | [routes.ts:340](src/source-control/routes.ts#L340)、[api/http.ts:17](src/source-control/api/http.ts#L17)、[api/events.ts:81](src/source-control/api/events.ts#L81)、[client/api/http.ts](src/client/api/http.ts)、[client/api/stream.ts](src/client/api/stream.ts) | 自建 `/dsh-source-control/gg/api` 命令分派、手写 JSON 请求体、自写 SSE 事件流与客户端 fetch 传输 | Typert Remote（`@Remote` + `ctx.remote.<ns>`）+ API Gateway 的 Remote stream | [adding-a-remote-api.zh.md](E:/GitHubCode/02DSH/deepseek-harness/docs/cookbook/adding-a-remote-api.zh.md)、[web-client.zh.md:28-34](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/web-client.zh.md#L28-L34) | P2 | 生成式类型契约、取消、`RemoteError` 码表、logical stream 与 generation 重连、鉴权与 trust 归 connection，去掉手写 JSON、SSE 与 400 | 改动面等于整个面板：约 40 条命令、并发合并、命令耗时汇总、SSE 广播与 400 语义都要重新表达；需 TypertRemoteService + 两个生成入口 + 构建期生成器（本仓库现为 tsc + esbuild）；新增 typert-protocol peer 依赖。建议先在新命令上试点 |
| 10 | [child-process.ts:90](src/source-control/child-process.ts#L90)（整文件，含 `createLimiter`） | 自写 spawn、stdout/stderr 收集、超时、并发限流 | `ctx.subprocess`（收集模式 + spill + `graceMs` + managed range） | [subprocess.zh.md](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/subprocess.zh.md) | P2 | 受管进程范围终止、spill 溢出到文件、`DSH_*` 环境清理、显式 stdio | seam 不提供默认值，每处调用要写全 stdio 与 graceMs；git 输出是整份解析，spill 多一层读取；`createLimiter` 不在 seam 内仍要自留；跨远程执行世界时语义变化需重新验证 |
| 11 | [git-exec.ts:154](src/source-control/git-exec.ts#L154) | 自写 `taskkill /t /f` 整树终止与进程退出清理 | `SubprocessHandle.terminate()` / `waitForExit()` | 同上 | 随 #10 | `terminate()` 与 `waitForExit()` 覆盖整棵受管范围 | 自写 taskkill 只处理 Windows；脱离 #10 单独改无收益 |
| 12 | [repo-watcher.ts:246](src/source-control/repo-watcher.ts#L246)、[:341](src/source-control/repo-watcher.ts#L341) | 直接 `node:fs` 的 `watch` | `ctx.fs.watch(target, changed, signal)` | [filesystem.zh.md:411](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/filesystem.zh.md#L411) | P3 | 与远端、沙箱后端一致，signal 生命周期 | 现有监视的价值在过滤与去噪（无文件名事件的快照核对、250/400ms 合并、32 仓库上限、工作区递归下探），seam 只给 changed 回调，这些逻辑一行都省不掉；递归监视取决于后端能力 |
| 13 | [repo-discovery.ts](src/source-control/repo-discovery.ts)、[hooks.ts](src/source-control/hooks.ts)、[state-store.ts](src/source-control/state-store.ts) | 直接 `readFileSync` / `readdirSync` / `statSync` | `ctx.fs` 的 `stat` / `readText` / 列表 | 同上 | P3 | 尊重沙箱与远程后端 | 发现层按深度上限做大量 stat/readdir，走 seam 变成逐次异步往返；git 目录内部布局仍需原生路径。需要远程工作区支持时升为 P1 |
| 14 | [ssh-status.ts:211](src/source-control/ssh-status.ts#L211) | 自写 ssh 探测（`BatchMode`、`~/.ssh` 私钥扫描、认证判定） | `ctx.ssh`（`SshConnection`） | [ssh.zh.md:117](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/ssh.zh.md#L117)（宿主装载该包时） | P3 | 官方 SSH 连接归属与 helper runtime | `ssh-status` 是诊断（是否安装、私钥列表、认证结果），须在未装载 ssh 包时可用；`ctx.ssh` 是 POSIX 连接 owner，不覆盖 Windows 客户端探测 |
| 15 | [worktree-remove.ts:23](src/source-control/worktree-remove.ts#L23) | 自跑 `git worktree remove` | `ctx.worktrees`（experimental-worktree） | [capability-seams.zh.md:669](E:/GitHubCode/02DSH/deepseek-harness/docs/capability-seams.zh.md#L669)（实验包，按需） | P3 | 官方工作树创建 | 该 seam 只创建且为 experimental 包，未在 base 与 web-app 组合中；本插件做的是 remove，为一条命令引入实验包不划算 |

## 三、客户端服务与 UI 原语

| # | 位置 | 现状（自行实现） | 应使用 | 依据 | 优先级 | 优势 | 劣势与风险 |
|---|---|---|---|---|---|---|---|
| 18 | [context-menu.ts:209](src/client/ui/context-menu.ts#L209) | 自建右键浮层（`createRoot` + 自定位 + 二级菜单翻向补丁） | `ctx.contextMenus`（`open` / `register` / `notify`） | [context-menu-services guide](E:/GitHubCode/02DSH/deepseek-harness/docs/upgrade-guide/v0.2.1-rc.2/context-menu-services/guide.zh.md) | P1（需提升最低 DSH 版本） | 原生定位、键盘、子菜单与视口夹取，自动 dismiss 并与 modal 层协作，删掉自建 createRoot 与翻向补丁 | 该服务自 v0.2.1-rc.2 起提供且无兼容别名，而 engines 下限是 0.2.0-rc.2；菜单项现由 JSON 元数据加闭包命令式构造，要改成 target 与 contribution 注册模型；10 处调用点全部重写 |
| 20 | [toast.ts:55](src/client/panel/toast.ts#L55) | 自建 toast 挂载与去重 | `ctx.contextMenus.notify(...)`，或 `shell.overlay` 席位 | 同上；`ui-layout` slot `shell.overlay` | P1 | 不再自建挂载，位置与叠放由宿主决定 | `contextMenus.notify` 面向菜单动作反馈，「错误不被信息替换」与按文本长度延长停留的策略仍要自留。建议只换挂载（`shell.overlay` 席位），通知语义保留 |
| 21 | [dialog.ts:116](src/client/ui/dialog.ts#L116) | `document.body` + `createRoot` 自挂 Modal | `shell.overlay` / slot 席位（Modal 本身已用原语） | 同上 | P2 | 每次弹窗不再新建 React 根，遵守 `useModalLayer` 的顶层 Esc 与焦点归还 | Promise 式 API 要改成常驻 host 组件加队列；多弹窗关闭顺序规则要重新定义 |
| 22 | [refresh-status.ts:99](src/client/panel/refresh-status.ts#L99) | 自写相对时间分档（刚刚/分钟/小时） | primitives 的 `relativeTime(at, now)`（统一分档） | `ui-primitives` `relative-time.d.ts` | P1 | 与宿主其它界面同一套分档 | 分档更细（now/minutes/hours/days/months/years），现有文案只有三档，展示文本会变；primitives 只能由打包产物加载，纯函数单测需注入分档函数 |
| 23 | [feedback-text.ts:62](src/source-control/feedback-text.ts#L62) | 自写字节数格式化 | primitives 的 `fileSizeText(bytes)` | `ui-primitives` `file-size.d.ts` | P3 | 与附件等界面一致 | 该函数在客户端 primitives，调用点在宿主 `feedback-text.ts`；宿主引 primitives 会拉入 React 与 CSS，层次不对。保留，或把格式化搬到客户端 |
| 24 | [repo-preload.ts:130](src/client/panel/repo-preload.ts#L130)、[:141](src/client/panel/repo-preload.ts#L141) | 手工读 sessions 快照判 `retainedBy.mainView` / `current`、自取 cwd | `useSessionRetainInfo` / `useSessionStatus`（Session scope 席位已注入） | [web-client.zh.md:60](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/web-client.zh.md#L60)；`ui-session` 导出 | P2 | 不再依赖 sessions 快照的 `retainedBy` 内部形状 | 两处调用在模块级预加载（非组件），hook 用不上，须由面板把结果传进 preload；`activeWorkspaceOf` 的选取规则仍要自留 |
| 25 | [generation-store.ts](src/client/panel/generation-store.ts) | 模块级 `Map` + `Set<listener>` 手写 observable | `@deepseek-ai/dsh-client-store` 的 `defineStore` / `createSnapshotStore` | `client/store` | P3 | immer 加 rafFlush 的成熟实现，且可开 `persist` | 为约 40 行的按仓库登记表引入一个客户端 store 依赖，收益低；`client-store` 与 `ui-primitives` 同属平台模块，需确认可外部化 |
| 26 | [client/api/log.ts:42](src/client/api/log.ts#L42) | 自建队列 + `logEvent` 命令批量上报 | `ctx.logger`（客户端 Context 同样提供） | 同 #4 | P2 | 去掉队列与 `logEvent` 命令 | 浏览器侧 logger 默认只到 console，无 exporter 即等于丢日志，这正是 logEvent 存在的原因；与 #4 一并判断 |
| 27 | [client/index.ts:520](src/client/index.ts#L520) 与 [repo-preload.ts](src/client/panel/repo-preload.ts) | 自取 `sessions` 快照推工作区 | `ctx.workspaces`（ClientWorkspaceModel） | [web-client.zh.md:52](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/web-client.zh.md#L52) | P2 | 官方工作区模型（归档、置顶、顺序） | 本插件要的是当前会话的工作区根与仓库级状态，前者来自 sessions 而非 workspace 列表，可替代范围有限 |

## 四、判定为可保留（不列入改造）

- `webServer.register` 路由注册本身：`webServer` 就是官方 seam（[web-server.zh.md](E:/GitHubCode/02DSH/deepseek-harness/docs/subsystems/web-server.zh.md)），问题只在 #9 的 RPC 与事件流形态。
- `host-cache.ts` 的按仓库作废、`repo-watcher.ts` 的结构判定、`git-exec.ts` 的 `isGitIdle` 门控：git 语义业务逻辑，无 DSH 对应。
- `pruneWorkspaces` 的 30 天 / 200 条淘汰：业务策略，storage domain 不提供淘汰。
- `native-open.ts`、`terminal-run.ts`、`file-diff.tsx` 的 `useCodeHighlighter`：已在用宿主能力。

## 五、已完成（本轮已落地，从表中移除）

| # | 项 | 落地内容 |
|---|---|---|
| 1 | storage domain | `state-store.ts` 改为 `ctx.storageDomain.open(defineDomain(...))`，zod 校验全局槽；v1 / v2 / v3 旧文件统一在域为空时导入一次，旧文件不改不删；域未就位时有界重试，最终回退旧文件 |
| 2 | 原子写 | 回退路径保留同步 tmp + rename；`writeFileAtomic` 试过后移除——异步 API 让同进程读回旧文件落后一轮事件循环 |
| 3 | home-paths | 新增 `source-control/dsh-home.ts`，`DSH_SOURCE_CONTROL_HOME` → `resolveDshHome()`；状态文档、日志根、旧会话解析三处收敛到它 |
| 19 | writeClipboard | 删除 `copyText` 及其 `execCommand` 回退，6 处调用点改用 primitives 的 `writeClipboard` |
| 28 | md5 声明 | 删除 `client/shared/md5.d.ts` 与 `blueimp-md5` devDependency |
