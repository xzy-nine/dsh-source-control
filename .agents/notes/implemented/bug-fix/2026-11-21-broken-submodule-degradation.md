# Agent Note: 子模块模块目录损坏时的取数降级

Status: implemented

## Problem

某个子仓库的模块目录（`.git/modules/<名>`）缺失或残缺时（只剩 `config` 与 `objects`，`HEAD`、`refs`、`index` 都不在），git 把整条 `status` 与 `diff` 判成失败。诊断文案随平台不同：

```
# Windows
fatal: not a git repository: lib/googletest/../../.git/modules/lib/googletest
# Linux
fatal: gitfile does not point to a valid repository: googletest/.git
```

退出码 128。受影响的不只是一条提示：`getWorkingTreeSnapshot`、`loadWorkingTree`、`getStatus`、`diffHunksOf` 与 `loadMergeContents` 等取数路径全部失败，更改区因此读不出任何改动，差异页也打不开——而仓库本身完全可用，`git log`、`for-each-ref`、`rev-parse` 都正常。

顺带暴露的第二个缺口：快照命令在仓库可用、工作区读不出来时把错误放在 `error` 字段回投（空条目 + 错误文本），而客户端 `loadWorkingTreeSnapshot` 从不读这个字段，于是失败被当成「没有改动」吞掉；`refresh('full')` 又在开头把 `phase` 与 `entriesPhase` 置成 loading 并清空列表，失败路径只调 `reportError` 而没有把两者写回。结果是手动刷新失败一次之后，更改区永久停在占位骨架上，再刷也只会得到同一份占位。

## Decision

降级只发生在这一种失败上，正常仓库的取数口径不变。

`submodule-failure.ts` 提供判据与参数改写：`isBrokenSubmoduleFailure` 认两种带路径的诊断——Windows 的 `fatal: not a git repository:` 且路径落在 `.git/modules/` 下，Linux 的 `fatal: gitfile does not point to a valid repository:` 且路径指向子模块的 `.git`；不带路径的同类诊断属于别的问题（工作目录不在仓库里），降级对它无效，因此不命中。`withIgnoredSubmoduleDirt` 把 `--ignore-submodules=dirty` 插在路径分隔符 `--` 的紧前位置，已有该口径时原样保留。

`git-exec.ts` 的 `gitOrThrow` 是唯一的降级点：失败命中该形态时按改写后的参数重跑一次，成功则记一条告警并返回其输出，失败仍抛原始错误。所有 `status` / `diff` 取数都经它，因此不需要在每个调用点各写一遍。

取 `dirty` 而非 `all`：已提交的 gitlink 移动（子模块指向的提交与索引不一致）属于本仓库的改动，必须照常报出；不再探测的是子模块工作树内部的脏与未跟踪文件，而探测它们正需要那个缺失的模块目录。

另外两处补齐：客户端 `loadWorkingTreeSnapshot` 把非空 `error` 当失败抛出；`use-graph-data.ts` 的两条刷新路径共用 `errors.ts` 的 `reportRefreshFailure`，失败时把相位写回已结束并上报原因。

移动端入口与正常仓库都不受影响：`--ignore-submodules=dirty` 只在重跑时出现，检查器用真实损坏仓库与正常仓库两种夹具各验证一次。

## Alternatives considered

**统一给所有仓库加 `--ignore-submodules=dirty`。** 否决：口径统一、实现最短，但会永久失去「子模块内部有未提交改动」这条提示，而大多数仓库并不坏。降级只在失败时发生，坏一次修一次，正常仓库的语义保持不变。

**解析 `.gitmodules` 并逐个探测模块目录，只对坏的那些传 `-c submodule.<名>.ignore=all`。** 否决：最精确，但要新增一套探测，且每次取数多一遍文件系统检查；命中率极低（模块目录损坏本身是异常状态），为它让每次刷变更慢不划算。

**在宿主侧把这类失败降级成「空快照 + 提示」。** 否决：空快照会让用户以为自己没有改动，而实际改动都在，只是读不出来；这是把数据缺口伪装成事实。切到 `dirty` 口径后能读到的是真实条目，只有子模块内部那部分不可知，且这一点由界面说明。

**只在客户端把 `error` 当失败、不改宿主的降级。** 否决：那样只是把「空白」换成「失败弹窗」，用户仍然看不到自己的改动。两件事都要做：取数要能读出来，失败也要能被看见。

## Consequences

**收益**：模块目录损坏的仓库重新可用，更改区、差异页与分段暂存都恢复正常；只有子模块工作树内部的未提交改动不可见，这一条写进功能说明。刷新失败不再把两个分区钉在占位上。

**代价**：

- 一次失败要多起一个 git 子进程。只在该形态失败时发生，正常路径没有额外开销。
- 判据是文本匹配。git 改这句诊断的措辞时降级会失效——但它同时也会让「不命中即照常报错」，失效方向是保守的。判据集中在 `submodule-failure.ts` 一处，便于跟进。
- 模块目录损坏期间，子模块内部的未提交改动不可见；它不进入条目列表，也不进入提交框的改动集合。

## Testing

- `test/submodule-failure.test.mjs`：判据的六种输入（含不命中的三类）；`--` 前后位置与已有口径的保留；用真实 git 建一个损坏模块目录的父仓库，经真实路由验证 `loadWorkingTreeSnapshot` 回 `error: null` 且列出本仓库自己的改动、HEAD 仍读到。
- `test/refresh-contract.test.mjs`「刷新失败：相位不留在 loading，错误照常上报」：夹具把快照回成「空条目 + error」，断言 `phase` 与 `entriesPhase` 都回到 `ready`、错误写进状态，恢复后能重新取回数据。
- 两条降级用例在移除 `gitOrThrow` 的重跑分支后退红；相位复位用例在移除 `reportRefreshFailure` 调用后退红。
