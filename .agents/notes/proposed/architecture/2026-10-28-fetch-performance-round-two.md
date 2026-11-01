# Agent Note: 取数性能的第二轮余量

Status: proposed

## Problem

第一轮取数优化（见 [取数性能与缓存分层](../../implemented/architecture/2026-10-28-fetch-performance-and-cache-layers.md)）落地后，复核参考实现仍发现若干余量。本节记录待办与依据。复核对象与第一轮是同一份参考实现；度量方法同第一轮，「合成仓库」用 `git fast-import` 造历史、批量写文件造未跟踪与重命名，用于放大单个成本项。

## Proposal

### 复核结论

已对齐、不再改动：`HEAD` / 工作树 / 子模块 / 贮藏探测走文件系统（对应 `getHEADFS`、`getWorktreesFS`、`getSubmodules`，本插件为 `repo-facts.repoHead`、`worktree-branches.readWorktrees`、`submodule-parse`）；只读命令注入 `GIT_OPTIONAL_LOCKS=0`；状态上限 10000（对应 `statusLimit` 默认值）；文件变化后的 debounce + throttle + 空闲/聚焦门控 + 完成后静默（本插件为 5s 冷却与 `busyRef` 门控）；同一 promise 合并与并发上限，第一轮已落地（在途复用、`createLimiter`）；有界 LRU。

明确不采用：请求级取消；`.git` 首层监视（本插件 `repo-watcher` 已因事件风暴排除 `.git`）；流式状态解析与早停（实测无收益，见下）。

### 候选项

| 编号 | 现状 | 参考 | 改法 | 预期 | 优先级 |
|---|---|---|---|---|---|
| R1 写命令按影响面分级作废宿主缓存 | 任何非只读命令结束都 `clearHostCache()`：提交图窗口、仓库信息、快照、钩子路径全清。索引/工作区类写不可能改 HEAD、引用与贮藏，却把 30 秒的窗口一并清掉 | 参考的状态常驻内存、不按需取数，无同类问题；本项为本插件自有缓存层的补漏 | `onRepositoryWrite` 携带影响面：`history`（默认，整表清空）与 `index`（只作废快照，不动提交图窗口、仓库信息与发现缓存）。`index` 的白名单是确认不改 HEAD、引用与贮藏的子命令：`add`、`restore`、`clean`、`rm`、`update-index`、`mv`；其余（含子模块的 `checkout --detach`）仍按 `history` | 索引类写之后 30 秒内的下一次全量刷新命中窗口缓存：git 进程 2→1，墙钟降到快照单路的量级（本仓库 59.4ms） | 高 |
| R2 仓库树同步只算当前分支 | `loadRepoSync` 对 `refs/heads` 全量枚举 `%(upstream:track,nobracket)`，git 为每个有上游的分支各做一次领先/落后走查，而解析只用 `*` 那一行；无提交仓库与分离头指针还要多跑一次 `symbolic-ref` | 参考的 `getBranch` 只对目标引用取 `%(upstream:track)` | 先用 `repo-facts.repoHead` 从 `HEAD` 文件取当前分支；分支存在时 `for-each-ref --format=BRANCH_SYNC_FORMAT refs/heads/<分支>`（`%(HEAD)` 仍为 `*`，解析不变）；分离头指针或分支尚未创建（无提交仓库）时直接返回 `{ branch, upstream: null, ahead: 0, behind: 0 }`，不起子进程 | 60 个带上游分支的仓库 106.2→51.8ms；8 个无提交仓库 16 进程 → 0 进程 | 高 |
| R3 `status` 不再算领先/落后 | `status --porcelain=v2 --branch` 每次算 `branch.ab`，成本随与上游的分叉深度增长 | 参考的 status 不带 `--branch`，领先/落后另取 | `loadWorkingTreeSnapshot` 增 `withSync`；false 时加 `--no-ahead-behind`（`branch.ab` 输出 `+? -?`，解析为未知），响应 `ahead/behind` 为 null，客户端沿用上次值。false 的时机：索引/工作区操作后的只取快照、事件驱动的 reconcile 刷新、兜底轮询；true：进入仓库、主动刷新、历史类写之后 | 典型仓库 0–5ms；领先 30000 的仓库 98.0→43.3ms | 中 |
| R4 首屏远程信息读配置文件 | 首屏仓库信息批跑 `git config --list -z` | 参考读公共目录下的 `config` 并用 `parseGitRemotes` 解析，失败才回退 `git remote --verbose` | 解析本地 config 取 `remote.<name>.url` / `pushurl`；文件含 `include` / `includeIf`（条件配置会改变结果）或解析失败时回退 `config --list` | 首屏 git 进程 4→3；墙钟几乎不变（配置不在关键路径） | 低 |
| R5 未跟踪文件开关 | 只能全量枚举未跟踪文件 | `git.untrackedChanges = mixed / separate / hidden`，hidden 时 status 加 `-uno` | 新增设置项「列出未跟踪文件」，关闭时加 `-uno` | 10 万未跟踪文件 171.3→46.8ms，20000 文件 69.0→51.0ms | 需另案（改可见行为与设置项） |
| R6 批量路径命令并行 | `working-tree.ts` 的 `gitInPathBatches` 逐批串行 | 参考用 `Limiter(5)` 并行下发分批路径 | 分批改成限流并行，上限 5 | 一次丢弃/暂存数千路径时墙钟按批数下降；不在刷新路径上 | 低 |

### 已核对但确认不适用

| 候选项 | 结论 |
|---|---|
| 流式状态解析 + 达到上限即 kill | 不采用：未跟踪 10 万文件时全量 171.3ms，读到 1000 / 10000 条即 kill 为 178.3 / 175.8ms —— git 需要先排序再输出，截断只省界面条目数不省时间 |
| `status.renames=false` | 不采用：2000 对近似内容重命名 53.2 vs 53.2ms（同内容与近似内容都走快速匹配） |
| `--topo-order` 改 `--date-order` | 不采用：216 提交窗口 46.4 vs 46.3ms，无可测差异；顺序语义不同，不为此改默认 |
| 给 `HEAD` / 布局再加一层短时缓存 | 不采用：一次刷新对 `.git` 的读已 8 次，单次 0.1ms 量级，低于噪声 |
| 状态超限提示与「把大目录加进 .gitignore」引导 | 不采用：界面语义变更，与取数无关 |
| reftable 仓库的 `HEAD` 解析 | 待观察：参考实现识别 `ref: refs/heads/.invalid` 后回退 `symbolic-ref` / `rev-parse`；本插件直接从 `HEAD` 文件取值，reftable 仓库同样需要回退。属健壮性问题而非取数，另案 |

### 本轮度量

同一台机器（Windows / Node 24 / git 2.55.0.windows.5），墙钟为单次命令或单次请求，取 5–7 次采样的中位数；「合成」指临时的 `fast-import` / 批量写文件仓库。

| 场景 | 变体 | 中位数 |
|---|---|---|
| 本仓库（216 提交 / 213 文件 / 上游同步） | `status --porcelain=v2 --branch -z -uall`（现状） | 46.3ms |
| | 同上加 `--no-ahead-behind` | 47.5ms |
| | `status` 不带 `--branch` | 48.1ms |
| | `log --topo-order --decorate=full`（现状，201 条） | 46.4ms |
| | `log --date-order --decorate=full` | 46.3ms |
| | `log --topo-order` 不带装饰 | 43.3ms |
| 刷新两路（本仓库，写操作后宿主缓存已清空） | 只取工作区快照（1 进程） | 59.4ms |
| | 只取提交图窗口（冷，1 进程） | 66.0ms |
| | 全量刷新（2 进程） | 67.5ms |
| | 提交图窗口命中缓存，单发 | 1.1ms |
| 合成：领先上游 3000 | 现状（含领先/落后） | 54.5ms |
| | `--no-ahead-behind` | 46.2ms |
| 合成：领先上游 30000 | 现状 | 98.0ms |
| | `--no-ahead-behind` | 43.3ms |
| 合成：未跟踪 20000 文件 | 现状 `-uall` | 69.0ms |
| | 读到 1000 / 10000 条即 kill | 84.0 / 83.6ms |
| | `-uno` | 51.0ms |
| | `-unormal` | 63.2ms |
| 合成：未跟踪 100000 文件 | 现状 `-uall` | 171.3ms |
| | 读到 1000 / 10000 条即 kill | 178.3 / 175.8ms |
| | `-uno` | 46.8ms |
| | `-unormal` | 114.9ms |
| 合成：60 个带上游分支（各领先 0–2360） | `refs/heads` 全量 + `%(upstream:track)`（现状） | 106.2ms |
| | 只取当前分支 + track | 51.8ms |
| | 只取当前分支、去掉 track | 44.6ms |
| 合成：2000 对近似内容重命名 | 默认检测重命名 | 53.2ms |
| | `-c status.renames=false` | 53.2ms |

另核对两项行为：`for-each-ref refs/heads/main` 只匹配 `main`（不匹配 `main-x`），当前分支仍是 `*`（R2 的前提）；`--no-ahead-behind` 在分叉时输出 `# branch.ab +? -?`（R3 的「未知」判据）。

### 实施顺序

1. R2（`repo-discovery.ts` + `repo-facts.repoHead`）：`test/repo-discovery.test.mjs` 增「分离头指针与无提交仓库不启动 git」「多分支仓库只枚举当前分支」，与 `git for-each-ref` 独立推导对照；`test/fetch-path.test.mjs` 的 8 仓库用例改断言 0 个 git 进程。
2. R1（`working-tree.ts` 的 `onRepositoryWrite` 影响面、`host-cache.ts` 与 `repo-discovery.ts` 的监听）：`test/host-cache.test.mjs` 增按影响面作废；`test/fetch-path.test.mjs` 增「索引类写之后 30 秒内的全量刷新只起 1 个进程」。
3. R3（`working-tree.ts` 的解析、`routes.ts` 的参数、`api/repos.ts` 与 `use-graph-data.ts` 的未知值传递）：`test/status-snapshot.test.mjs` 增 `+? -?`；`test/fetch-path.test.mjs` 增进程数与「未知不覆盖」。
4. R4 / R6 视需要；R5 单独立项（设置项与可见行为）。
5. `scripts/bench-git-info.mjs` 扩场景：写后刷新、无提交与分离头指针仓库的仓库树、领先 30000 的仓库、60 个带上游分支的仓库。
6. 全量门禁：`pnpm lint` → `pnpm typecheck` → `pnpm test`（含 `check:duplication` 与 `build`），重复基线不动。

## Alternatives considered

**一次做完 R1–R6。** 否决：R5 改可见行为与设置项，需单独立项；R4 与 R6 的收益低于噪声或不在刷新路径上，先做 R1–R3 再按度量决定。

**优先做 R4 与 R6。** 否决：两者不在刷新关键路径上，收益不可测，而 R1–R3 的收益有合成仓库的度量支撑。

**对 R2 直接删除全量枚举分支。** 否决：分离头指针与无提交仓库仍需回退路径，直接删除会让仓库树的分支与领先/落后为空。

**对 R1 用命令黑名单而非白名单。** 否决：黑名单会漏判未来新增的写子命令，未知命令按 `history` 更安全。

## Acceptance criteria

- 索引类写之后 30 秒内的全量刷新只起 1 个 git 进程。
- 多分支仓库的仓库树同步只枚举当前分支；分离头指针与无提交仓库不起 git。
- `withSync: false` 时 `ahead` / `behind` 为 null 且不覆盖客户端已有值。
- `pnpm lint` / `pnpm typecheck` / `pnpm test`（含 `check:duplication` 与 `build`）全绿，重复基线不动。
- `scripts/bench-git-info.mjs` 扩场景后复现上述度量。

## Risks

| 风险 | 控制 |
|---|---|
| R1 白名单漏判（某条命令实际改了引用或贮藏） | 白名单只放确认不改引用与贮藏的子命令；`fetch` / `push` / `commit` / `checkout` / `stash` / 分支与标签操作都不在内；未知命令一律按 `history`。窗口键含 HEAD：HEAD 真的移动时不会命中旧窗口 |
| R2 依赖 `HEAD` 文件定位分支 | 与所有缓存键同源（`repo-facts.repoHead`）；解析不到分支时退回全量枚举 |
| R3 未知值的传播 | `ahead` / `behind` 为 null 时不覆盖客户端已有值；只在明确引用未变的三处传 `withSync: false` |
| R4 漏读 `include` 配置 | 检测到 `include` / `includeIf` 即回退 `config --list` |
| R5 可见行为变化 | 新增设置项与文档，单独立项评审 |

## 附录：待评估的请求级子进程终止

参考实现的取消信号到达即 kill 子进程。本插件的客户端中止不通知宿主，子进程继续跑完。与在途复用叠加时，abort 后紧接的同参重发会命中同一进程，终止反而多付一次启动开销。评估要点：只在「无任何在途等待方」时终止，并留出重发窗口；先用 `bench-git-info.mjs` 度量「用户快速切换仓库」时的废弃进程数，再决定是否纳入。
