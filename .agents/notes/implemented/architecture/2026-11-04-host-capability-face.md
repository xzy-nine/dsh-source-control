# Agent Note: 文件系统与子进程收拢到宿主能力面

Status: implemented

## Problem

宿主提供了 `ctx.fs`（`SandboxedFileSystem`）与 `ctx.subprocess`，但插件各处仍直接用 Node 原语：

- `child-process.ts` 自建子进程封装，并自写 `taskkill /t /f` 终止进程树。
- `git-exec.ts`、`gh-cli.ts`、`feedback.ts`、`log-archive.ts`、`ssh-status.ts` 各自 `spawn` 并各管超时、stdio 与错误文本。
- `repo-node.ts`、`repo-enrich.ts`、`worktree-branches.ts`、`repo-facts.ts`、`hooks.ts`、`repo-watcher.ts` 直接 `fs.stat` / `readFile` / `readdir`。
- `repo-watcher.ts` 用 `node:fs.watch(Boolean)` 观察工作区。

后果有三：这些写操作绕开宿主的沙箱边界；进程树终止在 POSIX 与 Windows 上是两套实现；宿主对文件与进程的观测（版本令牌、受管范围）插件一律拿不到。

## Decision

### 单一能力面

新增 `source-control/host-runtime.ts`，是插件访问宿主文件系统与子进程的唯一入口，导出 `installHostCapabilities(read)`、`runCollect`、`terminateAllChildren`、`readTextAt`、`probePathAt`、`statAt`、`listDirAt`、`watchDirAt`、`resetHostCapabilities`。

`runCollect` 走 `ctx.subprocess` 的受管范围：整树终止、显式 stdio、`graceMs` 与 `DSH_*` 环境清理由宿主统一，输出超过 `DEFAULT_MAX_OUTPUT_BYTES`（64 MiB）时标记 `lossy` 并以 `code: -1` 返回。终止一律按 `SubprocessHandle.terminate()` 下发，`terminateAllChildren` 在插件卸载时收尾。

### 没有原生回退

`installHostCapabilities` 在 `ctx.fs` 或 `ctx.subprocess` 缺失时**抛错**使插件装载失败（"没有原生回退"），不退回 `node:fs` 与 `child_process`。`child-process.ts` 整份删除。

测试进程没有宿主，因此 `test/host-fixture.mjs` 以 Node 原语填满同一份能力面，由 `test/setup.mjs` 安装；`test/host-runtime.test.mjs` 以 10 个串行用例钉住 seam 契约，并覆盖"缺服务即抛错"。

### 目录监视的分层补偿

`ctx.fs.watch` 只观察直接子项，回调只给 `(error?)`，不给文件名与类型，也不递归。工作区根常常只是一层目录（各仓库在其下），因此 `repo-watcher.ts` 给工作区的每个直接子目录各挂一个句柄，并用 `PROBE_DEPTH`（2）枚举仓库集合快照，快照未变不通知。子目录句柄与根句柄共用 `noteDirectoryChange` 判定。

句柄成本是选择深度的依据：仅根 6 个；根加一层 83 个；根加两层 393 个（6 个工作区）。因此只挂一层，第二层用快照轮询覆盖。

### 文件读取的版本令牌

`repo-facts.ts` 等处的缓存新鲜度改用 seam 返回的 `version` 令牌，不再自行比较 mtime。

## Alternatives considered

**保留原生路径，只在写操作上补沙箱检查。** 否决：沙箱边界是宿主对执行世界的定义，插件自建检查只会与宿主策略分叉；且原生路径拿不到受管进程范围与版本令牌。

**`ctx.fs` 或 `ctx.subprocess` 缺失时回退原生实现。** 否决：两条实现路径意味着两套终止语义、两套错误文本与两套测试；缺服务是部署问题，应当装载失败而不是静默降级。

**目录监视递归挂满 `PROBE_DEPTH` 层。** 否决：实测根加两层是 393 个句柄，且宿主后端未必支持递归；快照轮询在第二层足够，成本恒定。

**继续用 `taskkill /t /f` 终止进程树。** 否决：POSIX 与 Windows 两套实现要各自维护，且绕过宿主对受管范围的记录；`terminate()` 已覆盖整树。

## Consequences

插件不再直接 `spawn`、不再直接读写文件、不再用 `node:fs.watch`。`child-process.ts`（126 行）删除，五处子进程调用点与六处文件访问统一到 `host-runtime.ts`。

代价是插件在这些能力上完全依赖宿主：`ctx.fs` 或 `ctx.subprocess` 缺失即无法装载。测试因此需要 `host-fixture.mjs` 这一层替身，生产代码没有对应分支。

目录监视需要一层句柄补偿与一层快照轮询，比单次递归 `watch` 复杂；换来的是不依赖后端递归能力，且句柄数可控。

## Testing

`test/host-runtime.test.mjs` 覆盖 seam 契约与缺服务抛错；`test/workspace-watch-depth.test.mjs` 覆盖子目录句柄挂载、新建子目录补挂与关闭时收尾；`test/repo-watcher-live.test.mjs` 覆盖 `.gitmodules` 声明与工作区仓库增删的报告。
