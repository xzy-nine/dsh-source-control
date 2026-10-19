# AGENTS.md

本文件给在此仓库工作的 agent 使用：约定、代码结构、构建与验证方式。功能说明见 `doc/功能说明.md`，
本文件不重复。

## 工作约定

- **注释、文档与提交信息只写说明性描述，不写解释性描述**：说明「是什么、怎么用、约束是什么」，
  不叙述改动过程、不解释「为什么当初这么做」、不保留评审历史。
- **回复与面向用户的文本用中文**；代码、命令、路径、标识符与逐字引用的外部文本保持原样。
- **文档分层**：[README.md](README.md) / [README.en.md](README.en.md) 只概述插件的整体能力与几个特色功能，
  不列细节；每一项功能的完整行为写在 `doc/功能说明.md`（仅中文）；代码结构、构建、测试等实现内容写在本文件。
  `doc/` 下的迁移差异与实现计划、数据层方案为本地文档，由 `.git/info/exclude` 排除，不提交。
- **测试不测界面文案**：断言代码标识符、结构或行为，不断言菜单项文字、按钮文字等展示字符串。
- **不写一次性改动的一次性测试**：局部、机械、只影响单个界面的改动不补测试。
- **能复用 DSH 已导出的能力就直接用，不自行重造**。
- **复制第三方代码时先用命令复制再改**，不得凭记忆重写；同时标明来源与许可。
- 沙箱报错时先提权重试一次（仅在沙箱状态下）。

## 代码图谱检索

本仓库已建立 CodeGraph 索引（`.codegraph/`，父目录 `E:\GitHubCode\02DSH` 亦有）。**改动前先加载
`codegraph-usage` skill，再用 `codegraph_explore` MCP 检索**，不要用 `grep` / `rg` / 逐个 `Read` 重建
结构：一次调用即可返回逐行源码、调用路径与影响面（blast radius）。索引默认项目即为本插件目录，
`projectPath` 传本目录或其子目录均可。

源码正文实时读盘、始终最新；但符号行号与调用关系来自索引数据库，改完代码后查关系需先
`codegraph sync`。

## 文件夹组织

```
src/index.ts        宿主入口：注册 web 路由与 AI 依赖，注册后按已持久化的工作区根预扫仓库树
src/source-control/ 宿主侧：git 命令路由、执行层、纯解析层、查询层、操作层、差异收集、仓库发现
                    （repo-discovery.ts：逐层并行扫描、60 秒 TTL 发现缓存、启动预扫）、
                    仓库结构监视（repo-watcher.ts：两层——按 git 公共目录去重监视 worktrees / modules
                    与 .gitmodules；按工作区根递归监视仓库集合的增删。变化后作废发现缓存并经事件流推
                    repository-tree）、子模块声明解析
                    （submodule-parse.ts，发现层与监视共用）、git 钩子探测
                    （hooks.ts：按 core.hooksPath 或公共目录的 hooks 判定 pre-commit / pre-push，
                    纯文件系统判定）、插件状态
                    持久化（state-store.ts，落 $DSH_HOME/dsh-source-control/，
                    listRepoLocationsWorkspaces 列出已持久化的工作区根）
src/client/         客户端侧：只有 index.ts（侧栏页入口）平铺，其余按职责分目录
  src/client/api/   宿主 API 客户端：传输层与按命令域拆分的命令封装，index.ts 汇总导出；
                    stream.ts 是流式响应的增量解码（事件流与流式提交信息共用）；
                    state.ts 是状态读写与旧数据迁移入口
  src/client/panel/ 面板：index.ts 主体、三个分区组件、变更树、引用计算、忙碌分级、设置面板、
                    仓库树（repo-preload.ts 按主视图当前会话的工作区后台取数并发布快照、use-repos.ts 订阅快照
                    并维护选中与展开；repo-tree.ts 树结构与选中、
                    enrich-claims.ts 补齐占用登记、enrich-run.ts 一批补齐的结局处理）、
                    refresh-scheduler.ts 是两处事件驱动刷新共用的冷却与挂起调度、
                    语言判定、各目标右键菜单与 hooks；menu-actions.json 是右键操作元数据与菜单名称的
                    数据源，menu-actions.ts 补缺省并给出类型；变更区三个目标（文件夹行 / 文件行 /
                    分组标题）的菜单共用 change-menu.ts 的注册表，元数据在 change-menu-actions.json
  src/client/graph/ 泳道图：index.ts 组件、lanes.ts 布局纯计算、cache.ts 提交图窗口缓存
  src/client/diff/  差异页：file-diff.tsx 视图（复制自 DSH）、resource-path.ts 地址换算、
                    better-sidebar-diff.ts 接入层
  src/client/git/   仓库本地操作：remote-url.ts 地址解析、clone-command.ts 克隆命令、
                    terminal-run.ts 终端执行
  src/client/ui/    通用界面件：dropdown.ts、dialog.ts、context-menu.ts、plugin-icon.ts、ref-icons.ts
  src/client/shared/ 共享契约与声明：types.ts、assets.d.ts、md5.d.ts
  src/client/css/   样式：按组件拆分的 CSS 模块（graph / changes / sections / settings 等）、
                    shared.module.css（跨组件共享类）、file-diff.module.css（复制的差异视图）、
                    cx.ts（类名拼接）、state-classes.ts（JS 动态切换的全局状态类名）
test/               单元测试（`node --test test/*.test.mjs`）
doc/                中文文档：功能说明随仓库提交；迁移差异与实现计划、数据层方案为本地文档，不提交
scripts/            客户端打包脚本（build-client.mjs）与耗时度量（bench-first-paint.mjs 首屏 /
                    bench-refresh.mjs 刷新 / bench-discovery.mjs 仓库发现 / bench-enrich.mjs 补齐 /
                    bench-layout.mjs 泳道布局 / bench-verify.mjs 命令往返；均需先 build:host）
assets/icons/       引用标记用的 SVG
```

文案与操作元数据以 JSON 为唯一数据源，由薄层直接读入（`import … with { type: 'json' }`，两端构建都原生
支持；宿主 tsc 会把 JSON 一并产出到 `lib/`）：

| 数据源 | 薄层 | 内容 |
|---|---|---|
| `panel/menu-actions.json` | `panel/menu-actions.ts` | 图形区右键操作的 id、引用类型、菜单名称 |
| `panel/change-menu-actions.json` | `panel/change-menu-actions.ts` | 变更区右键操作的 id、适用目标、分组、菜单名称 |
| `source-control/ai-commit-prompts.json` | `source-control/ai-commit-prompts.ts` | AI 提交提示词 |

两份菜单都按「JSON 给元数据与名称 + 代码按 id 绑处理函数」组织：新增操作 = JSON 加一条 + 在对应注册表
里补一个同 id 的处理函数。变更区三个目标（文件夹行 / 文件行 / 分组标题）共用 `panel/change-menu.ts` 的
注册表，操作声明适用的 `targets`，因此不会再出现「某个目标漏了某项操作」。
JSON 在 TS 里是宽类型（字符串推成 `string`、缺键不报错），因此形状、占位符与各目标的必备操作由
`test/data-sources.test.mjs` 校验。

宿主侧数据层分四块：`working-tree.ts` 是 git 执行层（`runGit` / `gitOrThrow`）与工作区变更，
其 `parseStatusSnapshot` 解析 `status --porcelain=v2 --branch`（条目与分支上游来自同一次调用，
v2 的 `.` 空列按空列输出）；`git-parse.ts` 是纯解析层，输入 git 原始输出、输出数据结构，
无 git 调用，可被测试直接导入，分支同步解析见其 `BRANCH_SYNC_FORMAT` 与 `parseBranchSync`；
`git-query.ts` 是只读查询层（`getWorkingTreeSnapshot` 是快照命令的实现）；
`git-actions.ts` 是操作层，两者都返回 `ErrorInfo`（成功 `null`）。
`runGit` **不设超时**：等待由 git 自身承担（远端不可达、凭据缺失它自己会结束），提交与推送还要
串行跑仓库自己的钩子（如 Gradle 的 `ktlintFormat`），其耗时不由插件限制。执行层只登记在跑的子进程，
用于宿主退出与终止信号时按进程树清理（`killRunningGit`）。非只读命令结束时按 `onRepositoryWrite`
通知一次（判据是命令跑完，不看退出码：冲突合并、拣选冲突与变基停下都以非零退出但已改动仓库），
宿主据此清空快照、提交图与仓库信息缓存、作废发现缓存并广播 `repository-write`。
`commitStaged` 的提交信息为空串时用 `git commit --no-edit`，沿用 git 生成的合并信息（`MERGE_MSG`），
用于结束索引与 HEAD 无差异的待合并状态。
`ignore.ts` 写入忽略规则（最近的 `.gitignore` 与本地排除文件），规则写法与去重是纯函数，放在
`ignore-rules.ts`；本地排除文件在 `.git` 目录内，客户端以宿主返回的绝对路径按普通文件打开。
克隆不由插件执行：客户端构造 `git -C <父目录> clone` 命令（`git/clone-command.ts`，纯函数），由
`git/terminal-run.ts` 打开 DSH 终端页并在其中执行。浅克隆的 `--depth` / `--single-branch` /
`--no-tags` 由 `shallowCloneArgs` 生成，深度按正整数处理、超上限收拢。

git 钩子由 `hooks.ts` 探测（纯文件系统，不调 git）：配置了 `core.hooksPath` 时用它（相对路径按仓库根
解析），否则用 **git 公共目录**下的 `hooks`，因此链接工作树与子模块共用主仓库的钩子目录。存在可执行的
`pre-commit` / `prepare-commit-msg` / `commit-msg` 即视为提交钩子激活，`pre-push` 视为推送钩子激活；
Windows 无执行位概念，文件存在即算可执行。客户端 `index.ts` 在换仓库时探测一次，取消勾选即给
`commitStaged` / `pushUpstream` / `pushBranch` 传 `skipHooks`（宿主追加 `--no-verify`）。勾选状态**不持久化**：
提交与推送完成后、以及切换仓库时都回到勾选。
数据形状集中在 `git-types.ts`，其字段名即前端契约。多记录命令一律用 `-z` 取 NUL 分隔输出，
记录内字段用 `%x00` 分隔；**`for-each-ref` 的转义是 `%00`**，写成 `%x00` 不会被展开，
分支同步的格式串 `BRANCH_SYNC_FORMAT` 同样用 `%00`。
`git diff-tree -z` 的输出以提交对象名开头，解析时须跳过（`skipLeadingObjectName`）。

`gh-cli.ts` 是 GitHub 集成层：同样以数组参数直接 spawn `gh`（不经 shell），并设
`GH_PROMPT_DISABLED=1` 避免子进程等待交互输入。`classifyGhFailure` 把 `gh` 输出归类为
missing-cli / not-logged-in / missing-scope / forbidden / not-found / invalid / unknown，
前端据此降级（隐藏入口或提示补授权）。GitHub 对无权访问的资源回 404，因此建仓库场景的
404 归入无权限。

`diff/better-sidebar-diff.ts` 是 dsh-better-sidebar 差异页的接入层（可选依赖）：`resolveBetterSidebarDiff`
要求服务已装载、`diff` 类型已注册且未被设置页关闭（该插件的 `openTab` 对未注册或已关闭的类型是静默
no-op，无法事后察觉，因此只能事前探测）；`toSidebarDiffRef` 把本插件的差异描述换算成它的两种引用
（工作区单文件 / 整提交补丁），两提交区间对比没有等价引用而返回 null；换算失败或未安装即回退到本插件
自己的差异页。探测发生在每次打开差异的时刻，服务经传给面板的取值函数读取 `ctx.get('betterSidebar')`：
该插件的客户端半边可能晚于本插件激活，且启用开关要等设置 RPC 返回，提前缓存会把「暂不可用」记成可用。
服务不写进 `dsh.client.inject`——缺它只让差异页回退，不会把插件拖成 pending。

普通文件打开不经过该模块：一律 `tabActions.openResource(dsh-resource://file/…)` 交宿主按注册表认领。
better-sidebar 的 `editor` 以 `extension` 档注册 `dsh-resource://file/**`，压过宿主 `text` 预览的
`fallback` 档，因此装了它就用它的编辑器；未安装或该类型被关闭时该注册不存在，排名自然落到宿主预览。
回退由宿主的认领排名承担，插件不自行判断。该编辑器对宿主自带渲染器的格式（表格 / PDF / 图片 /
Office）主动不认领，那些仍走宿主预览。

分层：`src/client/panel/index.ts` 持有状态，分区组件只接收已算好的数据与回调；纯计算抽成无 React 依赖的模块
以便直接单测。客户端不得反向依赖 `index.ts`（会成环），共享的图标等放在独立模块。

## 刷新与触发

自动刷新以事件驱动为主，另有低频兜底轮询：

| 机制 | 触发源 | 周期/延迟 | 开关 |
|---|---|---|---|
| 自动刷新（事件） | 当前会话事件窗口里已落地的写入/编辑，且目标在所选仓库内 | 5s 冷却 | `autoRefresh`（默认开） |
| 自动刷新（宿主事件） | 宿主事件流里的仓库写操作，且目标与所选仓库同一 | 5s 冷却 | `autoRefresh`（默认开） |
| 自动刷新（兜底） | 定时轮询工作区签名 | 可见 10s / 不可见 120s，快档一次、慢档连续两次同一签名才重载 | 跟随 `autoRefresh` |
| 自动抓取 | 定时循环 | `autoFetchPeriod` 秒（默认 180） | `autoFetch`（默认开） |
| 缓存清理 | 定时循环 | 300s | 无 |

兜底轮询覆盖事件窗口之外的外部写入（编辑器、终端、其它进程），页签可见时按 10s 的快档跑，
不可见时退回 120s 的慢档；页签不可见、上一次未结束、面板正忙时跳过。

宿主事件流（`GET /dsh-source-control/gg/events`，`text/event-stream`）补上事件窗口之外的另一半：
执行层在每次非只读写命令结束后推一条 `repository-write`（只带仓库路径，判据是命令跑完，
含以非零退出但已改动仓库的冲突合并、拣选冲突与变基停下），因此别的会话、别的
工作区与外部进程造成的改动也能即时反映。客户端 `api/repo-events.ts` 解析帧、按退避重连，
`use-repository-write-events.ts` 按仓库路径过滤后重载。

同一通道还推 `repository-tree`：`repo-watcher.ts` 分两层监视。**仓库级**看各仓库 git 公共目录的
`worktrees` 与 `modules` 两个名字、仓库根的 `.gitmodules`、以及各已声明子模块目录的出现，监视按
git 公共目录去重，主工作树、链接工作树与子模块共用一套句柄，事件合并窗口 250ms。**工作区级**递归
监视工作区根，只判定「仓库集合是否可能已变」：新建的仓库与工作树此前没有句柄，只能由这一层发现；
事件合并窗口 400ms，判定见下。工作树与子模块的增删不一定经过执行层（宿主自己的工作树工具、外部
命令、编辑器都会改），写事件覆盖不到，因此需要这两层。结构事件到达时宿主先作废发现缓存再广播，
客户端按工作区根过滤后调用 `refreshTree()`（不清空已显示的树）。

工作区级判定是纯函数 `isRepositorySetChange`，三类信号：名字里有 `.git` 段时取其所属仓库根，根
未知才算变化（已知仓库内部的 `.git` 写操作由仓库级监视负责，否则会形成「事件 → 重新发现 → 读
`.git` → 事件」的死循环）；名字是普通路径且事件为 `rename` 时，该路径自身或下探两层内出现或消失
了仓库，或该路径是已知仓库及其祖先；名字缺失时核对已知仓库是否仍存在 —— Windows 的递归句柄删除
目录树时只报不带名字的 `change`，这是仓库被整个删除的唯一信号。

仓库级监视的目标**不含** `.git` 与 `worktrees`/`modules` 目录自身，原因见下表。名字缺失的仓库级
事件不直接当作结构变化：Windows 上普通 `git status` 也会在公共目录产生一条，直接重扫会让面板反复
刷新。此时按 `structureState` 读一次结构状态（各监视目标下被监视名字的存在形态）并与上次比对，未变
即忽略；首次比对因没有基线而按变化处理。

两处**不得**纳入监视目标：

- `worktrees` 与 `modules` 目录自身：Windows 上句柄在目录被删除后持续报错，且一次工作树操作触发数万次事件。
- 仓库根的 `.git`：`.git` 内部每次写操作都会以 `.git` 名字冒泡到父目录，一轮 `status` / `add` /
  `commit` 实测数十次。监视它会形成「事件 → 重取 → git → 事件」的死循环，表现为页面反复刷新。
  结构变化已由公共目录上的 `worktrees` / `modules` 名字事件覆盖，`.gitmodules` 在普通 git 操作中
  不产生事件。

结构事件的重取走 `repo-preload.ts` 的 `refreshWorkspace`（保留 `baseNodes`，只作废补齐记录，受 30 秒
冷却与在途复用约束），不走 `dropWorkspace`：后者会发布空树，连续事件会让仓库区反复闪回占位。

一次重载向宿主发两次请求，两路并行：`loadCommits`（提交图窗口；仅首次进入时同时带回仓库信息、引用集合
与贮藏）与 `loadWorkingTreeSnapshot`（工作区条目 + 分支 / 上游 / 领先落后）。宿主侧一次提交图请求内部
也是并行的：仓库信息、引用集合、贮藏、工作树分支与提交日志互不依赖，同批发出；引用集合透传给提交图，
不重复读；首屏下引用集合与分支列表由**同一次** `for-each-ref` 产出（`REF_BRANCH_FORMAT` 与
`parseRefsAndBranches`，同时取 `%(HEAD)`、`%(refname:short)`、`%(symref)` 与引用字段），因此不为此多起
子进程。客户端按「仓库 + 取数参数」缓存最近 32 段提交窗口（`graph/cache.ts`），
只在**同一仓库**的相邻刷新之间复用：写操作后的对账命中同一段时不再取数，翻页回看已取过的窗口同样命中；
用户主动刷新、切换仓库、任何写操作以及兜底轮询判定需要重载时，都由 `dropGraphWindows` 作废该仓库的窗口。

## 刷新耗时

一次 git 子进程的固定开销约 80ms，因此刷新路径的耗时几乎只由「起了几个 git 子进程」决定。五处对策：

| 对策 | 说明 |
|---|---|
| 图形区不等工作区 | `getCommits` 不读 `git status`：未提交伪提交行需要工作区条目数，宿主为它读一次工作区会让提交图的返回时刻取决于工作区读取（`git status` 是两者中最慢的一条），文件越多越慢。该行改由客户端按**同一轮**的工作区快照补出（`commit-diff.ts` 的 `withUncommittedCount`），`assembleCommits` 因此不接收未提交变更数 |
| 引用只枚举一次 | 引用集合与分支列表读的是同一批引用：首屏由一次 `for-each-ref` 同时产出（`REF_BRANCH_FORMAT` 与 `parseRefsAndBranches`，`getRefsAndBranches`）；`HEAD` 由 `HEAD` 文件解析（`worktree-branches.ts` 的 `readHeadRef`），不起 `git rev-parse` |
| 仓库信息只取一次 | `loadCommits` 的仓库信息批由入参 `withRepoInfo` 显式控制（默认 false），与「是否首屏」解耦；`use-graph-data.ts` 只在某仓库首次取数时传 true，之后复用已知的 remotes/stashes/branch（模块级 `knownRepoInfo`，按仓库归一化键，写操作与换仓库时作废） |
| 纯工作区操作不重取提交图 | `panel/index.ts` 的 `run` 第五个参数 `historyChanged`（缺省 true = 全量对账）；暂存 / 取消暂存 / 丢弃 / 忽略规则标 false，改走 `refreshEntries()`，只取工作区快照且不作废窗口缓存 |
| 数据未变不重渲染 | `panel/commit-diff.ts` 的 `commitsEqual` / `commitsListEqual` / `remotesListEqual` / `entriesEqual`；`reconcile` 路径下数据未变时保持数组引用不变，图形区的泳道布局与更改区的树计算因此不重算（`full` 不短路，主动刷新必须真正重建） |

未提交伪提交行的父提交必须已在提交列表中：提交列表与工作区快照可能读自不同时刻，HEAD 已被别的进程
移动时该行会指向一个不在列表里的哈希，泳道图在该处断线。判据是 `commit-diff.ts` 的
`uncommittedParentOf`，`refresh` 与 `refreshEntries` 两处补出该行时共用它。

`refreshEntries()` 只中止**上一次快照**请求（独立的 `entriesControllerRef`），不触碰在途的提交图请求：
`phase` 只由 `refresh` 写入，作废在途的提交图会让图形区永久停在 loading。它按条目数就地修正未提交伪
提交行（`withUncommittedCount`，含条目数由零变正时补出该行），文案与客户端同格式。

度量：`scripts/bench-refresh.mjs`（刷新路径，含 `withRepoInfo` 两种模式对照）、`bench-first-paint.mjs`
（首屏）、`bench-layout.mjs`（泳道布局纯计算）、`bench-discovery.mjs`、`bench-enrich.mjs`、
`bench-verify.mjs`。`runGit` 对只读命令有 200ms 结果缓存，采样间隔须大于该 TTL，否则读数偏小且不可复现。

仓库树的取数不在面板重载的两路请求里：客户端插件激活后按**主视图当前会话**的工作区后台预加载
（`panel/repo-preload.ts` 的 `activeWorkspaceOf`，判据是会话行的 `retainedBy.mainView`），只取这一个
工作区，不遍历会话列表里的其它工作区。一个工作区依次做浅层发现、位置纠正、补齐工作树与子模块、
读取领先/落后，每步完成即发布快照；`use-repos.ts` 只订阅快照并维护选中与展开。各步都一次下发全部仓库，
不按批切分、不设并发上限。领先/落后由 `loadReposSync` 一次取回，宿主对每个仓库调一次
`git for-each-ref --format=… refs/heads`（`BRANCH_SYNC_FORMAT` 与 `parseBranchSync`，`%(HEAD)` 标出
当前分支）；无提交的仓库回退一次 `symbolic-ref --short -q HEAD`，此时只给出分支名、上游为空、
领先/落后为 0。单个仓库失败以空值兜底，`path` 原样回显入参。仓库发现逐层并行，结果进 60 秒 TTL
的内存缓存（容量 16，超出按插入序淘汰），任何仓库写命令结束后作废该缓存；宿主 `apply()` 注册路由
后按已持久化的工作区根启动一次预扫（`primeCachedWorkspaces`），只走按已知仓库位置取树的快路径，
失败静默。

## 首屏空白

一次 git 子进程的固定开销约 80ms（本机实测），因此首屏关键路径上的 git 调用数是空白时间的主因。

三处各自的最短路径：

| 区域 | 关键路径 | 空白来源 |
|---|---|---|
| 仓库列表 | `discoverWorkspace(root, { shallow: true })`：宿主按持久化位置取树，每仓库一次 `stat` + 读 `HEAD`，不起 git | 无位置缓存时退回完整扫描（8 仓库约 260ms） |
| 更改区 | `loadWorkingTreeSnapshot`：一次 `git status --porcelain=v2 --branch -z -uall` | 单次 status 约 90ms |
| 图形区 | `loadCommits` 首屏：仓库信息 / 引用集合 / 贮藏 / 工作树分支同批并行，再与 `git log` 并行 | 最慢一路约 110ms |

仓库列表先出**浅层树**（顶层仓库节点，`children` 全空），工作树与子模块随后补齐：预加载在
`repo-preload.ts` 里按仓库路径把补齐结果存进 `childrenByPath`，`repo-tree.ts` 的 `attachChildren`
负责挂回。判据是「有没有补齐记录」而不是「当前有没有 children」，`rescan()` 丢弃整个预加载状态，
因此重扫能反映工作树的增删。浅层树里没有工作树与子模块节点，持久化选中的若正是这类节点，
`planSelection` 把它记为待认领、补齐后由 `claimPendingSelection` 认领回原节点；用户手动选中即作废
待认领项。

补齐的占用登记与结局处理是两个纯模块：`enrich-claims.ts` 的 `createEnrichClaims()` 记在途与已完成，
`enrich-run.ts` 的 `runEnrichBatch()` 按结局决定保留还是释放占用。取消、空结果与失败都必须释放，
否则该路径此后既不下发、也不在已完成集合里，工作树永久不出现。空结果与失败还会驱动重试，但按路径
累计连续失败次数（`ENRICH_FAILURE_LIMIT`，默认 5）——到上限即按「没有工作树与子模块」处理，不再
重试，避免宿主判据与发现层不一致时形成无休止请求；成功一次即清零计数，`rescan()` 的 `clear()` 亦然。

`enrichRepositories` 对「无链接工作树且无 `.gitmodules`」的仓库零 git 调用（`linkedWorktreePresence`
+ `.gitmodules` 存在性判定，且要求 `.git` 为目录），有来源时才枚举。仓库判据与发现层对齐：`.git` 为
目录或文件都算仓库（`hasGitEntry`），`headOf` 经 `worktree-branches.ts` 的 `gitDirAt` 定位 `HEAD`，因此链接工作树与子模块也能
解析出分支。`branchesOfOtherWorktrees` 先做无链接工作树判定，为空时直接返回空集。`getStashes` 先看
`<commondir>/logs/refs/stash` 是否存在，不存在时不调用 git。`getRepoInfo` 的远程名由 config 派生
（`remote.<name>.<任意子键>`），集合为空才回退 `git remote`。

`scripts/bench-first-paint.mjs`、`bench-discovery.mjs`、`bench-enrich.mjs`、`bench-verify.mjs` 度量这
几处；`runGit` 对只读命令有 200ms 结果缓存，采样间隔须大于该 TTL，否则读数偏小且不可复现。

`change-events.ts` 是判据的纯函数层（无导入，可直接单测）：`settledFileChanges` 把事件折成「拿到结果
且结果非错误」的写入/编辑，`repositoryRelativePath` 判定模型给出的路径是否真在仓库内。事件窗口是
客户端会话事件源，因此 `run_code` 里的嵌套调用按 `tool/ptc-dispatch-start` + `tool/ptc-dispatch`
一并覆盖。

`use-file-change-refresh.ts` 订阅事件源：窗口没聚焦、面板正忙时挂起，连续变更按冷却节流。
`use-auto-fetch.ts` 是唯一的定时网络操作，按「聚焦 + 空闲」门控。`use-cache-cleanup.ts` 丢弃过期的
悬停统计与完整提交信息缓存。以上 hook 与 `use-graph-data.ts` 的兜底轮询都从该 hook 暴露的
`busyRef` 读进行中的操作记录，只有**目标仓库**在忙时才挂起。

## 忙碌状态

进行中的操作按「仓库路径 + 影响面」记录在面板状态里（形状见 `types.ts` 的 `BusyEntry`，判据在
`panel/busy.ts`，可直接单测）。影响面四档，互不阻塞：

| 影响面 | 覆盖 | 禁用的控件 |
|---|---|---|
| `read` | 只读或只导出、不改动仓库的操作：提交图、工作区、差异内容、归档导出 | 目标仓库的刷新入口 |
| `commit` | 暂存、取消暂存、丢弃、忽略规则、贮藏、提交 | 更改区与提交框 |
| `history` | 检出、合并、变基、重置、拣选、分支/标签/远程配置 | 图形区与仓库行的操作 |
| `network` | 抓取、推送、拉取、发布、创建 Pull Request、gh 查询 | 目标仓库的抓取/推送/发布/同步 |

同一仓库的同类操作可并存多份记录，逐个移除；仓库行右键菜单按该行仓库判定，别的仓库在忙不影响它。
打开文件、打开设置这类只读入口不因任何影响面禁用。宿主侧不串行化命令：每条请求独立执行，面板的
阻塞只来自上述控件禁用。

## 状态持久化的分级

分三级，判据只有一条：该状态是否值得跨会话保留。**持久化一律落宿主**，浏览器端只承担会话级 —— 
换浏览器、换标签页、清缓存都不会丢；窗口级只活在本次挂载里，会话级关标签页即清。

| 级别 | 载体 | 存活范围 | 适用 |
|---|---|---|---|
| 窗口级 | 组件 `useState` / `useRef` | 本次挂载 | 瞬时交互与派生数据：分组折叠集合、过滤弹窗的选中与搜索、`amend`、`runHooks`（本次提交与推送是否运行 git 钩子，不持久化，提交/推送完成与换仓库时复位）、`maxCommits`、分页与请求中标志 |
| 会话级 | 浏览器 `sessionStorage`（客户端经 `panel/storage.ts` 的 `loadSessionValue` / `saveSessionValue` 读写） | 本次会话，关标签页即清 | 与具体仓库绑定、重填成本高的输入：提交信息草稿（键 `ggg-commit-msg:<仓库根绝对路径>`） |
| 持久化 | `$DSH_HOME/dsh-source-control/state.json`（宿主侧 `source-control/state-store.ts`，客户端经 `panel/storage.ts` 的内存镜像读写） | 跨浏览器、标签页与重启 | 用户偏好与布局（设置项、分区高度与展开态、仓库树展开与选中）、引用筛选、工作区仓库位置缓存 |

客户端不直接读写 `localStorage` / `sessionStorage`：`panel/storage.ts` 是唯一出口，宿主侧在首屏预取一次到内存镜像，
读走镜像（同步，供 `useState` 初始化），写更新镜像并异步落盘。仓库位置缓存在 `state.json` 的 `repos` 
段按工作区路径分列，键值对在 `entries` 段。旧版本浏览器里的数据由 `api/state.ts` 的 `migrateLegacyState` 
在首次进入时搬一次并清掉旧键。

新状态先在此表定位：窗口级留组件状态；只值得活一次会话、且与具体仓库绑定的输入（如提交信息草稿）落会话级；
其余一律落宿主。不要用 `localStorage`。

## 构建

```bash
pnpm install
pnpm lint               # oxlint --type-aware src（规则集见 .oxlintrc.json）
pnpm lint:fix           # 同上，能自动修的（花括号、可选链）就地改
pnpm build              # build:host（tsc → lib/）+ build:client（esbuild → lib/client.js）
pnpm typecheck          # 宿主（tsconfig.json）与客户端（tsconfig.client.json）两段
pnpm check:duplication  # jscpd 扫描 src/，出现基线之外的重复即失败
pnpm test               # pretest 先跑完整 build 与重复门禁，再 node --test test/*.test.mjs
```

**重复代码门禁**：`scripts/check-duplication.mjs` 用 jscpd 扫 `src/`，与 `duplication-baseline.json`
里的指纹逐条比对；出现基线之外的克隆即以退出码 1 失败。指纹由「文件对 + 片段行数 + 片段内容摘要」
构成，不含行号，摘要按归一化行尾计算：无关改动与检出时的换行风格差异都不会让基线失效，同文件对、
同长度但片段内容被替换则算新的重复。比对按出现次数进行，当前次数超出基线次数才算新增（jscpd 会把
一处重复按相邻窗口合并成多条克隆）。基线只允许调低；确实无法消除的（如跨构建目标的类型镜像）才用
`node scripts/check-duplication.mjs --update` 调高，并在提交信息里说明理由。门禁已挂在 `pretest` 上，
`pnpm test` 必然经过它。

- 数据源是 JSON，两端都直接 import（`resolveJsonModule` 已开启，宿主侧按 `type: 'json'` 导入属性读写）。
  JSON 随 `tsc` 产出到 `lib/`，esbuild 把它内联进客户端包，运行时不额外请求。`lib/` 只含构建产物，
  `src/` 里不出现生成文件。
- 客户端外部化模块固定为 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/dsh-client-ui-primitives`；浏览器半边不得引入其他裸模块。
- `jsx: 'automatic'`（复制的 FileDiff 不显式导入 React）；`charset: 'utf8'`（保留中文字面量）。
- CSS 模块用 esbuild 的 `local-css` loader，**必须配 `outdir`**，否则报
  `Cannot import ... without an output path configured`。`local-css` 只产类名映射，样式文本需脚本单独
  收集并内联为 `<style id="dsh-source-control-module-style">`，`lib/` 下不留 CSS 文件。
- CSS 模块按组件拆分，**作用域前缀按文件生成**：同一条选择器里的多个类名必须定义在同一文件，
  否则两侧前缀不同、复合选择器失效。跨组件的共享类放 `css/shared.module.css`；由 JS 动态切换、
  且要加在不同模块元素上的状态类（`menuTarget`）在样式里写 `:global(...)`，名字集中在
  `css/state-classes.ts`，样式与组件共用同一份。
- `assets/icons/` 的 SVG 以文本内联，运行时不请求额外资源。
- `lib/` 是构建产物，不提交（`.gitignore`）；发布内容由 `package.json` 的 `files` 白名单决定。

## 静态检查与提交钩子

规则集是仓库根的 `.oxlintrc.json`，对齐 DSH 主仓的严格档：正确性、可维护性与类型感知规则全开
（`typescript/*` 的 type-aware 规则 + `eslint-plugin-sonarjs`）。**不启用 `@stylistic` 风格规则**：
本仓库用 Tab 缩进与分号，与主仓的 2 空格、无分号相反，照搬会产生上万条纯排版告警。

`oxlint --type-aware` 的类型信息由 `tsconfig.json` / `tsconfig.client.json` 提供，因此两处约束不可省：

- 宿主 `tsconfig.json` 必须保留 `"types": ["node"]`。缺它时 tsgolint 解析不到 Node 全局类型，
  会把 `process`、`setInterval` 判成 `error` 类型，凭空报出数百条 `no-unsafe-*`（`tsc` 因默认加载
  `@types/*` 而不报，两边结论因此不一致）。
- 客户端 `tsconfig.client.json` 是 `strict: false`（既有设计：大量界面代码走 JS 风格），
  `no-unsafe-*` 系列依赖严格类型信息，故 `.oxlintrc.json` 对 `src/client/**` 单独关闭这五条。

git 钩子由仓库内的 `.githooks/` 承载，`pnpm install` 的 `prepare` 阶段经
`scripts/install-hooks.mjs` 安装，克隆后无需额外步骤。安装只写未设置过的 `core.hooksPath`：
已配置成其它值时保留原值并提示，不覆盖（该值可能指向 husky 等工具的钩子目录）。
`core.hooksPath` 是相对路径，按各 worktree 根解析，因此主检出与所有 worktree 共用同一份脚本。

| 钩子 | 时机 | 检查内容 |
|---|---|---|
| `pre-commit` | 提交前 | 本次暂存的 `src/**/*.ts{,x}`（`ACMR`）跑 oxlint，反馈快；暂存内容与工作区副本不一致时拒绝提交 |
| `pre-push` | 推送前 | `src/` 全量 oxlint + 两段 `tsc --noEmit`，拦住跨文件类型问题 |

绕过（仅在确有必要时）：`git commit --no-verify` / `git push --no-verify`。

## 测试

**宿主侧测试一律从 `lib/` 产物导入**（经 `test/lib-import.mjs` 的 `importHostModule`）：宿主模块普遍带
内部 `.js` 相对导入，由 `src/` 直连 `.ts` 会报 `ERR_MODULE_NOT_FOUND`。因此 `pretest` 必须先把宿主产物
构建出来，缺产物即导入失败、测试报错——构建失败本身就是问题，不用 skip 掩盖。
**客户端测试仍从 `src/` 直连 `.ts`**：客户端没有逐模块产物，只有打包后的 `lib/client.js`（ModuleLoader
包络，仅暴露插件入口），无法取到内部纯函数。少数按外部环境跳过的用例（非 git 目录、ui-primitives
源码检出、jsdom 缺失）保留 skip，它们不依赖本仓库构建。

| 文件 | 覆盖 |
|---|---|
| `lanes.test.mjs` | 泳道布局：连线连续性、压实、节点半径、越界重叠、无贝塞尔 |
| `primitives.test.mjs` | ui-primitives 导入名存在性、面板结构、CSS 模块类名引用 |
| `diff-hunks.test.mjs` | 统一差异解析 |
| `git-parse.test.mjs` | 宿主纯解析层：NUL 记录切分、重命名、附注标签解引用、贮藏插入、伪提交 |
| `status-snapshot.test.mjs` | 工作区快照解析：v2 记录与空列、重命名、未合并、分支与上游、截断 |
| `branch-sync.test.mjs` | 分支同步：`BRANCH_SYNC_FORMAT` 形状、`parseBranchSync` 的各 track 文本与 upstream 为 null 的情形；ahead/behind 与 `rev-list` 独立推导对照 |
| `repo-discovery.test.mjs` | 仓库发现：节点排序 / depth / children / truncated、TTL 缓存与作废、`knownRepos` 快路径与回退、同层多目录、`loadReposSync` 去重与兜底、`loadReposSync` 命令经真实路由 handler |
| `snapshot.test.mjs` | 工作区快照命令契约：经真实路由 handler，并与 `loadWorkingTree` 逐条对照；冲突合并后不作废缓存即读到合并状态 |
| `optimistic.test.mjs` | 乐观更新：暂存 / 取消暂存 / 丢弃 / 提交的推算与重命名路径匹配、条目签名 |
| `graph-cache.test.mjs` | 提交图窗口缓存：容量淘汰、参数区分、路径归一、按仓库丢弃 |
| `draft-storage.test.mjs` | 会话级存储：读写往返、非法值与缺失回退、按仓库根的草稿键 |
| `refresh-verify.test.mjs` | 刷新契约：快照与 `loadWorkingTree` 逐条一致、提交集与 `git log` 独立推导一致、草稿不落宿主 |
| `api-client.test.mjs` | 宿主 API 客户端的错误处理：非 2xx 响应体里的错误文本优先于状态码；`discoverRepositories` 的 `shallow`/`fullScan` 透传与 `usedCache` 读取、`enrichRepositories` 空入参不发请求 |
| `repo-tree.test.mjs` | 存储库树：补齐结果按仓库路径挂回、浅层纠正后 children 不丢、重扫后 children 变空、持久化选中工作树的待认领与认领、展开链 |
| `repo-preload.test.mjs` | 仓库树预加载：只取主视图当前会话的工作区、四步取数顺序与逐阶段发布、在途去重与 `force`、失败置 error、`dropWorkspace` 后重取、补齐空结果重试到上限 |
| `enrich-claims.test.mjs` | 补齐占用与结局：在途/已完成登记、取消与失败释放、空结果与异常驱动重试、连续失败到上限后停止下发、成功清零计数；结局判定直接调用生产的 `runEnrichBatch` |
| `commit-diff.test.mjs` | 刷新短路判据：hash/parents/heads/tags/remotes/stash 各自变化判不等、工作区条目四字段与顺序、未提交伪提交行的改写/移除/补出 |
| `refresh-contract.test.mjs` | 刷新路径的图形区状态契约（需本机 jsdom，缺失时整体跳过）：提交图在途时触发只取快照的刷新仍收敛 ready、只取快照不改 phase、条目由零变正时补出未提交行 |
| `gh-cli.test.mjs` | `gh` 失败分类：未安装 / 未登录 / 缺 scope / 无权限 / 参数错误 |
| `change-tree.test.mjs` | 变更树：单链合并、分叉、折叠、排序 |
| `refs.test.mjs` | 引用筛选：可达集过滤、工作区伪提交与贮藏提交的保留、引用收集 |
| `worktree-branches.test.mjs` | 工作树登记：`core` 段解析、`gitdir` 还原工作树根、与 `git worktree list` 逐条对照、子模块与裸仓库的主工作树推导、登记项残留；占用分支判定；`HEAD` 文件解析；git 目录定位（链接工作树与子模块的 `.git` 文件、仓库子目录向上查找、裸仓库、非仓库） |
| `remote-url.test.mjs` | 远程地址解析与 HTTP(S) / SSH 双向换算、协议档位 |
| `ssh-status.test.mjs` | SSH 状态检测：版本行、私钥筛选、探测输出归类 |
| `github-remote.test.mjs` | GitHub 远端识别与提交页地址 |
| `git-messages.test.mjs` | git 失败文本的中文说明与原文回退 |
| `ignore-rules.test.mjs` | 忽略规则的路径规范化、规则写法、去重与追加、越界拒绝 |
| `clone-command.test.mjs` | 终端克隆命令的构造与终端执行（开页、等待可写、超时）；浅克隆参数 `shallowCloneArgs` 的深度归一与命令拼接位置 |
| `change-events.test.mjs` | 文件改动事件判据：落地判定、嵌套调用、仓库内判定、冷却与定时参数 |
| `repo-events.test.mjs` | 仓库变更事件流：`repository-write` 与 `repository-tree` 两类帧的解析与互不认领、分帧、重连退避、事件与当前仓库的匹配 |
| `repo-watcher.test.mjs` | 仓库结构监视判据：监视目标集合（公共目录 / 仓库根 `.gitmodules` / 子模块父目录）、不监视 `worktrees` 与 `modules` 自身、`.git` 事件被过滤；工作区级判定（已知与未知仓库的 `.git`、普通文件与目录、仓库目录消失、名字缺失、新建目录下探） |
| `repo-watcher-live.test.mjs` | 仓库结构监视实机契约：真实仓库上新建与移除链接工作树、新增 `.gitmodules` 都会报告该仓库；工作区里新建与删除仓库报告该工作区；普通 git 操作与普通文件改动都不产生结构事件 |
| `panel-busy.test.mjs` | 忙碌分级：按仓库与影响面记录、互不阻塞、逐份移除 |
| `submit-state.test.mjs` | 提交框判据：主按钮在合并中与修补期间固定为提交、同步与发布的切换条件、提交可用性、空信息在合并中不禁用提交 |
| `data-sources.test.mjs` | JSON 数据源形状：两份菜单的 id/标题/目标/占位符与各目标必备操作、提示词四段齐全 |
| `better-sidebar-diff.test.mjs` | better-sidebar 差异接入：能力探测、种子换算与回退判据 |
| `client-bundle.test.mjs` | 产物包络、外部模块请求、席位注册 |
| `api-commands.test.mjs` | 经真实路由 handler 的宿主命令集回归（从 `lib/` 产物导入）；含钩子探测（默认目录 / `core.hooksPath`）与 `skipHooks` 的 `--no-verify` 语义 |
| `connectivity.test.mjs` | 真实历史的泳道图无断线（非 git 仓库时跳过） |
| `ordering.test.mjs` | 三种提交排序 |

`api-commands.test.mjs` 与 `snapshot.test.mjs` 从 `lib/` 宿主产物导入，因此 `pretest` 跑完整 `build`。

`primitives.test.mjs` 断言「客户端从 ui-primitives 导入的每个名字都真实存在」：产品图标导出名带
`Regular` / `Medium` 权重后缀，写成裸名会得到 `undefined`，React 渲染时不报编译错误、只在运行时抛
「元素类型无效」并让整个侧栏页变空白。新增图标导入前先确认导出名。
