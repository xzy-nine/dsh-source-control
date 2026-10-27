# 「请求 → 数据到手」性能与缓存优化计划

本文覆盖面板取数的上游一段：客户端发出请求 → 宿主执行 git 子命令与直接文件读取 → 响应落在客户端状态。界面数据到 DOM 的一段见《显示到界面性能与缓存计划.md》。

## 1. 目标与判定标准

目标：把一次取数的**子进程数**、**重复的文件系统解析**、**无谓的重复取数**压到最小，并让缓存的有效期、键与作废范围同数据的实际变化频率对齐。可见行为与协议语义不变（例外仅为第 5 节列出的两个只增字段与一个格式串字段）。

判定标准（可核对；改造后按第 8 节脚本复测得数填入）：

1. 一次常规刷新（已知仓库信息）的 git 子进程数 **3 → 2**，墙钟 **67ms → ≤60ms**。
   实测：进程数 **2**（达标）；墙钟 66.5ms（未达标，见 2.2.1 末尾）。
2. 无远程、无贮藏仓库的刷新子进程数 **4 → 2**。实测 **2**。
3. 一次刷新对 `.git` 的文件读取 **17 次 → ≤8 次**。实测 **8**。
4. 同一仓库 60 秒内的钩子探测子进程数 **1 → 0**（缓存命中）。实测命中时 **0**。
5. 仓库树领先/落后取数的并发 git 上限为 5；仓库数不超过 5 时墙钟不高于现状。
   实测：6 个仓库时同时进行的取数峰值为 **5**（`test/fetch-path.test.mjs`）。
6. 缓存命中路径（提交图窗口 30 秒内）仍 ≤2ms 且 0 个 git 子进程。实测 **1.2ms / 0**。
7. `pnpm lint` / `pnpm typecheck` / `pnpm test`（含 `check:duplication` 与 `build`）全绿，重复基线不动。

## 2. 现状与本机实测

### 2.1 度量方法

在导入宿主路由之前包裹 `node:child_process` 的 `spawn` 与 `node:fs/promises` 的 `readFile`/`stat`/`readdir`，调 `module.syncBuiltinESMExports()` 让 ESM 具名导入看到替换，再经真实路由 handler 发命令（`test/repo-discovery.test.mjs:37-44` 已是同一手法）。每个场景前发 `invalidateCache` 并冷却 350ms，越过 `runGit` 的 200ms 结果缓存。

环境：Windows、Node 24、本插件检出（`git log` 窗口 200 条）。

### 2.2 一次取数的构成

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

结论：单进程固定开销 46–62ms，墙钟由最慢的那个进程决定；进程数影响的是 CPU 占用与并发压力。因此优化分两类 —— 刷新路径的**并行进程数**，以及重复的 **fs 解析**。

### 2.2.1 改造后实测

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

对照第 1 节：第 1 条的进程数、第 2、3、4、6 条达标；第 1 条的墙钟未降到 60ms 以内 —— 刷新两路并行，
墙钟由最慢的那个 git 进程决定，被删掉的 `for-each-ref` 本来不在关键路径上。第 5 条（并发上限）由
`test/fetch-path.test.mjs` 断言实测峰值为 5。8 个仓库一行的墙钟与 2.2 节的 16.7ms 不可比：那里用的
是不存在的路径（失败即返回），这里是真的空仓库（两个子进程都要跑完）。

### 2.3 现有缓存清单

| 缓存 | 落点 | 键 | 有效期 / 容量 | 作废 |
|---|---|---|---|---|
| 只读子命令结果 | `working-tree.ts:315-365` | 仓库 + `JSON.stringify(args)` | 200ms / 64 | 写命令按仓库（含祖先与后代） |
| 在途子进程 | `working-tree.ts:462` | 同上 | 同上 | 收尾即删；仅对可缓存命令生效 |
| 提交图窗口 | `host-cache.ts:78` | 仓库 + HEAD + 全部取数参数 | 30s / 64 | 写命令清空、`invalidateCache` 按仓库 |
| 仓库信息 | `host-cache.ts:80` | 仓库 + 三个参数 | 60s / 32 | 同上 |
| 工作区快照 | `host-cache.ts:82` | 仓库 + 读到的 HEAD | 500ms / 32 | 同上 |
| 仓库发现 | `repo-discovery.ts:98` | 工作区根 + 选项 | 60s / 16 | 写命令、结构事件 |
| 客户端已知仓库信息 | `use-graph-data.ts:111` | 仓库 | 模块级 / 8 | 写操作、主动刷新 |
| 客户端渲染态 | `use-graph-data.ts:35` | 仓库 | 模块级 / 8 | 写操作、主动刷新 |
| 仓库树领先/落后 | `repo-preload.ts:84` `syncedIds` | 节点 id | 会话内 | 重扫 |

缺失的部分与下一节逐条对应：布局解析、`packed-refs` 解析、`core.hooksPath`、空仓库信息的记忆、只读在途复用、多仓库并发上限。

### 2.4 已定位的浪费

- **W1 空仓库信息反复取**：`use-graph-data.ts:299-303` 只在远程与贮藏非空时记住已知信息。无远程、无贮藏的仓库因此每次都带 `withRepoInfo`，多起一次 `config --list`（实测 4 进程 / 78.3ms，对照 3 进程 / 67.1ms）。
- **W2 钩子探测每次都起进程**：`routes.ts:289-300` 每次换仓库都跑 `git config --get core.hooksPath`；同一份 `core.hooksPath` 已由仓库信息批的 `config --list` 读出（`git-query.ts:471-481`）。
- **W3 提交图每次都枚举引用**：`routes.ts:508-515`、`git-query.ts:629-633` 为提交图单独跑 `for-each-ref`，而标注只需要窗口内提交上的引用。`git log --decorate=full` 的 `%D` 已给出（实测该检出：`HEAD -> refs/heads/性能优化, refs/remotes/origin/性能优化`、`tag: refs/tags/v0.4.0`）。
- **W4 布局解析重复**：一次刷新里 `resolveGitDir` / `resolveGitCommonDir` 各跑三次（`worktree-branches.ts:338-348`、`:377-381`），全部现读现用，无缓存。
- **W5 打包引用整读整扫**：当前分支引用为 packed 时，`readRefHash`（`worktree-branches.ts:243-262`）每次都读完整个 `packed-refs` 再线性扫描；一次刷新两次。
- **W6 只读命令不参与在途复用**：`working-tree.ts:522-529` 的 `if (cacheable)` 把在途查找与结果缓存绑在一起，`status` / `diff` / `ls-files` 既不入缓存也不复用子进程。客户端中止后重发、刷新与只取快照并发时各起一个子进程。
- **W7 多仓库取数无并发上限**：`repo-discovery.ts:739-757` 对每个仓库各起一个 `for-each-ref`；首屏的仓库树一次下发全部路径，仓库多时同时压上一批 git.exe。
- **W8 选中节点触发全量取数**：`use-graph-data.ts:480` 的依赖含 `selectedId`，同仓库内改变选中即走一次重新取数。
- **W9 刷新丢失当前分支名**：`loadGraph` 的 `head` 只取 `repoInfo.head`（`api/repos.ts:253-260`）；刷新时 `withRepoInfo` 为 false，`state.head` 变 null，`use-graph-data.ts:456-458` 的 `previous.head === graph.head` 恒不成立（提交数组每轮重建），`row-model.ts:117-129` 的当前分支标记降级为普通分支。
- **W10 同步状态每轮换 Map**：`use-graph-data.ts:225-228` 每次刷新新建 Map，仓库行区域跟着重渲染。

## 3. 参考实现

参考 `E:\GitHubCode\98Ref\03Windows\vscode\extensions\git\src`，只取模式，不复制代码。

| 参考 | 模式 | 本文落点 |
|---|---|---|
| `cache.ts:473` `LRUCache` | 有界缓存：`limit + ratio` 淘汰，`peek` 不改次序 | 仓库事实层与新增缓存的容量规则 |
| `decorators.ts:39` `throttle` | 同一 promise 合并重复调用 | 4.2 的只读在途复用 |
| `decorators.ts:70` `sequentialize` | 按对象串行化 | 不改（写命令已由面板忙碌分级承担） |
| `decorators.ts:83` `debounce` | 高频调用合并 | 不改（客户端冷却已等价） |
| `util.ts:421` `Limiter` | 并发上限队列 | 4.4 的 `createLimiter` |
| `repository.ts:1175-1183` `status()` 上的 `throttle` | 并发 status 合并为一个 | 4.2 |
| `repository.ts:3111-3156` `getStatus` | 截断上限 + 耗时统计 | 已有 `STATUS_LIMIT`，不新增 |
| `repository.ts:3060-3084` `updateModelState` | 一次更新内并行 status 与 refs，复用 HEAD/remotes/worktrees 字段 | 4.1 的布局复用、4.6 |
| `repository.ts:3361-3371` | 文件变化 → debounce → throttle → status，完成后静默 5s | 已有 5s 冷却，不改 |
| `repository.ts:462-511` `DotGitWatcher` | 只监视 git 目录首层并过滤 `index.lock` | 非目标（见第 10 节） |
| `repository.ts:930-952` | 工作区监视过滤 `.git` | 既有 `repo-watcher` 的判据一致 |
| `model.ts:285`、`:698` | `Limiter(5)` 限制多仓库初始 status | 4.4 |
| `git.ts:684-718` `spawn` | 每次显式注入语言与分页环境 | 已有 `gitEnvironment`，补对象复用 |
| `git.ts:2830-2847` | 只给 status 加 `GIT_OPTIONAL_LOCKS=0` | 现状一致（`git-environment.test.mjs` 已覆盖） |
| `git.ts:218-278` | 取消信号 kill 子进程 | 非目标（附录 A） |

## 4. 实施

### 4.1 仓库事实层 `src/source-control/repo-facts.ts`（新）

对应 W4、W5。

- `repoLayout(repo): { gitDir: string; commonDir: string } | null`：进程级缓存，有效期 10s、容量 64，命中即最近使用；键为规范化仓库路径，按祖先与后代前缀作废；`stat` 失败返回 null。
- `readPackedRef(commonDir, refName): string | null`：把 `packed-refs` 解析成 `Map<引用名, 哈希>` 后缓存，以 `stat` 的 `mtimeMs` 与 `size` 作守卫，容量 8；守卫不通过即重读。
- `repoHeadHash(repo): string | null`：复用上述两项；`HEAD` 文件每次都重读 —— 它是缓存键的失效判据，不缓存。
- `invalidateRepoFacts(repo)`、`clearRepoFacts()`、`setRepoFactsTtlForTest(ms)`（0 表示关闭缓存）。
- 挂 `onRepositoryWrite` 作废目标仓库及其祖先、后代。
- 接入点：`git-query.ts:388-396` 的 `mergeInProgress`、`:330-337` 的 `getStashes`，以及 `routes.ts:240`、`:445` 两处 `readHeadHash`。`worktree-branches.ts` 保持无缓存的可单测纯实现。

### 4.2 子进程层 `src/source-control/working-tree.ts`

对应 W6。

- 在途复用的判据由 `cacheable` 改为 `readOnly`：确认只读的命令（含 `status`、`diff`、`ls-files`）共享在途子进程；结果缓存的判据不变（这三类仍不入缓存，仍现读现用）；写命令一律独立执行。
- `gitEnvironment` 按 `readOnly` 的两种形态各缓存一份对象。
- 客户端中止不终止宿主子进程：中止后的重发命中同一个在途进程，这正是收益来源。kill 属附录 A。

### 4.3 宿主缓存补齐 `src/source-control/host-cache.ts`

对应 W2。

- 新增 `readHooksPath(repo)` / `writeHooksPath(repo, value)`：键为仓库，有效期 60s，容量 32，纳入 `invalidateRepo`。
- `routes.ts` 的 `hooksState` 先读该缓存，未命中才跑 `git config --get core.hooksPath`；钩子文件是否存在仍由 `detectHooks` 现读（`hooks.ts:83-94`）。
- 不新增「仓库行领先/落后」缓存：客户端按 `syncedIds` 只取一次，属刷新语义议题，写入第 10 节。

### 4.4 并发上限 `child-process.ts` + `repo-discovery.ts`

对应 W7。

- `child-process.ts` 新增 `createLimiter(max)`：队列加在跑计数，任务成功或失败都归还额度（同 `util.ts:421` 的形态）。
- `repo-discovery.ts` 的 `loadReposSync` 走模块级 `createLimiter(SYNC_CONCURRENCY)`，常量取 5；面板的单仓库命令不入队，保持「宿主不串行化命令」。
- 注释写明作用域：只有仓库树的批量领先/落后取数限流。

### 4.5 客户端取数契约与去重

对应 W1、W8、W9、W10。

- 宿主 `loadCommits` 响应增 `branch`：当前分支名，取自同一次 `readHeadRef`，与缓存键里的 HEAD 哈希（`routes.ts:445`）是两个值。`loadGraph` 在未取仓库信息时用它填 `head`。
- `GraphData`（`api/repos.ts:163-176`）增 `infoKnown: boolean`：仅当响应确实带仓库信息且 `repoInfo.error === null` 时为真。`use-graph-data.ts` 的 `rememberFromGraph` 改按它判断，空远程与空贮藏也记下。
- `refresh` 的 `selectedId` 依赖改为读 `selectedIdRef`（`use-graph-data.ts:480`），同仓库内改变选中不再触发取数。
- `writeSync`（`use-graph-data.ts:219-229`）逐字段比较，未变时返回原 Map。

### 4.6 引用标注并进日志

对应 W3；本项替换一次 `for-each-ref`，以第 8 节门禁把关。

- `git-parse.ts` 的 `LOG_FORMAT` 末位追加 `%D`（`LOG_FIELD_COUNT` 6 → 7），`getLog` 的参数追加 `--decorate=full`。
- 新增纯函数 `parseDecorations(text)`，返回 `{ heads, tags, remotes }`：处理 `HEAD -> refs/heads/x`（既作该分支的标记，也作 HEAD 的判据）、`tag: refs/tags/x`、按「逗号 + 空格」切分（引用名不含空格）、按 `refs/heads` / `refs/tags` / `refs/remotes` 前缀过滤，`hideRemotes` 沿用 `parseRefs` 的规则。
- `assembleCommits`（`git-parse.ts:635-709`）改为接收装饰表与 HEAD 哈希；删除提交图路径的 `getRefsForGraph`、`refsInput` 与 `loadCommits` 里的引用预取（`routes.ts:508-515`、`:556`）。`loadRepoInfo` 仍用 `REF_BRANCH_FORMAT`。
- `CommitTag.annotated` 恒 false：装饰无法区分附注标签。客户端只在 `commitsEqual` 的相等判定里读它（`commit-diff.ts:51-72`），行标记不读（`row-model.ts:136-141`），`shared/types.ts:6-8` 也无该字段。
- 回退判据：同一仓库「装饰组装」与「`for-each-ref` 组装」逐条不一致，或刷新墙钟降幅不足 10%，撤回本项。

### 4.7 度量脚本 `scripts/bench-git-info.mjs`（新）

- 与既有 bench 同风格：`node scripts/bench-git-info.mjs [仓库路径] [轮数]`，依赖 `pnpm build:host`。
- 导入路由前包裹 `spawn` 与 `readFile`/`stat`/`readdir` 并 `syncBuiltinESMExports()`。
- 场景：首屏、常规刷新、空信息刷新、翻页、`hooksState`、8 个仓库的 `loadReposSync`、缓存命中（连发两次，第二次应为 0 进程）。
- 输出：每个场景的 `ms / git 进程数 / fs 次数 / 命令明细`，末段对应第 2.2 节的表格行。

## 5. 公共接口与数据流变化

- 新增模块 `source-control/repo-facts.ts`；新增导出 `child-process.ts` 的 `createLimiter`、`host-cache.ts` 的 `readHooksPath` / `writeHooksPath`。
- 只增字段：`loadCommits` 响应的 `branch`；客户端 `GraphData` 的 `infoKnown`。
- 宿主 `LOG_FORMAT` 字段数 6 → 7，同时删除提交图路径的引用枚举。
- **不改**：`state.json` 键、会话级键、设置项、事件流与轮询参数、`git-types.ts` 现有字段名、客户端持久化分级、写命令的执行顺序。

## 6. 边界与失败模式

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

## 7. 测试（`node --test test/*.test.mjs`）

| 文件 | 内容 |
|---|---|
| `test/fetch-path.test.mjs`（新） | 真实路由 + 子进程计数：常规刷新恰 2 个进程；空信息仓库二次刷新不再起 `config --list`；并发两次快照只起 1 个 `status`；`hooksState` 两次只起 1 个 `config --get`；并发两次写命令仍起 2 个进程；响应 `branch` 与 `git symbolic-ref --short HEAD` 一致 |
| `test/repo-facts.test.mjs`（新） | 临时仓库（含 `git pack-refs --all` 的打包态）：`repoHeadHash` 与 `git rev-parse HEAD` 一致；二次调用只读一次 `packed-refs`；提交后失效；祖先与后代前缀的失效范围；有效期归零等于关闭 |
| `test/git-parse.test.mjs`（扩） | `parseDecorations`：`HEAD ->`、`tag:`、多引用、含逗号的名字、空装饰；装饰组装与 `for-each-ref` 组装逐条一致 |
| `test/host-cache.test.mjs`（扩） | `hooksPath` 命中与 `invalidateRepo` 失效 |

既有 `refresh-verify`、`snapshot`、`api-commands`、`repo-discovery`、`worktree-branches` 必须仍绿。不断言界面文案。

## 8. 度量

`scripts/bench-git-info.mjs` 输出第 2.2 节七类场景的 `ms / git 进程数 / fs 次数`，与本节改造前的记录逐行对照。判定用第 1 节的七条；其中第 1、2、3、4、6 条直接读该脚本的列。

采样要求：每场景前 `invalidateCache`，采样间隔大于 `runGit` 的 200ms、快照的 500ms 与仓库信息的 60s 有效期；仓库信息类场景用 `noCache` 或先作废。

## 9. 文档

实施时同步 `AGENTS.md`：

- 「刷新耗时」表补两行：引用标注并入日志、仓库事实缓存。
- 「首屏空白」补仓库树领先/落后的并发上限与 `core.hooksPath` 缓存。
- 新增「取数与缓存」小节：三层缓存（进程级事实 / 宿主响应 / 客户端取数参数）的键与作废规则、`runGit` 在途复用的只读边界、`SYNC_CONCURRENCY`。
- 文件夹组织补 `repo-facts.ts`；测试表补两个新文件与两个扩充文件；度量表补 `bench-git-info.mjs`。

## 10. 非目标

- 不把「提交图 + 快照」合并成一次请求：两路已并行，合并会让更改区不再先出，并改动客户端契约。
- 不改轮询与事件语义，不新增 `.git` 文件监视：`repo-watcher.ts` 已因事件风暴明确不监视 `.git`，VSCode 的 `DotGitWatcher` 需连事件语义一起改，另案。
- 不做请求级子进程终止（与在途复用冲突，见附录 A）。
- 不做仓库行领先/落后的周期刷新。
- 不引入流式 status 解析：`STATUS_LIMIT` 已兜住超大仓库。
- 不改 `state.json`、设置项、持久化分级、`diff/` 与 `ui/` 组件。

## 11. 风险与回退

| 风险 | 控制 |
|---|---|
| 事实缓存陈旧导致读到旧布局 | 有效期 10s、写命令作废、失败返回 null；有效期设为 0 即退化为现状 |
| 在途复用误伤写命令 | 只对确认只读的命令生效；新增并发写命令的计数断言 |
| 装饰语义与现标注不一致 | 两种取法的逐条对照测试；降幅不足 10% 或出现差异即撤回该项 |
| 限流抬高多仓库时的墙钟 | 上限 5，只作用于仓库树；面板命令不入队 |
| 重复代码门禁 | 宿主复用 `host-cache` 的 `put`/`get`，客户端复用 `shared/cache.ts` 的 `LruMap`，不另写淘汰逻辑 |

## 12. 实施顺序（单线程，无子代理）

1. `repo-facts.ts` + `test/repo-facts.test.mjs`
2. 接入 `git-query.ts` 与 `routes.ts`（先由 bench 观察 fs 次数下降）
3. `runGit` 只读在途复用 + 计数断言
4. `host-cache` 的 `hooksPath` + 路由接入 + 测试
5. `loadReposSync` 限流 + 测试
6. 客户端契约与去重（W1、W8、W9、W10）+ `test/fetch-path.test.mjs`
7. 引用标注并入日志（第 4.6 节）+ 对照测试 + bench 门禁
8. `scripts/bench-git-info.mjs` + `AGENTS.md`
9. 全量门禁：`pnpm lint` → `pnpm typecheck` → `pnpm test`（含 `check:duplication` 与 `build`）

## 13. 假设

- 面板一次刷新仍是两路 HTTP（提交图与工作区快照），形状不变。
- git 不低于 2.18（`--decorate=full` 与 `%D`），`status --porcelain=v2` 的现状依赖不变。
- Node 不低于 22；Windows 与 POSIX 行为一致。
- 第 2 节的数字取自本机，判定以 `bench-git-info.mjs` 在同一仓库上的复现值为准。

## 附录 A 待评估：请求级子进程终止

参考 `git.ts:218-278`：取消信号到达即 kill 子进程。本插件的客户端中止不通知宿主，子进程继续跑完。与在途复用叠加时，abort 后紧接的同参重发会命中同一进程，终止反而多付一次启动开销。评估要点：只在「无任何在途等待方」时终止，并留出重发窗口；先用 `bench-git-info.mjs` 度量「用户快速切换仓库」时的废弃进程数，再决定是否纳入。
