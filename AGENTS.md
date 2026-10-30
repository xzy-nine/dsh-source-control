# AGENTS.md

本文件给在此仓库工作的 agent 使用：约定、代码结构、构建与验证方式。功能说明见 `Docs/功能说明.md`，
本文件不重复。

## 工作约定

- **注释、文档与提交信息只写说明性描述，不写解释性描述**：说明「是什么、怎么用、约束是什么」，
  不叙述改动过程、不解释「为什么当初这么做」、不保留评审历史。
- **回复与面向用户的文本用中文**；代码、命令、路径、标识符与逐字引用的外部文本保持原样。
- **文档分层**：[README.md](README.md) / [README.en.md](README.en.md) 只概述插件的整体能力与几个特色功能，
  不列细节；每一项功能的完整行为写在 `Docs/功能说明.md`（仅中文）；代码结构、构建、测试等实现内容写在本文件。
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
                    （repo-discovery.ts：逐层并行扫描、60 秒 TTL 发现缓存、启动预扫；批量领先/
                    落后取数经 child-process.ts 的 createLimiter 限流）、仓库事实层
                    （repo-facts.ts：git 目录布局与打包引用的进程级缓存）、引用筛选取数
                    （git-query.ts 的 getRefSummaries / getBranchBase，对应路由命令 loadRefs /
                    loadBranchBase：弹窗用的全部引用与当前分支的分叉来源）、
                    仓库结构监视（repo-watcher.ts：两层——按 git 公共目录去重监视 worktrees / modules
                    与 .gitmodules；按工作区根递归监视仓库集合的增删。变化后作废发现缓存并经事件流推
                    repository-tree）、子模块声明解析
                    （submodule-parse.ts，发现层与监视共用；声明的路径按仓库根核对，越界的写法
                    一律拒绝）、git 钩子探测
                    （hooks.ts：按 core.hooksPath 或公共目录的 hooks 判定 pre-commit / pre-push，
                    纯文件系统判定）、插件状态
                    持久化（state-store.ts，落 $DSH_HOME/dsh-source-control/，
                    listRepoLocationsWorkspaces 列出已持久化的工作区根）、
                    文本日志（logger.ts 写入与清理、log-format.ts 的 logcat 格式、
                    log-retention.ts 的命名与淘汰判据）与反馈
                    （feedback.ts 提交、feedback-text.ts 正文拼装、
                    log-archive.ts 打包、log-redact.ts 脱敏）
src/client/         客户端侧：只有 index.ts（侧栏页入口）平铺，其余按职责分目录
  src/client/api/   宿主 API 客户端：传输层与按命令域拆分的命令封装，index.ts 汇总导出；
                    stream.ts 是流式响应的增量解码（事件流与流式提交信息共用）；
                    state.ts 是状态读写与旧数据迁移入口
  src/client/panel/ 面板：index.ts 主体、三个分区组件、变更树、引用计算、忙碌分级、设置面板
                    （feedback.ts 是其中的「反馈」页签）、
                    仓库树（repo-preload.ts 按主视图当前会话的工作区后台取数并发布快照、use-repos.ts 订阅快照
                    并维护选中与展开；repo-tree.ts 树结构与选中、
                    enrich-claims.ts 补齐占用登记、enrich-run.ts 一批补齐的结局处理）、
                    refresh-scheduler.ts 是两处事件驱动刷新共用的冷却与挂起调度、
                    语言判定、各目标右键菜单与 hooks；menu-actions.json 是右键操作元数据与菜单名称的
                    数据源，menu-actions.ts 补缺省并给出类型；变更区三个目标（文件夹行 / 文件行 /
                    分组标题）的菜单共用 change-menu.ts 的注册表，元数据在 change-menu-actions.json
  src/client/graph/ 泳道图：index.ts 组件、lanes.ts 布局纯计算、row-model.ts 行文本与引用标记、
                    window-range.ts 窗口区间、auto-load.ts 触底续取判据
  src/client/diff/  差异页：file-diff.tsx 视图（复制自 DSH）、resource-path.ts 地址换算
  src/client/git/   仓库本地操作：remote-url.ts 地址解析、clone-command.ts 克隆命令、
                    terminal-run.ts 终端执行
  src/client/ui/    通用界面件：dropdown.ts、dialog.ts、context-menu.ts、plugin-icon.ts、ref-icons.ts
  src/client/shared/ 共享契约与声明：types.ts、cache.ts（有界缓存与派生值缓存）、path-key.ts
                    （路径键归一化：仓库节点 id 与按仓库持久化的键共用）、version.ts 与
                    globals.d.ts（构建期注入的插件版本）、assets.d.ts、md5.d.ts
  src/client/css/   样式：按组件拆分的 CSS 模块（graph / changes / sections / settings 等）、
                    shared.module.css（跨组件共享类）、file-diff.module.css（复制的差异视图）、
                    cx.ts（类名拼接）、state-classes.ts（JS 动态切换的全局状态类名）
test/               单元测试（`node --test test/*.test.mjs`）
Docs/               中文文档：功能说明.md、功能缺口.md、实现计划与数据层方案
scripts/            客户端打包脚本（build-client.mjs）与耗时度量（bench-first-paint.mjs 首屏 /
                    bench-refresh.mjs 刷新 / bench-git-info.mjs 取数（子进程数、文件系统次数）/
                    bench-ui.mjs 显示到界面 / bench-discovery.mjs 仓库发现 / bench-enrich.mjs 补齐 /
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
`git-query.ts` 是只读查询层（`getWorkingTreeSnapshot` 是快照命令的实现，其合并判定读 git 目录下的
`MERGE_HEAD` 文件，不起子进程）；
`git-actions.ts` 是操作层，两者都返回 `ErrorInfo`（成功 `null`）。
`runGit` **不设超时**：等待由 git 自身承担（远端不可达、凭据缺失它自己会结束），提交与推送还要
串行跑仓库自己的钩子（如 Gradle 的 `ktlintFormat`），其耗时不由插件限制。执行层只登记在跑的子进程，
用于宿主退出与终止信号时按进程树清理（`killRunningGit`）。非只读命令结束时按 `onRepositoryWrite`
通知一次（判据是命令跑完，不看退出码：冲突合并、拣选冲突与变基停下都以非零退出但已改动仓库），
宿主据此清空快照、提交图与仓库信息缓存、作废发现缓存并广播 `repository-write`。
`runGit` 的只读结果缓存按毫秒计有效期，只对**输出不随工作区或索引当前内容变化**的子命令
（`log`、`show`、`for-each-ref`、`rev-list` 等）生效。`status`、`diff`、`ls-files` 的输出随工作区
与索引变化，而缓存失效只覆盖插件自己执行的写命令 —— 插件之外的写（编辑器、外部命令）无从感知，
子模块的内部改动更会改变**父仓库** `status` 的结果（父仓库把子模块的内部改动记成自身的一条条目），
因此这三类命令一律现读现用，不进结果缓存。
子进程环境由 `gitEnvironment(readOnly)` 生成：`LANGUAGE` / `LC_ALL` / `LANG` 固定为英文（失败归类与
部分解析依赖英文措辞，父进程已显式给出时保留用户取值）；`GIT_OPTIONAL_LOCKS=0` 只加在只读命令上，
写命令不设，否则索引可能不落盘。
`commitStaged` 的提交信息为空串时用 `git commit --no-edit`，沿用 git 生成的合并信息（`MERGE_MSG`），
用于结束索引与 HEAD 无差异的待合并状态。
`discardPaths` 区分子模块条目与普通路径：索引模式 `160000` 的条目（由 `git ls-files -s` 判定，
解析在 `git-parse.ts` 的 `parseIndexEntries`）不交给 `git restore`，而是显式把子模块 HEAD 移到索引
记录的提交（`checkout --detach`），**不还原也不清理子模块内部的未提交改动**；目录型 pathspec 命中
的子模块同样按此处置。未初始化、移动被拒绝与内部仍有改动这三种情形随返回值回报，客户端据此提示并
保留条目。未跟踪路径用 `git clean -f`（不加 `-ff`/`-d`），清理后仍存在的独立仓库按未删除回报。
`ignore.ts` 写入忽略规则（最近的 `.gitignore` 与本地排除文件），规则写法与去重是纯函数，放在
`ignore-rules.ts`；本地排除文件在 `.git` 目录内，客户端以宿主返回的绝对路径按普通文件打开。
克隆不由插件执行：客户端构造 `git -C <父目录> clone` 命令（`git/clone-command.ts`，纯函数），由
`git/terminal-run.ts` 打开 DSH 终端页并在其中执行。浅克隆的 `--depth` / `--single-branch` /
`--no-tags` 由 `shallowCloneArgs` 生成，深度按正整数处理、超上限收拢。

git 钩子由 `hooks.ts` 探测（纯文件系统，不调 git）：配置了 `core.hooksPath` 时用它（相对路径按工作树根
解析：普通工作树按其工作树根，裸仓库按其 git 目录），否则用 **git 公共目录**下的 `hooks`，因此链接
工作树与子模块共用主仓库的钩子目录。存在可执行的
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

## 文本日志与反馈

日志模块三件：`log-format.ts` 只做格式（logcat threadtime：`MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message`，
含换行的消息逐行写出、续行沿用同一时间戳）；`log-retention.ts` 只做命名与淘汰判据（纯函数，可直接单测）；
`logger.ts` 负责落盘与清理。目录为 `<root>/<YYYY-MM-DD>/logcat-YYYYMMDD-HHmmssSSS-<pid>.log`，
root 与 `state-store.ts` 同序解析（`DSH_SOURCE_CONTROL_HOME` → `DSH_HOME` → `~/.dsh`）。
文件名含启动时刻，因此同一日文件夹内按文件名升序即启动先后。

写入策略：行先入缓冲，`FLUSH_DELAY_MS`（250ms）合并为一次追加写，缓冲到 512 行立即落盘，
`process.on('exit')` 同步收尾。定时器 `unref()`，不阻止进程退出；写盘失败静默，不影响插件功能。

清理：`initLog()` 调 `cleanLogs()` 各判一次。保留期按日文件夹名比字符串（`planExpiredDayFolders`，
当天算第一天，早于「今天 − 14 天」的整体删除）；体积按 `planDayEvictions` 从最新文件向前累计到
`DAY_FOLDER_LIMIT_BYTES`（15 MB），超出部分进入淘汰名单；**正在写入的那一份由 `keep` 排除**，
既不参与累计也不会被删。

反馈：`feedback.ts` 是提交编排（取日志 → 脱敏 → 打包 → `gh issue create --body-file` → 回投 issue 地址），
`feedback-text.ts` 拼正文（纯函数），`log-archive.ts` 用系统 `tar -a -cf` 打包（tar 不可用时退回未压缩副本），
`log-redact.ts` 脱敏（纯函数）。脱敏只在提交反馈时生效，磁盘上的原始日志保持原样；本地路径**不处理**，
只替换 URL 账号口令、令牌串与独立出现的系统用户名，占位符分别是 `<url-credential>` / `<token>` / `<user>`。
正文改走 `--body-file`：长描述与日志说明会让命令行参数超出系统上限。

日志不交给 `gh issue create --attach` 上传：该接口的 user-attachments 端点只接受图片与视频的
content type，文本与压缩包一律被 `content_type` 校验拒绝（实测 `.log`/`.txt`/`.zip`/`.pdf` 均失败）。
因此流程是「本地打包 → 建 issue → 打开 issue 提示用户把压缩包拖进评论框」。

差异一律由本插件自己的 git-diff 页渲染，不转发给其它侧栏插件。

普通文件打开一律 `tabActions.openResource(dsh-resource://file/…)` 交宿主按注册表认领，插件不指定渲染方。

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

后台刷新结束时按「工作区条目数 / 已加载提交数」的变化给一条信息类轻量提示（`toast.ts` 的 `info`
类别），只报变化量、不报总数。基线把取数范围（仓库、引用起点、提交窗口与影响提交行的设置项，
`use-graph-data.ts` 的 `graphScope`）与「两轮都已就绪」一并记入，范围不同或加载中的轮次只重建基线
不提示——否则换仓库、换筛选或加载更多会把两份不同批次的提交数误报成「提交图 ±全部提交数」。
对账与轮询补取按已加载条数请求窗口（`reconcileWindow`），后台刷新不会把触底加载过的分页收回去。
错误类提示显示期间到来的信息类提示直接丢弃：失败原因（如 git 钩子未通过）只有这一次，不能被后台
刷新的结果告知盖掉。停留时长按类别与文本长度推算（`HOLD_OF`：错误 8–20 秒，信息 3–8 秒）。

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
目录树时只报不带名字的 `change`，这是仓库被整个删除的唯一信号。已知仓库消失时即从集合中移除，
因此同一路径只触发一次变化。

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

结构事件的重取走 `repo-preload.ts` 的 `refreshWorkspace`（保留 `baseNodes`，只作废补齐记录；不受 30 秒
重取冷却约束，取数进行期间的连续请求合并为一次后续重取），不走 `dropWorkspace`：后者会发布空树，
连续事件会让仓库区反复闪回占位。

一次重载向宿主发两次请求，两路并行：`loadCommits`（提交图窗口；仅首次进入时同时带回仓库信息、引用集合
与贮藏）与 `loadWorkingTreeSnapshot`（工作区条目 + 分支 / 上游 / 领先落后）。宿主侧一次提交图请求内部
也是并行的：仓库信息、引用集合、贮藏、工作树分支与提交日志互不依赖，同批发出；引用集合透传给提交图，
不重复读；首屏下引用集合与分支列表由**同一次** `for-each-ref` 产出（`REF_BRANCH_FORMAT` 与
`parseRefsAndBranches`，同时取 `%(HEAD)`、`%(refname:short)`、`%(symref)` 与引用字段），因此不为此多起
子进程。提交图窗口缓存只在宿主（`source-control/host-cache.ts`），客户端不自建一份：键为「仓库 + HEAD +
全部取数参数」，命中即最近使用，按容量淘汰最久未用的一项，写操作与 `invalidateCache` 按仓库（含祖先与
后代）作废。客户端只保留渲染态（`lastPanelState` / `lastMaxCommits`）供重新挂载时首帧呈现。

## 刷新耗时

一次 git 子进程的固定开销约 80ms，因此刷新路径的耗时几乎只由「起了几个 git 子进程」决定。七处对策：

| 对策 | 说明 |
|---|---|
| 图形区不等工作区 | `getCommits` 不读 `git status`：未提交伪提交行需要工作区条目数，宿主为它读一次工作区会让提交图的返回时刻取决于工作区读取（`git status` 是两者中最慢的一条），文件越多越慢。该行改由客户端按**同一轮**的工作区快照补出（`commit-diff.ts` 的 `withUncommittedCount`），`assembleCommits` 因此不接收未提交变更数 |
| 引用只枚举一次 | 引用集合与分支列表读的是同一批引用：首屏由一次 `for-each-ref` 同时产出（`REF_BRANCH_FORMAT` 与 `parseRefsAndBranches`，`getRefsAndBranches`），提交图的引用标记不来自这次枚举（见下一行）；`HEAD` 由 `HEAD` 文件解析（`worktree-branches.ts` 的 `readHeadRef`），不起 `git rev-parse` |
| 引用标注并入日志 | `LOG_FORMAT` 末位是 `%D`、`getLog` 传 `--decorate=full`；`parseDecorations` 把装饰解析成 heads / tags / remotes，`refsFromDecorations` 组装成 `RefData` 交给 `assembleCommits`。刷新路径因此不再跑 `for-each-ref`（首屏的仓库信息批仍要一次，用于分支列表）。`CommitTag.annotated` 恒为 false —— 装饰无法区分附注标签，客户端只在 `commitsEqual` 里读它 |
| 仓库事实缓存 | `repo-facts.ts`：`repoLayout` 缓存 git 目录与公共目录（10s、容量 64，写命令按仓库含祖先与后代作废），`readPackedRef` 把 `packed-refs` 解成表（容量 8，按 `mtimeMs + size` 守卫）。`HEAD` 不缓存 —— 它是各缓存键的失效判据 |
| 仓库信息只取一次 | `loadCommits` 的仓库信息批由入参 `withRepoInfo` 显式控制（默认 false），与「是否首屏」解耦；`use-graph-data.ts` 只在某仓库首次取数时传 true，之后复用已知的 remotes/stashes/branch（模块级 `knownRepoInfo`，按仓库归一化键，写操作与换仓库时作废） |
| 纯工作区操作不重取提交图 | `panel/index.ts` 的 `run` 第五个参数 `historyChanged`（缺省 true = 全量对账）；暂存 / 取消暂存 / 丢弃 / 忽略规则标 false，改走 `refreshEntries()`，只取工作区快照且不作废窗口缓存 |
| 数据未变不重渲染 | `panel/commit-diff.ts` 的 `commitsEqual` / `commitsListEqual` / `remotesListEqual` / `entriesEqual`；`reconcile` 路径下数据未变时保持数组引用不变，图形区的泳道布局与更改区的树计算因此不重算（`full` 不短路，主动刷新必须真正重建） |

未提交伪提交行的父提交必须已在提交列表中：提交列表与工作区快照可能读自不同时刻，HEAD 已被别的进程
移动时该行会指向一个不在列表里的哈希，泳道图在该处断线。判据是 `commit-diff.ts` 的
`uncommittedParentOf`，`refresh` 与 `refreshEntries` 两处补出该行时共用它。

`refreshEntries()` 只中止**上一次快照**请求（独立的 `entriesControllerRef`），不触碰在途的提交图请求：
`phase` 只由 `refresh` 写入，作废在途的提交图会让图形区永久停在 loading。它按条目数就地修正未提交伪
提交行（`withUncommittedCount`，含条目数由零变正时补出该行），文案与客户端同格式。

度量：`scripts/bench-git-info.mjs`（取数：每场景的 ms / git 子进程数 / 文件系统次数 / 命令明细，
末段对照计划第 1 节的判定标准）、`bench-refresh.mjs`（刷新路径，含 `withRepoInfo` 两种模式对照）、
`bench-first-paint.mjs`（首屏）、`bench-ui.mjs`（显示到界面：变更树、提交合并复用率、行文本与标记的
冷态与命中态）、`bench-layout.mjs`（泳道布局纯计算）、`bench-discovery.mjs`、`bench-enrich.mjs`、
`bench-verify.mjs`。`runGit` 对只读命令有 200ms 结果缓存，采样间隔须大于该 TTL，否则读数偏小且不可复现。

仓库树的取数不在面板重载的两路请求里：客户端插件激活后按**主视图当前会话**的工作区后台预加载
（`panel/repo-preload.ts` 的 `activeWorkspaceOf`，判据是会话行的 `retainedBy.mainView`），只取这一个
工作区，不遍历会话列表里的其它工作区。一个工作区依次做浅层发现、位置纠正、补齐工作树与子模块、
读取领先/落后，每步完成即发布快照；`use-repos.ts` 只订阅快照并维护选中与展开。补齐按
`ENRICH_BATCH_SIZE`（8）分批下发，每批完成即发布一次快照；领先/落后由 `loadReposSync` 一次取回，宿主对每个仓库调一次
`git for-each-ref --format=… refs/heads`（`BRANCH_SYNC_FORMAT` 与 `parseBranchSync`，`%(HEAD)` 标出
当前分支）；无提交的仓库回退一次 `symbolic-ref --short -q HEAD`，此时只给出分支名、上游为空、
领先/落后为 0。单个仓库失败以空值兜底，`path` 原样回显入参。仓库发现逐层并行，结果进 60 秒 TTL
的内存缓存（容量 16，超出按插入序淘汰），仓库写命令结束后按仓库（含祖先与后代）作废受影响的条目
（`invalidateDiscoveryCacheFor`）；宿主 `apply()` 注册路由
后按已持久化的工作区根启动一次预扫（`primeCachedWorkspaces`），只走按已知仓库位置取树的快路径，
失败静默。

## 取数与缓存

「请求 → 数据到手」这一段按四层缓存，有效期与失效判据按各自数据的变化频率定：

| 层 | 落点 | 键 | 有效期 / 容量 | 作废 |
|---|---|---|---|---|
| 进程级事实 | `repo-facts.ts` 的 `layouts` / `packedRefs` | 规范化仓库路径（分隔符统一为 `/`）/ 规范化公共目录 | 布局 10s、容量 64；打包引用无 TTL，按 `mtimeMs + size` 守卫、容量 8 | 写命令结束按仓库（含祖先与后代）作废布局；打包引用由守卫自校验 |
| 子进程结果 | `working-tree.ts` 的 `resultCache` / `inFlightGit` | 仓库 + `JSON.stringify(args)` | 200ms / 64；在途条目收尾即删 | 写命令按仓库（含祖先与后代） |
| 宿主响应 | `host-cache.ts` 的 `graphs` / `repoInfos` / `snapshots` / `hooksPaths` | 仓库 + 取数参数（图窗口另含 HEAD 与贮藏 / 远程标识）/ 仓库 | 30s / 60s / 500ms / 60s，容量 64 / 32 / 32 / 32 | 任何写命令清空整表；`invalidateCache` 按仓库（含祖先与后代） |
| 客户端取数参数 | `use-graph-data.ts` 的 `knownRepoInfo` / `lastPanelState` / `lastMaxCommits` | 归一化仓库路径 | 模块级，容量 8 | 写操作与换仓库（`dropGraphWindows`） |

`runGit` 的在途复用只对**确认只读**的命令生效（`isReadOnly` 的形态清单）：`status`、`diff`、`ls-files`
的输出随工作区与索引当前内容变化，因此不进 200ms 结果缓存，但仍与在途调用共享同一个子进程 —— 客户端
中止后重发、刷新与只取快照并发时因此只跑一次 git。写命令一律独立执行，并发两次写命令仍起两个进程。
子进程环境按「只读形态 + 父进程的语言取值」缓存，父进程改语言即重建。

仓库树的批量领先/落后取数是唯一入队的取数：`repo-discovery.ts` 的 `loadReposSync` 走模块级
`createLimiter(SYNC_CONCURRENCY)`（`child-process.ts`，上限 5），一次下发全部路径时同时在跑的 git
不超过 5 个；面板的单仓库命令不入队，与「宿主不串行化命令」一致。

引用筛选在取数端生效：`loadCommits` 的 `branches` 由筛选状态决定，「全部」传 null（宿主按
`--branches` 等枚举）、「自动」传当前分支 + 上游 + 分叉来源、「手选」传所选引用短名；窗口缓存键
本就含 `branches`，切换筛选即换一个窗口。自动模式的分叉来源由 `loadBranchBase` 取（配置 → 分支
reflog 创建来源 → 默认远程分支，取值顺序同 VS Code 图形视图的 base 引用），只在换仓库或换分支时读；
弹窗的引用列表由 `loadRefs` 取，只在打开弹窗或手选校验时读，刷新路径不为它起子进程。

客户端只记「已知远程与贮藏」是否可信：`GraphData.infoKnown` 为真才记为已知值 —— 空远程与空贮藏
同样是事实，记下它们才不会让下一次刷新再取一次仓库信息；读取失败不回记，避免把失败固化。
`loadCommits` 响应另带 `branch`（当前分支名，取自同一次 `HEAD` 读取），刷新路径因此仍能标出当前
分支；`refresh` 的 `selectedId` 走 ref，同仓库内改选不触发取数。

## 显示到界面

「数据已到手 → 界面呈现」这一段只做必要工作：状态按帧步进、派生值按引用记忆化、缓存有容量上限。

| 机制 | 落点 | 约束 |
|---|---|---|
| 窗口状态按起始行步进 | `graph/index.ts` 的 `topIndex` 与 `graph/window-range.ts` | 滚动事件经 `requestAnimationFrame` 合并（缺失时退回 `setTimeout(0)`），起始行未变不写状态；行偏移或可视高度变化后按当前滚动位置重算 |
| 行级 `memo` | `graph/index.ts` 的 `LaneCell`/`RefChip`/`IndicatorRow`/`DetailGutter`/`CommitRow`/`CommitGraph`、`changes.ts` 的 `ChangeNodeRow`/`CommitDetail`/`ChangeGroup`、`sections.ts` 的三个分区与 `CommitBox`/`ChangeLists`、`repo-row.ts` 的 `RepoRow` | 传进去的回调必须是 `useCallback` 或模块级稳定值；行组件按「哈希 + 文本」这类稳定参数自建闭包 |
| 提交框与变更列表分拆 | `sections.ts` 的 `CommitBox` 与 `ChangeLists` | 输入提交信息只重渲染提交框；同文件内 `css.commitBox` 须排在 `css.changesScroll` 之前，两个分组的 `staged: true`/`staged: false` 须排在其后（`primitives.test.mjs` 按文本顺序断言） |
| 派生值按身份缓存 | `graph/row-model.ts` 的 `titleOf`/`labelsOf`、`panel/changes.ts` 的 `guidesOf` | `labelsOf` 的缓存键含 HEAD，检出后自动重算 |
| 派生值按键缓存 | `graph/row-model.ts` 的 `avatarUrlsOf`、`panel/language.ts` 的 `needsTranslationMemo` | 上限各 1024，键含语言或边长 |
| 悬停缓存容量 | `panel/use-commit-stats.ts` 的 `statsByHash`/`messageByHash`/`translatedByHash`/`translatedFromByHash` | 各自独立上限 1200，写入后按插入序淘汰；与既有 TTL 清理正交 |
| 对象身份复用 | `panel/commit-diff.ts` 的 `mergeCommits`/`mergeEntries` | 判据复用 `commitsEqual`/`entriesEqual`（提交只比影响图形的字段）；顺序取新列表，**总是返回新数组**，`full` 刷新不短路 |
| 时钟门控 | `panel/index.ts` 的 `refreshClock` | 只按 `document.visibilityState === 'visible'` 推进；`visibilitychange` 时启停并立即推进一次 |

`src/client/shared/cache.ts` 是这些缓存的基元（`LruMap`/`forObject`/`forKey`/`mapsEqual`/`trimOldest`），
纯模块无 React 依赖。新增缓存先在此取基元，不另写淘汰逻辑。

列表替换后未变化的元素保持对象身份（`mergeCommits`/`mergeEntries`），下游按 `commits`/`entries` 引用记忆化的
泳道布局与变更树因此不重算。

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

`core.hooksPath` 由 `host-cache.ts` 的 `readHooksPath` / `writeHooksPath` 缓存 60s（钩子文件是否存在仍
现读，增删钩子文件立刻可见），`hooksState` 因此在同一仓库反复切换时只起一次 `git config`；该取值由
外部进程改动不产生写事件，按仓库作废走 `invalidateCache`。仓库树的领先/落后取数受上限 5 的限流约束
（见「取数与缓存」），仓库数不超过 5 时不受影响。

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
| 持久化 | `$DSH_HOME/dsh-source-control/state.json`（宿主侧 `source-control/state-store.ts`，客户端经 `panel/storage.ts` 的内存镜像读写） | 跨浏览器、标签页与重启 | 用户偏好与布局（设置项、分区高度与展开态、仓库树展开与选中）、引用筛选（单键 `dsh-source-control-ref-filter` 内按规范化仓库路径分列：`'all'` 或引用 id 数组；默认「自动」不落盘，与 VS Code 图形视图一致）、工作区仓库位置缓存 |

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
- `dsh.client.inject` 只列客户端**模块包名**（宿主按此先装载对应模块工厂），不列 cordis 服务名；
  服务依赖由入口导出的 `inject` 声明。
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

版本声明：DSH 兼容性只看顶层 `engines.dsh`（DSH 用 `includePrerelease` 求值，上界写到当前
已发布的最高版本，如 `<=0.2.2-alpha.2`）；声明了 `engines.dsh` 时 DSH 忽略 `peerDependencies` 里的
`@deepseek-ai/dsh-*` 范围，因此不逐版本维护列举式列表。`peerDependencies` 只声明宿主提供的模块
（其**名字**供 profile 解析按宿主实例共享），区间与 `engines.dsh` 对齐；cordis 与客户端组件库的
`devDependencies` 固定为构建与测试所针对的精确版本。

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
| `git-parse.test.mjs` | 宿主纯解析层：NUL 记录切分、重命名、附注标签解引用、贮藏插入、伪提交；装饰解析（`HEAD ->`、`tag:`、远程 HEAD、排序）与「装饰组装 vs `for-each-ref` 组装」逐条一致 |
| `status-snapshot.test.mjs` | 工作区快照解析：v2 记录与空列、重命名、未合并、分支与上游、截断 |
| `branch-sync.test.mjs` | 分支同步：`BRANCH_SYNC_FORMAT` 形状、`parseBranchSync` 的各 track 文本与 upstream 为 null 的情形；ahead/behind 与 `rev-list` 独立推导对照 |
| `repo-discovery.test.mjs` | 仓库发现：节点排序 / depth / children / truncated、TTL 缓存与作废、`knownRepos` 快路径与回退、同层多目录、`loadReposSync` 去重与兜底、`loadReposSync` 命令经真实路由 handler；子模块声明的越界路径被拒绝 |
| `snapshot.test.mjs` | 工作区快照命令契约：经真实路由 handler，并与 `loadWorkingTree` 逐条对照；冲突合并后不作废缓存即读到合并状态 |
| `optimistic.test.mjs` | 乐观更新：暂存 / 取消暂存 / 丢弃 / 提交的推算与重命名路径匹配、条目签名 |
| `host-cache.test.mjs` | 宿主缓存：提交图键含 HEAD、命中即最近使用、按仓库（含祖先与后代）失效、快照的 HEAD 守卫、钩子路径的命中与失效 |
| `repo-facts.test.mjs` | 仓库事实层：`repoHeadHash` 与 `git rev-parse` 一致、打包引用守卫（二次调用不整读、重写后重读）、执行层写命令后布局失效、祖先与后代前缀失效、有效期归零即关闭缓存 |
| `fetch-path.test.mjs` | 取数路径：常规刷新恰 2 个 git 子进程、空信息仓库不再起 `config` / `remote`、并发两次快照只起 1 个 `status`、并发写命令仍各起一个、`hooksState` 命中缓存、响应的 `branch` 与 `symbolic-ref` 一致、仓库树取数并发上限 5 |
| `git-environment.test.mjs` | 子进程环境：只读命令加 `GIT_OPTIONAL_LOCKS=0`、写命令不加、输出语言固定且保留父进程取值 |
| `draft-storage.test.mjs` | 会话级存储：读写往返、非法值与缺失回退、按仓库根的草稿键 |
| `refresh-verify.test.mjs` | 刷新契约：快照与 `loadWorkingTree` 逐条一致、提交集与 `git log` 独立推导一致、草稿不落宿主 |
| `api-client.test.mjs` | 宿主 API 客户端的错误处理：非 2xx 响应体里的错误文本优先于状态码；`discoverRepositories` 的 `shallow`/`fullScan` 透传与 `usedCache` 读取、`enrichRepositories` 空入参不发请求 |
| `repo-tree.test.mjs` | 存储库树：补齐结果按仓库路径挂回、浅层纠正后 children 不丢、重扫后 children 变空、持久化选中工作树的待认领与认领、展开链 |
| `repo-preload.test.mjs` | 仓库树预加载：只取主视图当前会话的工作区、四步取数顺序与逐阶段发布、在途去重与 `force`、失败置 error、`dropWorkspace` 后重取、补齐空结果重试到上限 |
| `enrich-claims.test.mjs` | 补齐占用与结局：在途/已完成登记、取消与失败释放、空结果与异常驱动重试、连续失败到上限后停止下发、成功清零计数；结局判定直接调用生产的 `runEnrichBatch` |
| `commit-diff.test.mjs` | 刷新短路判据：hash/parents/heads/tags/remotes/stash 各自变化判不等、工作区条目四字段与顺序、未提交伪提交行的改写/移除/补出；`mergeCommits`/`mergeEntries` 的未变项复用、变项替换、顺序取新列表且总返回新数组 |
| `cache.test.mjs` | 有界缓存基元：`LruMap` 的 `peek` 不改次序、`get` 置新与超限按比例淘汰，`forObject` 按对象隔离且同一对象同一引用，`forKey` 淘汰后重算，`mapsEqual`，`trimOldest` |
| `window-range.test.mjs` | 窗口区间：空列表、顶部与底部越界、视口高度为 0、展开详情的非均匀行高、overscan 边界 |
| `row-model.test.mjs` | 行模型：引用标记种类与 HEAD 变化后的重算、缓存引用稳定、未提交行与贮藏行文案、头像候选地址 |
| `refresh-contract.test.mjs` | 刷新路径的图形区状态契约（需本机 jsdom，缺失时整体跳过）：提交图在途时触发只取快照的刷新仍收敛 ready、只取快照不改 phase、条目由零变正时补出未提交行；取数起点（手选传引用短名、自动传分支 + 上游 + 分叉来源、切换筛选按新起点重取） |
| `gh-cli.test.mjs` | `gh` 失败分类：未安装 / 未登录 / 缺 scope / 无权限 / 参数错误 |
| `change-tree.test.mjs` | 变更树：单链合并、分叉、折叠、排序；文件夹计数与改造前一致（含多层与空目录） |
| `refs.test.mjs` | 引用筛选状态：按仓库键读写与路径归一、自动模式不落盘、切回自动删项、非法值回退、引用 id 与短名换算、取数起点组装、手选失效回退自动、勾选态与摘要文案 |
| `ref-filter-source.test.mjs` | 引用筛选的宿主取数：全部引用摘要（分支/远程/标签、完整引用名、关闭远程分支）、分叉来源的四级取值（配置、reflog 创建来源、本地来源分支、分离头指针无来源）、经路由读引用与分叉来源、筛选在取数端生效（未选中的分支尖端被排除） |
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
| `discard-notice.test.mjs` | 丢弃结局提示：哪些子模块结局需要告知、提示是否点明未清理的部分、未删除的嵌套仓库一并列出 |
| `data-sources.test.mjs` | JSON 数据源形状：两份菜单的 id/标题/目标/占位符与各目标必备操作、提示词四段齐全 |
| `log-format.test.mjs` | logcat 格式：时间戳形状、单行拼装、多行消息逐行带时间戳 |
| `log-retention.test.mjs` | 日志目录判据：日文件夹命名、文件名排序即启动先后、体积淘汰顺序、当前文件不被淘汰、15 天保留 |
| `logger.test.mjs` | 日志落盘实机契约：按日文件夹写入、每次启动新文件、内容符合 logcat、过期日文件夹与超限文件被清理 |
| `log-redact.test.mjs` | 脱敏：URL 凭据与令牌替换、用户名替换但路径保留、豁免原样保留、摘要与幂等 |
| `feedback.test.mjs` | 反馈：标题前缀、正文四段与上传步骤、目标仓库、字节换算、日志打包与 tar 不可用时的退回 |
| `client-bundle.test.mjs` | 产物包络、外部模块请求、席位注册 |
| `api-commands.test.mjs` | 经真实路由 handler 的宿主命令集回归（从 `lib/` 产物导入）；含钩子探测（默认目录 / `core.hooksPath`）与 `skipHooks` 的 `--no-verify` 语义 |
| `connectivity.test.mjs` | 真实历史的泳道图无断线（非 git 仓库时跳过） |
| `ordering.test.mjs` | 三种提交排序 |

`api-commands.test.mjs` 与 `snapshot.test.mjs` 从 `lib/` 宿主产物导入，因此 `pretest` 跑完整 `build`。

`primitives.test.mjs` 断言「客户端从 ui-primitives 导入的每个名字都真实存在」：产品图标导出名带
`Regular` / `Medium` 权重后缀，写成裸名会得到 `undefined`，React 渲染时不报编译错误、只在运行时抛
「元素类型无效」并让整个侧栏页变空白。新增图标导入前先确认导出名。
