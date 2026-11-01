# Agent Note: 取数性能与缓存分层

Status: implemented

## Problem

面板取数从「客户端发出请求」到「响应落在客户端状态」这一段存在重复的文件系统解析、可复用的子进程重复启动，以及空信息仓库的重复取数。本决策已实施（提交 `ba84ec3`）。目标是把一次取数的**子进程数**、**重复的文件系统解析**、**无谓的重复取数**压到最小，并让缓存的有效期、键与作废范围同数据的实际变化频率对齐。

可见行为与协议语义不变，例外只有两处只增字段（`loadCommits` 响应的 `branch`、`GraphData` 的 `infoKnown`）与一处格式串字段数变化（`LOG_FORMAT` 6 → 7）。

判定标准与实测结果：

| 判据 | 目标 | 实测 |
|---|---|---|
| 一次常规刷新（已知仓库信息）的 git 子进程数 | 3 → 2 | **2**（达标） |
| 一次常规刷新墙钟 | 67ms → ≤60ms | 66.5ms（未达标，刷新两路并行，墙钟由最慢的 git 进程决定，被删掉的 `for-each-ref` 本不在关键路径上） |
| 无远程、无贮藏仓库的刷新子进程数 | 4 → 2 | **2** |
| 一次刷新对 `.git` 的文件读取 | 17 次 → ≤8 次 | **8** |
| 同一仓库 60 秒内的钩子探测子进程数 | 1 → 0 | 命中时 **0** |
| 仓库树领先/落后取数的并发 git 上限 | 5；仓库数不超过 5 时墙钟不高于现状 | 6 个仓库时峰值为 **5**（`test/fetch-path.test.mjs`） |
| 缓存命中路径（提交图窗口 30 秒内） | ≤2ms 且 0 个 git 子进程 | **1.2ms / 0** |

## Decision

### 仓库事实层 `src/source-control/repo-facts.ts`

- `repoLayout(repo): { gitDir: string; commonDir: string } | null`：进程级缓存，有效期 10s、容量 64，命中即最近使用；键为规范化仓库路径，按祖先与后代前缀作废；`stat` 失败返回 null。
- `readPackedRef(commonDir, refName): string | null`：把 `packed-refs` 解析成 `Map<引用名, 哈希>` 后缓存，以 `stat` 的 `mtimeMs` 与 `size` 作守卫，容量 8；守卫不通过即重读。
- `repoHeadHash(repo): string | null`：复用上述两项；`HEAD` 文件每次都重读 —— 它是缓存键的失效判据，不缓存。
- `invalidateRepoFacts(repo)`、`clearRepoFacts()`、`setRepoFactsTtlForTest(ms)`（0 表示关闭缓存）。
- 挂 `onRepositoryWrite` 作废目标仓库及其祖先、后代。
- 接入点：`git-query.ts` 的 `mergeInProgress` 与 `getStashes`，以及两处 `readHeadHash`。`worktree-branches.ts` 保持无缓存的可单测纯实现。

### 子进程层 `src/source-control/working-tree.ts`

- 在途复用的判据由 `cacheable` 改为 `readOnly`：确认只读的命令（含 `status`、`diff`、`ls-files`）共享在途子进程；结果缓存的判据不变（这三类仍不入缓存，仍现读现用）；写命令一律独立执行。
- `gitEnvironment` 按 `readOnly` 的两种形态各缓存一份对象。
- 客户端中止不终止宿主子进程：中止后的重发命中同一个在途进程，这正是收益来源。

### 宿主缓存补齐 `src/source-control/host-cache.ts`

- 新增 `readHooksPath(repo)` / `writeHooksPath(repo, value)`：键为仓库，有效期 60s，容量 32，纳入 `invalidateRepo`。
- 路由的 `hooksState` 先读该缓存，未命中才跑 `git config --get core.hooksPath`；钩子文件是否存在仍由 `detectHooks` 现读。
- 不新增「仓库行领先/落后」缓存：客户端按 `syncedIds` 只取一次。

### 并发上限 `child-process.ts` + `repo-discovery.ts`

- `child-process.ts` 的 `createLimiter(max)`：队列加在跑计数，任务成功或失败都归还额度。
- `repo-discovery.ts` 的 `loadReposSync` 走模块级 `createLimiter(SYNC_CONCURRENCY)`，常量取 5；面板的单仓库命令不入队，保持「宿主不串行化命令」。
- 注释写明作用域：只有仓库树的批量领先/落后取数限流。

### 客户端取数契约与去重

- 宿主 `loadCommits` 响应增 `branch`：当前分支名，取自同一次 `readHeadRef`，与缓存键里的 HEAD 哈希是两个值。`loadGraph` 在未取仓库信息时用它填 `head`。
- `GraphData` 增 `infoKnown: boolean`：仅当响应确实带仓库信息且 `repoInfo.error === null` 时为真。`rememberFromGraph` 改按它判断，空远程与空贮藏也记下。
- `refresh` 的 `selectedId` 依赖改为读 `selectedIdRef`，同仓库内改变选中不再触发取数。
- `writeSync` 逐字段比较，未变时返回原 Map。

### 引用标注并进日志

- `git-parse.ts` 的 `LOG_FORMAT` 末位追加 `%D`（`LOG_FIELD_COUNT` 6 → 7），`getLog` 的参数追加 `--decorate=full`。
- 新增纯函数 `parseDecorations(text)`，返回 `{ heads, tags, remotes }`：处理 `HEAD -> refs/heads/x`（既作该分支的标记，也作 HEAD 的判据）、`tag: refs/tags/x`、按「逗号 + 空格」切分（引用名不含空格）、按 `refs/heads` / `refs/tags` / `refs/remotes` 前缀过滤，`hideRemotes` 沿用 `parseRefs` 的规则。
- `assembleCommits` 改为接收装饰表与 HEAD 哈希；删除提交图路径的 `getRefsForGraph`、`refsInput` 与 `loadCommits` 里的引用预取。`loadRepoInfo` 仍用 `REF_BRANCH_FORMAT`。
- `CommitTag.annotated` 恒 false：装饰无法区分附注标签。客户端只在 `commitsEqual` 的相等判定里读它，行标记不读，`shared/types.ts` 也无该字段。
- 回退判据：同一仓库「装饰组装」与「`for-each-ref` 组装」逐条不一致，或刷新墙钟降幅不足 10%，撤回本项。

### 度量脚本 `scripts/bench-git-info.mjs`

- 与既有 bench 同风格：`node scripts/bench-git-info.mjs [仓库路径] [轮数]`，依赖 `pnpm build:host`。
- 导入路由前包裹 `spawn` 与 `readFile`/`stat`/`readdir` 并 `syncBuiltinESMExports()`。
- 场景：首屏、常规刷新、空信息刷新、翻页、`hooksState`、8 个仓库的 `loadReposSync`、缓存命中（连发两次，第二次应为 0 进程）。
- 输出：每个场景的 `ms / git 进程数 / fs 次数 / 命令明细`。

## 度量方法

在导入宿主路由之前包裹 `node:child_process` 的 `spawn` 与 `node:fs/promises` 的 `readFile`/`stat`/`readdir`，调 `module.syncBuiltinESMExports()` 让 ESM 具名导入看到替换，再经真实路由 handler 发命令。每个场景前发 `invalidateCache` 并冷却 350ms，越过 `runGit` 的 200ms 结果缓存。

采样要求：每场景前 `invalidateCache`，采样间隔大于 `runGit` 的 200ms、快照的 500ms 与仓库信息的 60s 有效期；仓库信息类场景用 `noCache` 或先作废。

## 一次取数的构成（改造前基线）

| 场景 | git 进程 | 墙钟 |
|---|---|---|
| `git config --get core.hooksPath` | 1 | 46.1ms |
| `git status --porcelain=v2 --branch -z -uall` | 1 | 51.2ms |
| `git for-each-ref`（分支同步） | 1 | 62.1ms |
| `loadRepoInfo`（`for-each-ref` + `config --list`） | 2 | 63.7ms |
| `git log`（200 条窗口） | 1 | 49.7–56.9ms |
| 首屏：`loadCommits(withRepoInfo)` ∥ 工作区快照 | 4 | 67.4ms |
| 刷新：`loadCommits`（已知仓库信息）∥ 快照 | 3 | 67.1ms |
| 刷新：空信息仓库（反复带 `withRepoInfo`） | 4 | 78.3ms |
| 翻页（`skip=200`） | 2 | 67.5ms |
| 仓库树 `loadReposSync`（8 个仓库） | 16 | 16.7ms（路径不存在，失败快） |
| 缓存命中（提交图窗口 / 快照有效期内） | 0 | 1.2ms |

一次刷新（提交图 ∥ 快照，冷态）的文件读取：`HEAD` × 3、`commondir` × 3、当前分支引用 × 2、`.git` stat × 7、`MERGE_HEAD` stat × 1、`worktrees` readdir × 1。

单进程固定开销 46–62ms，墙钟由最慢的那个进程决定；进程数影响的是 CPU 占用与并发压力。因此优化分两类 —— 刷新路径的**并行进程数**，以及重复的 **fs 解析**。

## 改造后实测

`node scripts/bench-git-info.mjs . 3`（同一台机器、同一检出、3 轮均值）：

| 场景 | git 进程 | 墙钟 | fs 次数 | fs(.git) | 明细 |
|---|---|---|---|---|---|
| 首屏：提交图（`withRepoInfo`）∥ 快照 | 4 | 79.1ms | 13 | 13 | `for-each-ref` / `config` / `status` / `log` |
| 常规刷新：提交图（已知信息）∥ 快照 | **2** | 66.5ms | 8 | **8** | `status` / `log` |
| 空信息仓库刷新：空远程与空贮藏 ∥ 快照 | **2** | 68.9ms | 8 | 8 | `log` / `status` |
| 翻页（`skip=200`） | **1** | 62.8ms | 5 | 5 | `log` |
| `hooksState` 首次 | 1 | 53.1ms | 5 | 3 | `config core.hooksPath` |
| 8 个仓库的 `loadReposSync` | 16 | 232.8ms | 0 | 0 | `for-each-ref` × 8 + `symbolic-ref` × 8 |
| 缓存命中：同一窗口的第二次取数 | **0** | 1.2ms | 2 | 2 | — |
| 钩子探测命中：第二次 `hooksState` | **0** | 1.0ms | 5 | 3 | — |

8 个仓库一行的墙钟与基线不可比：基线用的是不存在的路径（失败即返回），这里是真的空仓库（两个子进程都要跑完）。

## 改造前的浪费清单

- **空仓库信息反复取**：只在远程与贮藏非空时记住已知信息。无远程、无贮藏的仓库因此每次都带 `withRepoInfo`，多起一次 `config --list`（实测 4 进程 / 78.3ms，对照 3 进程 / 67.1ms）。
- **钩子探测每次都起进程**：每次换仓库都跑 `git config --get core.hooksPath`；同一份 `core.hooksPath` 已由仓库信息批的 `config --list` 读出。
- **提交图每次都枚举引用**：为提交图单独跑 `for-each-ref`，而标注只需要窗口内提交上的引用。`git log --decorate=full` 的 `%D` 已给出。
- **布局解析重复**：一次刷新里 `resolveGitDir` / `resolveGitCommonDir` 各跑三次，全部现读现用，无缓存。
- **打包引用整读整扫**：当前分支引用为 packed 时，`readRefHash` 每次都读完整个 `packed-refs` 再线性扫描；一次刷新两次。
- **只读命令不参与在途复用**：`if (cacheable)` 把在途查找与结果缓存绑在一起，`status` / `diff` / `ls-files` 既不入缓存也不复用子进程。
- **多仓库取数无并发上限**：对每个仓库各起一个 `for-each-ref`；首屏的仓库树一次下发全部路径。
- **选中节点触发全量取数**：依赖含 `selectedId`，同仓库内改变选中即走一次重新取数。
- **刷新丢失当前分支名**：`loadGraph` 的 `head` 只取 `repoInfo.head`；刷新时 `withRepoInfo` 为 false，`state.head` 变 null，当前分支标记降级为普通分支。
- **同步状态每轮换 Map**：每次刷新新建 Map，仓库行区域跟着重渲染。

## 参考实现

参考 `E:\GitHubCode\98Ref\03Windows\vscode\extensions\git\src`，只取模式，不复制代码。

| 参考 | 模式 | 落点 |
|---|---|---|
| `cache.ts` `LRUCache` | 有界缓存：`limit + ratio` 淘汰，`peek` 不改次序 | 仓库事实层与新增缓存的容量规则 |
| `decorators.ts` `throttle` | 同一 promise 合并重复调用 | 只读在途复用 |
| `decorators.ts` `sequentialize` | 按对象串行化 | 不改（写命令已由面板忙碌分级承担） |
| `decorators.ts` `debounce` | 高频调用合并 | 不改（客户端冷却已等价） |
| `util.ts` `Limiter` | 并发上限队列 | `createLimiter` |
| `repository.ts` 的 `status()` 上的 `throttle` | 并发 status 合并为一个 | 只读在途复用 |
| `repository.ts` 的 `getStatus` | 截断上限 + 耗时统计 | 已有 `STATUS_LIMIT`，不新增 |
| `repository.ts` 的 `updateModelState` | 一次更新内并行 status 与 refs，复用 HEAD/remotes/worktrees 字段 | 布局复用、引用标注并入日志 |
| `repository.ts` 的文件变化链 | debounce → throttle → status，完成后静默 5s | 已有 5s 冷却，不改 |
| `repository.ts` 的 `DotGitWatcher` | 只监视 git 目录首层并过滤 `index.lock` | 非目标 |
| `repository.ts` 的工作区监视 | 过滤 `.git` | 既有 `repo-watcher` 的判据一致 |
| `model.ts` 的 `Limiter(5)` | 限制多仓库初始 status | `createLimiter` |
| `git.ts` 的 `spawn` | 每次显式注入语言与分页环境 | 已有 `gitEnvironment`，补对象复用 |
| `git.ts` 的 status 环境 | 只给 status 加 `GIT_OPTIONAL_LOCKS=0` | 现状一致（`git-environment.test.mjs` 已覆盖） |
| `git.ts` 的取消信号 kill 子进程 | 取消即终止 | 非目标 |

## 公共接口与数据流变化

- 新增模块 `source-control/repo-facts.ts`；新增导出 `child-process.ts` 的 `createLimiter`、`host-cache.ts` 的 `readHooksPath` / `writeHooksPath`。
- 只增字段：`loadCommits` 响应的 `branch`；客户端 `GraphData` 的 `infoKnown`。
- 宿主 `LOG_FORMAT` 字段数 6 → 7，同时删除提交图路径的引用枚举。
- **不改**：`state.json` 键、会话级键、设置项、事件流与轮询参数、`git-types.ts` 现有字段名、客户端持久化分级、写命令的执行顺序。

## 边界与失败模式

| 情形 | 处理 |
|---|---|
| 布局缓存陈旧（仓库被换成工作树或子模块、删除后重建） | 有效期 10s 封顶；读不到按 null 返回，调用方已有兜底 |
| `packed-refs` 被重写 | `mtimeMs + size` 守卫；`pack-refs`、`gc`、`fetch` 都会改这两项 |
| 写命令被在途复用 | 不可能：复用只对 `readOnly` 生效，测试断言并发写命令各起一个进程 |
| 客户端中止后宿主仍在跑 | 由在途复用吸收；下一次同参请求直接命中该进程 |
| 仓库信息读取失败 | `infoKnown` 保持 false，不回记，避免把失败当事实固化 |
| 仓库无提交 | `loadReposSync` 的 `symbolic-ref` 回退路径不变，同样受限流 |
| 分离头指针 | 无 `HEAD ->` 装饰，`branch` 为 null，`head` 为哈希，与现状一致 |
| 窗口外的引用 | 本就不标注（`assembleCommits` 只在窗口内查表），装饰不改变这一点 |
| 隐藏的远程 | 装饰按 `refs/remotes/<name>/` 前缀过滤，与 `parseRefs` 同规则 |
| git 不在 PATH | `code: -1` 路径不变，事实层返回 null |

## 假设

- 面板一次刷新仍是两路 HTTP（提交图与工作区快照），形状不变。
- git 不低于 2.18（`--decorate=full` 与 `%D`），`status --porcelain=v2` 的现状依赖不变。
- Node 不低于 22；Windows 与 POSIX 行为一致。
- 度量数字取自本机，判定以 `bench-git-info.mjs` 在同一仓库上的复现值为准。

## Testing

| 文件 | 内容 |
|---|---|
| `test/fetch-path.test.mjs` | 真实路由 + 子进程计数：常规刷新恰 2 个进程；空信息仓库二次刷新不再起 `config --list`；并发两次快照只起 1 个 `status`；`hooksState` 两次只起 1 个 `config --get`；并发两次写命令仍起 2 个进程；响应 `branch` 与 `git symbolic-ref --short HEAD` 一致 |
| `test/repo-facts.test.mjs` | 临时仓库（含 `git pack-refs --all` 的打包态）：`repoHeadHash` 与 `git rev-parse HEAD` 一致；二次调用只读一次 `packed-refs`；提交后失效；祖先与后代前缀的失效范围；有效期归零等于关闭 |
| `test/git-parse.test.mjs` | `parseDecorations`：`HEAD ->`、`tag:`、多引用、含逗号的名字、空装饰；装饰组装与 `for-each-ref` 组装逐条一致 |
| `test/host-cache.test.mjs` | `hooksPath` 命中与 `invalidateRepo` 失效 |

既有 `refresh-verify`、`snapshot`、`api-commands`、`repo-discovery`、`worktree-branches` 必须仍绿。不断言界面文案。

## Alternatives considered

**把「提交图 + 快照」合并成一次请求。** 否决：两路已并行，合并会让更改区不再先出，并改动客户端契约。

**改轮询与事件语义、新增 `.git` 文件监视。** 否决：`repo-watcher.ts` 已因事件风暴明确不监视 `.git`，参考实现的 `DotGitWatcher` 需连事件语义一起改，另案。

**做请求级子进程终止。** 否决：与在途复用叠加时，abort 后紧接的同参重发会命中同一进程，终止反而多付一次启动开销。

**做仓库行领先/落后的周期刷新。** 否决：客户端按 `syncedIds` 只取一次即可，周期刷新会持续压上子进程。

**引入流式 status 解析并早停。** 否决：未跟踪 10 万文件时全量 171.3ms，读到 1000 / 10000 条即 kill 为 178.3 / 175.8ms —— git 需要先排序再输出，截断只省界面条目数不省时间。

**改 `state.json`、设置项、持久化分级、`diff/` 与 `ui/` 组件。** 否决：与取数无关，需另立项目。

## Consequences

收益：常规刷新的 git 子进程由 3 降到 2，`.git` 文件读取由 17 次降到 8 次，钩子探测与缓存命中路径降到 0 个子进程，空信息仓库不再重复取仓库信息。

代价：多出仓库事实层与钩子路径两层缓存，各自的失效判据要随写命令维护；`LOG_FORMAT` 字段数变化让解析层与测试同步改动；在途复用把「客户端中止」与「宿主进程存活」解耦，理解成本高于逐请求起进程。
