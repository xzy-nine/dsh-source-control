# dsh-dev-git-graph

## 架构

```
内置右侧栏页「Git Graph」(client.js)
  └─ useSessions() 取该会话工作区 cwd
  └─ iframe /dsh-dev-git-graph/gg/index.html?repo=<cwd>
        │ host 注入 window.__DSH_GG_BOOT__ = { apiBase, repo, initialState, ... }
        ▼
  └─ VS Code 兼容桥：postMessage → fetch POST /dsh-dev-git-graph/gg/api
        ▼
host 路由 (src/git-graph/routes.ts)
        ▼
本地 git 仓库
```

- API：`POST /dsh-dev-git-graph/gg/api`，命令集对齐原扩展 `gitGraphView.respondToMessage`（约 60 个命令）。
- 主题：CSS 把 `--vscode-*` 映射到 DSH `--dsw-alias-*` 设计变量（缺省值兜底），随主题变明暗。
- 页注册：`ctx.sidebarRightTabs.register`（id `dsh-dev-git-graph/git-graph`，kind `devGitGraph`），
  正文进带键席位 `sidebar.right.pane.tab`，chip 标题进 `sidebar.right.pane.tab.title`。

## 打开入口（内置右侧栏）

不依赖任何第三方侧栏插件，两个入口都以页类型注册为唯一内容面：

| 入口 | 席位 | 行为 |
|---|---|---|
| 引导页入口胶囊 | 类型定义的 `guide` 条目 | 右侧栏 tab 条「+」打开引导页后，点「Git Graph」胶囊即打开该页 |
| 会话 header 图标按钮 | `conversation.session.header.utilities`（order -5） | 直接打开该页；已打开时聚焦 |

## 与原版差异

| 项 | 说明 |
|---|---|
| VS Code 专属命令 | `openFile` / `viewDiff` / `viewDiffWithWorkingFile` / `openTerminal` / `createPullRequest` / `createArchive` 等返回「暂不支持」 |
| 状态持久化 | 前端 localStorage（原扩展用 workspaceState），`setGlobalViewState` 等直接 ACK |
| 仓库来源 | 自动绑定当前会话工作区（无工作区时页内显示提示） |

## 构建与安装

```bash
pnpm --filter dsh-dev-git-graph build

# 类型检查
pnpm --filter dsh-dev-git-graph typecheck

# 安装到 web profile（本地目录）
dsh plugin --profile web add file:/path/to/dsh-plugins/packages/dsh-dev-git-graph
# 重启 dsh web 生效；会话页右侧栏「+」→ 引导页出现「Git Graph」，会话 header 亦有图标按钮
```

## 许可
