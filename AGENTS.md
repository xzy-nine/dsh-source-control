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
src/index.ts        宿主入口：注册 web 路由与 AI 依赖
src/source-control/ 宿主侧：git 命令路由、执行层、纯解析层、查询层、操作层、差异收集、仓库发现
src/client/         客户端侧：只有 index.ts（侧栏页入口）平铺，其余按职责分目录
  src/client/api/   宿主 API 客户端：传输层与按命令域拆分的命令封装，index.ts 汇总导出
  src/client/panel/ 面板：index.ts 主体、三个分区组件、变更树、引用计算、忙碌分级、设置面板、
                    仓库树、语言判定、各目标右键菜单与 hooks；menu-actions.json 是右键操作
                    元数据与菜单名称的数据源，menu-actions.ts 补缺省并给出类型
  src/client/graph/ 泳道图：index.ts 组件与 lanes.ts 布局纯计算
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
scripts/            客户端打包脚本
assets/icons/       引用标记用的 SVG
```

两处文案以 JSON 为唯一数据源，由薄层直接读入（`import … with { type: 'json' }`，两端构建都原生支持；
宿主 tsc 会把 JSON 一并产出到 `lib/`）：右键菜单的元数据与菜单名称在 `src/client/panel/menu-actions.json`，
由 `panel/menu-actions.ts` 补缺省并给出类型；AI 提交信息的基础提示词在
`src/source-control/ai-commit-prompts.json`，由 `source-control/ai-commit-prompts.ts` 读入并代入占位符。
JSON 在 TS 里是宽类型（字符串推成 `string`、缺键不报错），因此形状与占位符由
`test/data-sources.test.mjs` 校验。

宿主侧数据层分四块：`working-tree.ts` 是 git 执行层（`runGit` / `gitOrThrow`）与工作区变更；
`git-parse.ts` 是纯解析层，输入 git 原始输出、输出数据结构，无 git 调用，可被测试直接导入；
`git-query.ts` 是只读查询层；`git-actions.ts` 是操作层，两者都返回 `ErrorInfo`（成功 `null`）。
`ignore.ts` 写入忽略规则（最近的 `.gitignore` 与本地排除文件），规则写法与去重是纯函数，放在
`ignore-rules.ts`；本地排除文件在 `.git` 目录内，客户端以宿主返回的绝对路径按普通文件打开。
克隆不由插件执行：客户端构造 `git -C <父目录> clone` 命令（`git/clone-command.ts`，纯函数），由
`git/terminal-run.ts` 打开 DSH 终端页并在其中执行。
数据形状集中在 `git-types.ts`，其字段名即前端契约。多记录命令一律用 `-z` 取 NUL 分隔输出，
记录内字段用 `%x00` 分隔；**`for-each-ref` 的转义是 `%00`**，写成 `%x00` 不会被展开。
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
| 自动刷新（兜底） | 定时轮询工作区签名 | 120s，连续两次同一签名才重载 | 跟随 `autoRefresh` |
| 自动抓取 | 定时循环 | `autoFetchPeriod` 秒（默认 180） | `autoFetch`（默认开） |
| 缓存清理 | 定时循环 | 300s | 无 |

兜底轮询覆盖事件窗口之外的外部写入（编辑器、终端、其它进程），间隔远大于事件响应的及时性要求，
页签不可见、上一次未结束、面板正忙时跳过。

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

## 状态持久化的三级

按存活范围分三级，取值刻意不同，不可统一：选级别看该状态「丢了会不会烦」与「跨会话是否仍有意义」。

| 级别 | 载体 | 存活范围 | 适用 |
|---|---|---|---|
| 窗口级 | 组件 `useState` / `useRef` | 本次挂载 | 瞬时交互与派生数据：分组折叠集合、过滤弹窗的选中与搜索、`amend`、`maxCommits`、分页与请求中标志 |
| 会话级 | `sessionStorage`（`panel/storage.ts` 的 `loadSession` / `saveSession`） | 刷新保留，关闭标签页清除 | 与当前工作区绑定、换标签页重填成本高的输入：提交信息草稿（键 `ggg-commit-msg:<workingTreePath>`） |
| 持久化 | `localStorage`（`loadPersistent` / `savePersistent`，`panel/settings.ts`、`panel/repo-tree.ts`） | 跨标签页与浏览器重启 | 用户偏好与布局：设置项、分区高度与展开态、仓库树展开与选中 |

新状态先在此表定位，再选载体；不要为省事一律用 `localStorage`。

## 构建

```bash
pnpm install
pnpm build        # build:host（tsc → lib/）+ build:client（esbuild → lib/client.js）
pnpm typecheck    # 宿主（tsconfig.json）与客户端（tsconfig.client.json）两段
pnpm test         # pretest 先跑完整 build（宿主 + 客户端），再 node --test test/*.test.mjs
```

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

## 测试

测试从 `src/` 直接导入（Node 原生 TS 支持），因此**被测模块不得有内部 `.js` 相对导入**——那会让直连
`.ts` 时报 `ERR_MODULE_NOT_FOUND`；带这类导入的逻辑要么抽成无依赖的纯模块，要么改用 `lib/` 产物验证。

| 文件 | 覆盖 |
|---|---|
| `lanes.test.mjs` | 泳道布局：连线连续性、压实、节点半径、越界重叠、无贝塞尔 |
| `primitives.test.mjs` | ui-primitives 导入名存在性、面板结构、CSS 模块类名引用 |
| `diff-hunks.test.mjs` | 统一差异解析 |
| `git-parse.test.mjs` | 宿主纯解析层：NUL 记录切分、重命名、附注标签解引用、贮藏插入、伪提交 |
| `api-client.test.mjs` | 宿主 API 客户端的错误处理：非 2xx 响应体里的错误文本优先于状态码 |
| `gh-cli.test.mjs` | `gh` 失败分类：未安装 / 未登录 / 缺 scope / 无权限 / 参数错误 |
| `change-tree.test.mjs` | 变更树：单链合并、分叉、折叠、排序 |
| `refs.test.mjs` | 引用筛选：可达集过滤、工作区伪提交与贮藏提交的保留、引用收集 |
| `worktree-branches.test.mjs` | 工作树占用分支的判定 |
| `remote-url.test.mjs` | 远程地址解析与 HTTP(S) / SSH 双向换算、协议档位 |
| `ssh-status.test.mjs` | SSH 状态检测：版本行、私钥筛选、探测输出归类 |
| `github-remote.test.mjs` | GitHub 远端识别与提交页地址 |
| `git-messages.test.mjs` | git 失败文本的中文说明与原文回退 |
| `ignore-rules.test.mjs` | 忽略规则的路径规范化、规则写法、去重与追加、越界拒绝 |
| `clone-command.test.mjs` | 终端克隆命令的构造与终端执行（开页、等待可写、超时） |
| `change-events.test.mjs` | 文件改动事件判据：落地判定、嵌套调用、仓库内判定、冷却与定时参数 |
| `panel-busy.test.mjs` | 忙碌分级：按仓库与影响面记录、互不阻塞、逐份移除 |
| `data-sources.test.mjs` | JSON 数据源形状：菜单操作的 id/标题/引用类型、名称占位符、提示词四段齐全 |
| `better-sidebar-diff.test.mjs` | better-sidebar 差异接入：能力探测、种子换算与回退判据 |
| `client-bundle.test.mjs` | 产物包络、外部模块请求、席位注册 |
| `api-commands.test.mjs` | 经真实路由 handler 的宿主命令集回归（从 `lib/` 产物导入） |
| `connectivity.test.mjs` | 真实历史的泳道图无断线（非 git 仓库时跳过） |
| `ordering.test.mjs` | 三种提交排序 |

`api-commands.test.mjs` 从 `lib/` 宿主产物导入，因此 `pretest` 跑完整 `build`。

`primitives.test.mjs` 断言「客户端从 ui-primitives 导入的每个名字都真实存在」：产品图标导出名带
`Regular` / `Medium` 权重后缀，写成裸名会得到 `undefined`，React 渲染时不报编译错误、只在运行时抛
「元素类型无效」并让整个侧栏页变空白。新增图标导入前先确认导出名。
