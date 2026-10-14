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
src/client/         客户端侧：侧栏页入口、面板状态与组装、泳道图、差异页、右键菜单与弹窗、
                    设置面板、样式与图标、类型
  src/client/panel/ 面板的细分：三个分区组件、变更树、引用计算、各目标右键菜单与 hooks
test/               单元测试（`node --test test/*.test.mjs`）
doc/                中文文档：功能说明随仓库提交；迁移差异与实现计划、数据层方案为本地文档，不提交
scripts/            客户端打包脚本
assets/icons/       引用标记用的 SVG
```

宿主侧数据层分四块：`working-tree.ts` 是 git 执行层（`runGit` / `gitOrThrow`）与工作区变更；
`git-parse.ts` 是纯解析层，输入 git 原始输出、输出数据结构，无 git 调用，可被测试直接导入；
`git-query.ts` 是只读查询层；`git-actions.ts` 是操作层，两者都返回 `ErrorInfo`（成功 `null`）。
数据形状集中在 `git-types.ts`，其字段名即前端契约。多记录命令一律用 `-z` 取 NUL 分隔输出，
记录内字段用 `%x00` 分隔；**`for-each-ref` 的转义是 `%00`**，写成 `%x00` 不会被展开。
`git diff-tree -z` 的输出以提交对象名开头，解析时须跳过（`skipLeadingObjectName`）。

`gh-cli.ts` 是 GitHub 集成层：同样以数组参数直接 spawn `gh`（不经 shell），并设
`GH_PROMPT_DISABLED=1` 避免子进程等待交互输入。`classifyGhFailure` 把 `gh` 输出归类为
missing-cli / not-logged-in / missing-scope / forbidden / not-found / invalid / unknown，
前端据此降级（隐藏入口或提示补授权）。GitHub 对无权访问的资源回 404，因此建仓库场景的
404 归入无权限。

分层：`src/client/panel.ts` 持有状态，分区组件只接收已算好的数据与回调；纯计算抽成无 React 依赖的模块
以便直接单测。客户端不得反向依赖 `index.ts`（会成环），共享的图标等放在独立模块。

## 状态持久化的三级

按存活范围分三级，取值刻意不同，不可统一：选级别看该状态「丢了会不会烦」与「跨会话是否仍有意义」。

| 级别 | 载体 | 存活范围 | 适用 |
|---|---|---|---|
| 窗口级 | 组件 `useState` / `useRef` | 本次挂载 | 瞬时交互与派生数据：分组折叠集合、过滤弹窗的选中与搜索、`amend`、`maxCommits`、分页与请求中标志 |
| 会话级 | `sessionStorage`（`panel/storage.ts` 的 `loadSession` / `saveSession`） | 刷新保留，关闭标签页清除 | 与当前工作区绑定、换标签页重填成本高的输入：提交信息草稿（键 `ggg-commit-msg:<workingTreePath>`） |
| 持久化 | `localStorage`（`loadPersistent` / `savePersistent`，`settings.ts`、`repo-tree.ts`） | 跨标签页与浏览器重启 | 用户偏好与布局：设置项、分区高度与展开态、仓库树展开与选中 |

新状态先在此表定位，再选载体；不要为省事一律用 `localStorage`。

## 构建

```bash
pnpm install
pnpm build        # build:host（tsc → lib/）+ build:client（esbuild → lib/client.js）
pnpm typecheck    # 宿主（tsconfig.json）与客户端（tsconfig.client.json）两段
pnpm test         # pretest 先跑完整 build（宿主 + 客户端），再 node --test test/*.test.mjs
```

- 客户端外部化模块固定为 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/dsh-client-ui-primitives`；浏览器半边不得引入其他裸模块。
- `jsx: 'automatic'`（复制的 FileDiff 不显式导入 React）；`charset: 'utf8'`（保留中文字面量）。
- CSS 模块用 esbuild 的 `local-css` loader，**必须配 `outdir`**，否则报
  `Cannot import ... without an output path configured`。`local-css` 只产类名映射，样式文本需脚本单独
  收集并内联为 `<style id="dsh-source-control-module-style">`，`lib/` 下不留 CSS 文件。
- `assets/icons/` 的 SVG 以文本内联，运行时不请求额外资源。
- `lib/` 是构建产物，不提交（`.gitignore`）；发布内容由 `package.json` 的 `files` 白名单决定。

## 测试

测试从 `src/` 直接导入（Node 原生 TS 支持），因此**被测模块不得有内部 `.js` 相对导入**——那会让直连
`.ts` 时报 `ERR_MODULE_NOT_FOUND`；带这类导入的逻辑要么抽成无依赖的纯模块，要么改用 `lib/` 产物验证。

| 文件 | 覆盖 |
|---|---|
| `lanes.test.mjs` | 泳道布局：连线连续性、压实、节点半径、越界重叠、无贝塞尔 |
| `primitives.test.mjs` | ui-primitives 导入名存在性、面板结构 |
| `diff-hunks.test.mjs` | 统一差异解析 |
| `git-parse.test.mjs` | 宿主纯解析层：NUL 记录切分、重命名、附注标签解引用、贮藏插入、伪提交 |
| `api-client.test.mjs` | 宿主 API 客户端的错误处理：非 2xx 响应体里的错误文本优先于状态码 |
| `gh-cli.test.mjs` | `gh` 失败分类：未安装 / 未登录 / 缺 scope / 无权限 / 参数错误 |
| `change-tree.test.mjs` | 变更树：单链合并、分叉、折叠、排序 |
| `worktree-branches.test.mjs` | 工作树占用分支的判定 |
| `remote-url.test.mjs` | 远程地址解析与 HTTP(S) / SSH 双向换算、协议档位 |
| `ssh-status.test.mjs` | SSH 状态检测：版本行、私钥筛选、探测输出归类 |
| `github-remote.test.mjs` | GitHub 远端识别与提交页地址 |
| `git-messages.test.mjs` | git 失败文本的中文说明与原文回退 |
| `client-bundle.test.mjs` | 产物包络、外部模块请求、席位注册 |
| `api-commands.test.mjs` | 经真实路由 handler 的宿主命令集回归（从 `lib/` 产物导入） |
| `connectivity.test.mjs` | 真实历史的泳道图无断线（非 git 仓库时跳过） |
| `ordering.test.mjs` | 三种提交排序 |

`api-commands.test.mjs` 从 `lib/` 宿主产物导入，因此 `pretest` 跑完整 `build`。

`primitives.test.mjs` 断言「客户端从 ui-primitives 导入的每个名字都真实存在」：产品图标导出名带
`Regular` / `Medium` 权重后缀，写成裸名会得到 `undefined`，React 渲染时不报编译错误、只在运行时抛
「元素类型无效」并让整个侧栏页变空白。新增图标导入前先确认导出名。
