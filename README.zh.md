# dsh-dev-git-graph

DSH 插件：会话 **Git Graph 页**——在 DSH Web GUI 内置右侧 Sidebar 中以「Git Graph」页显示**当前会话工作区**的
提交图、变更列表与提交框。界面按 VS Code 的「源代码管理 + 图形」视图排布，控件取自 DSH 的
`@deepseek-ai/dsh-client-ui-primitives`，因此外观与 Harness 本身一致。

## 架构

```
内置右侧栏页「Git Graph」(src/client/index.js，主文档内 React 树)
  └─ useSessions() 取该会话工作区 cwd
  └─ 面板：工具栏 / 存储库 / 变更 + 提交框 / 提交图（泳道 SVG）
        │ fetch POST /dsh-dev-git-graph/gg/api
        ▼
host 路由 (src/git-graph/routes.ts)
  └─ src/git-graph/working-tree.ts：工作区状态 / 暂存 / 提交 / 丢弃
        ▼
本地 git 仓库
```

- **界面**：`src/client/` 下的 React 组件，由 esbuild 打包为 `lib/client.js`；`react` 与
  `@deepseek-ai/dsh-client-ui-primitives` 是 shell 共享的平台模块，外部化引用。
- **主题**：样式以 `--dsw-alias-*` 语义 token 为主、随主题明暗切换；引用标记取泳道调色板的固定色。
- **页注册**：`ctx.sidebarRightTabs.register`（id `dsh-dev-git-graph/git-graph`，kind `devGitGraph`），
  正文进带键席位 `sidebar.right.pane.tab`，chip 标题进 `sidebar.right.pane.tab.title`。

## 面板布局

| 区域 | 内容 |
|---|---|
| 工具栏 | 刷新、抓取、推送当前分支；设置（提交排序等） |
| 存储库 | 当前仓库与所在分支；存储库行统一用本地 `book_2` 图标，工作树 / 子模块用右侧文字标签区分 |
| 更改 | 工作区变更列表（状态字符 + 文件类型图标 + 悬停操作：打开差异 / 丢弃 / 暂存或取消暂存）；全部暂存与全部丢弃 |
| 提交框 | 提交信息（复用 `InlineEditor` 多行编辑器，Enter 提交、Shift+Enter 换行、Esc 清空草稿）、修补上一次提交、提交按钮（显示已暂存数量） |
| 图形 | 提交泳道图：分支彩线；每行为「泳道 + 提交信息（作者紧随其后，空间不足时随省略号截断）+ 右对齐的引用标记」，图列宽度按该行实际用到的泳道数取，提交信息紧贴其后，引用标记始终固定在右端——当前分支与本地分支是「图标 + 名称」药丸，远端、标签、贮藏是圆形图标（名称见悬停提示与右键菜单）；远程 HEAD（`refs/remotes/<remote>/HEAD`）与本地 HEAD 不作为引用标记列出；节点形状区分种类：当前分支为空心环、合并提交为环加内点、其余为实心点，线段停在节点外沿而不穿过节点；分页加载只取窗口内的提交，父提交未加载时仍占住泳道并把线画到行底，因此已加载部分的泳道与颜色不会因加载更多而改变；提交日期与短哈希见行悬停卡片；悬停某行浮出卡片（DSH 标准浮窗底色）：作者、时间（主标签按设置里的日期格式，括号内始终补详细日期与时间，主标签已是详细时间时不重复）、完整提交信息、改动文件与增减行数、引用标记（卡片内展开显示名称）、短哈希与复制按钮，除作者与提交信息之间外各段之间都有横线分割；选中提交展开其改动文件 |

- **提交右键菜单**：查看提交、在 GitHub 上打开（仅有 GitHub 远端时出现）、检出此提交、从此提交创建分支 / 标签、删除分支（二级菜单列出指向该提交的本地与远程分支）、删除标签（二级菜单列出标签）、拣选、还原、重置当前分支、合并、变基、复制哈希与提交信息。

### 提交排序

设置面板「提交排序」下拉提供三档，与原版 `git-graph.commitOrdering` 一致，默认拓扑序：

| 档位 | git 参数 | 说明 |
|---|---|---|
| 拓扑 | `--topo-order` | 同一分支的提交相邻 |
| 时间 | `--date-order` | 按提交时间戳 |
| 作者时间 | `--author-date-order` | 按作者时间戳 |

排序方式会改变提交序列，泳道分布与图形宽度随之变化。

## 打开入口（内置右侧栏）

不依赖任何第三方侧栏插件，两个入口都以页类型注册为唯一内容面：

| 入口 | 席位 | 行为 |
|---|---|---|
| 引导页入口胶囊 | 类型定义的 `guide` 条目 | 右侧栏 tab 条「+」打开引导页后，点「Git Graph」胶囊即打开该页 |
| 会话 header 图标按钮 | `conversation.session.header.utilities`（order -5） | 直接打开该页；已打开时聚焦 |

## 宿主命令

| 命令 | 说明 |
|---|---|
| `loadWorkingTree` | 读取工作区变更（解析 `git status --porcelain -z`，含重命名原路径） |
| `stagePaths` | 暂存指定路径；空数组表示全部 |
| `unstagePaths` | 取消暂存；仓库还没有 HEAD 时退回 `git rm --cached` |
| `discardPaths` | 丢弃改动（未跟踪文件走 `git clean`，已跟踪文件走 `git restore`） |
| `commitStaged` | 提交暂存区，返回新提交哈希 |

## 与原版差异

| 项 | 说明 |
|---|---|
| 界面 | 不再内嵌 VS Code webview，改为 DSH 组件构成的 React 面板 |
| VS Code 专属命令 | `openFile` / `viewDiff` / `viewDiffWithWorkingFile` / `openTerminal` / `createPullRequest` / `createArchive` 等返回「暂不支持」 |
| 仓库来源 | 自动绑定当前会话工作区（无工作区时页内显示提示） |

## 构建与安装

```bash
# 构建：宿主 tsc → lib/，前端 esbuild → lib/client.js
pnpm --filter dsh-dev-git-graph build

# 类型检查与泳道布局测试
pnpm --filter dsh-dev-git-graph typecheck
pnpm --filter dsh-dev-git-graph test

# 安装到 web profile（本地目录）
dsh plugin --profile web add file:/path/to/dsh-plugins/packages/dsh-dev-git-graph
# 重启 dsh web 生效；会话页右侧栏「+」→ 引导页出现「Git Graph」，会话 header 亦有图标按钮
```

- 宿主半边用 `tsc -p tsconfig.json` 编译到 `lib/`；前端半边用 `scripts/build-client.mjs`
  （esbuild）打成 `lib/client.js`。
- `react` 与 `@deepseek-ai/dsh-client-ui-primitives` 是 shell 共享的平台模块，构建时外部化；
  浏览器半边不得引入其他裸模块。

## 许可
