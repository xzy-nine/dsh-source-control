# Agent Note: 刷新成本度量与抓取退避

Status: implemented

## Problem

本机 38 小时日志（`~/.dsh/dsh-source-control/logs`，20 个文件 / 11.47 MB / 49,705 行，14 个仓库）暴露出四类浪费，且其中一项让其余观测不可信：

- **耗时汇总的子进程计数恒为零**：`recordCommandCost` 在首条命令**完成后**才建桶并取 `gitSpawnCount(repo)` 作基线，而本轮自己的子进程早在 `spawnGit` 里计过数。15,482 轮里 12,505 轮（80%）报「git 子进程 0 个」，单命令轮次中该比例为 84%，同一行 breakdown 却列出 `loadWorkingTreeSnapshot×1=83ms`。汇总累计 10,083 个，实际 git 命令日志 21,385 条。
- **定时抓取几乎全是无效往返**：845 次 `fetch --all` 中 839 次「引用无变化」（99.3%），单次 p50 5,037 ms；当前构建窗口 42 次里 39 次无变化，占该窗口刷新墙钟 56.1%。
- **索引类写让提交图窗口白白失效**：仅索引的写命令（`add` / `restore` / `rm` / `mv` / `update-index` / `clean`）占写命令 34.8%（456 / 1,311），其中 86% 在随后 60 秒内引发同仓库提交图未命中（p50 1.1 秒），而这类写不会移动 HEAD、不会改引用与贮藏。
- **差异取旧侧有无谓的失败子进程**：`fileDiffContent` 对提交差异一律先跑 `show <hash>~1:<path>`；根提交或父提交里没有该路径时必然以退出码 128 失败一次并写下 `fatal:` 行，日志里可见 `fatal: path ... does not exist (neither on disk nor in the index)`。

并发合并超时是同一批观测的第五项：等待方在 30 秒后拿到的载荷是 `{ error: '并发合并超时' }`，面板据此弹「面板操作失败」，而合并的几条命令都是只读、重跑安全。

## Decision

### 子进程基线由请求入口取

`routes.ts` 的 `handleApi` 在解析出仓库与轮次编号之后、判定并发合并之前读一次 `gitSpawnCount(repo)`，把结果作为 `recordCommandCost` 的第五个参数交给该轮；`api/cost.ts` 的桶直接用这个值作 `spawnsAtStart`，不再在桶内取。

### 抓取退避

`panel/change-events.ts` 的 `nextAutoFetchPeriodMs(currentMs, baseMs, changed)`：无新引用时在当前值上翻倍，上限为 `max(baseMs, AUTO_FETCH_BACKOFF_MAX_SECONDS × 1000)`；拉到新引用即复位到 `baseMs`。上限取与基础周期的较大者，基础周期本身超过 30 分钟时不把用户的选择压小。

`panel/use-auto-fetch.ts` 用 `periodMs` 承载当前周期；抓取抛错不改变周期（失败不等于「远端没有新引用」）。模块级 `lastFetchAt` 记各仓库上次抓取结束时刻：切仓库或切会话会重建循环，距上次不足一个基础周期时先补足剩余时间，来回切换因此不再各触发一次完整抓取。手动抓取走面板的 `run('network')`，不经本 hook。

### 写操作按影响面作废

`git-exec.ts` 的 `WriteSurface` 为 `'history' | 'index'`；`writeSurfaceOf(args)` 只在子命令属于 `add` / `restore` / `clean` / `rm` / `update-index` / `mv` 时判 `index`，其余（含未知子命令）为 `history`。`onRepositoryWrite` 的监听者收到 `(repo, surface)`。

`host-cache.ts` 的 `invalidateOnWrite(repo, surface)`：`index` 只清工作区快照（仍按祖先与后代、以及 `noteRepoCommonDir` 登记的共享公共目录覆盖），`history` 全清。`repo-facts.ts` 的布局缓存只在 `history` 时作废。`routes.ts` 的 SSE 广播不区分影响面 —— 无论哪种写，面板都要重取工作区。

### 并发合并超时改为自行执行

`api/coalesce.ts` 的 `waitCoalesced(inFlight, timeoutMs)` 等到载荷或超时；超时返回 `null` 而不是错误载荷。等待方拿到 `null` 时改为自己执行一遍（合并集合只含只读命令），发起方仍按原超时清理在飞项。

### 差异旧侧先问父提交

`api/misc.ts` 的提交差异分支先用 `rev-parse --verify --quiet <hash>^` 判定父提交；无父提交时不跑 `show`，`oldText` 为 `null`，并把该判定传给 `diffHunksOf`，使其以提交自身为旧侧（与 `git-query.ts` 的 `getCommitDetails` 一致）。`rev-parse` 属查询型命令，非零退出不记警告，且只读结果有 200 ms 缓存。

## Alternatives considered

**把退避上限固定为 15 分钟。** 否决：用户已把基础周期设到 30–60 分钟时，固定上限会把设置压小；上限与基础周期取较大者才能两种情形都成立。

**对 `restore` 单独判定 `--staged`。** 否决：不带 `--staged` 的 `restore` 只改工作区、同样不碰 HEAD 与引用，两者对缓存的影响一致，无需再分一档。

**让 `index` 也作废仓库信息。** 否决：索引写不改变分支、远程与贮藏，`for-each-ref` 与 `config --list` 的结果不受影响。

**超时仍回错误载荷，只在客户端把它翻译成「重试」。** 否决：客户端拿不到「安全重跑」的判据，且错误文本已按用户可见失败上报；在宿主侧自行重跑更短、更准。

**对差异取旧侧只加 `try/catch` 不先判定。** 否决：那正是现状 —— 失败被吞掉，但子进程与 `fatal:` 日志已经产生。

## Consequences

**收益**：耗时汇总的子进程数与实际 spawn 一致，后续性能判断有了可信口径；抓取在无新引用时按倍数后延，把该轮窗口里 56% 的墙钟压向设置的下限；仅索引写不再清掉仍有效的提交图窗口与仓库信息；根提交与「父提交里没有该路径」不再产生失败子进程与 `fatal:` 日志；并发合并超时不再作为用户可见失败出现。

**代价**：

- 退避把「远端有新提交」的发现延迟推到最多 30 分钟，前提是没人手动抓取、窗口重新聚焦也没拉到新引用；事件驱动的刷新与兜底轮询不依赖抓取，工作区变化仍即时可见。
- 影响面判定以子命令白名单为依据，白名单只覆盖确认不改引用的六个子命令，未知子命令按 `history` 处理 —— 误判方向是「多清一次」，不是「读到旧窗口」。
- 超时后等待方会重跑一次只读命令，最坏情形下慢仓库上多一份并发读；发起方仍在跑，两者结果落进同一份缓存，不累积。
- 差异旧侧多一次 `rev-parse`，仅在打开提交差异时发生，不在刷新路径上。

## Testing

- `test/fetch-path.test.mjs`：「耗时汇总的 git 子进程数与实际 spawn 一致」读隔离日志的 `perf` 行比对 spawn 计数（把桶内基线改回完成时取值即变红）；「仅索引写之后提交图窗口仍然命中」断言 `log` 为 0、`status` 为 1（把 `index` 分支短路即变红）。
- `test/host-cache.test.mjs`：「索引类写只清工作区快照，保留提交图与仓库信息」与「索引类写同样按祖先与公共目录覆盖快照」。
- `test/change-events.test.mjs`：「抓取退避：无新引用翻倍，封顶后不再涨，有变化复位」与「基础周期已超过上限时按设置走，不压低」（把函数改成恒返回基础周期即变红）。
- `test/coalesce.test.mjs`：等待、超时返回 `null`、超时后在飞项仍跑完、默认上限 30 秒。
- `test/file-diff-content.test.mjs`：根提交、父提交里没有该路径、两提交对比三种情形；第一条断言 `rev-parse` 探针替代了那条注定失败的 `show`（把探针短路即变红）。

## Related

[取数性能与缓存分层](2026-10-28-fetch-performance-and-cache-layers.md) 是本决策的前一轮；[第二轮余量](../../proposed/architecture/2026-10-28-fetch-performance-round-two.md) 的 R1「写命令按影响面分级作废宿主缓存」在本记录里落地，该提案仍保留 —— R2 / R3 等其余候选项尚未实施。
