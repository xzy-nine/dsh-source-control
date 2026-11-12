# Agent Note: 浅克隆的恢复按远程配置逐项回退

Status: implemented

## Problem

克隆支持浅克隆，仓库树与提交图却对这件事一无所知：一次 `--depth=1 --single-branch --no-tags` 克隆之后，图形区只剩一个提交，其它分支与标签完全不在引用集合里，用户既看不出历史被截断，也没有回到完整克隆的入口。

补全历史不能只跑 `git fetch --unshallow`。浅克隆由三处设置共同截断，其中两处是持久配置，一次 `--unshallow` 之后仍然生效：

- 公共目录下的 `shallow` 文件记录被截断的历史起点，这是「浅克隆」本身；
- remote 的 refspec 被 `--single-branch` 收窄成只含一条分支，历史补齐后其它分支依然抓不到；
- `remote.<name>.tagopt` 被 `--no-tags` 设成 `--no-tags`，此后每次抓取都不跟随标签，已创建的标签也不会回来。

实测一次 `fetch --unshallow` 之后 `git branch -a` 仍只有那一条分支、`git tag` 仍为空，配置原样保留。只做这一步就是把「历史已完整」这个结论说早了一半。

## Decision

恢复入口在仓库行的右键菜单，只对浅克隆的仓库出现；菜单项为「恢复完整历史」，忙碌影响面按 `network` 记录，成功后重取仓库树使入口消失。

浅克隆状态由 `worktree-branches.ts` 的 `isShallowClone` 判定：读公共目录下的 `shallow` 文件，纯文件系统，不调用 git。工作树与子模块共用所属仓库的公共目录，因此工作树行沿用同一结论；未检出的子模块没有自己的 git 目录，不标浅克隆。该状态随仓库节点以 `shallowClone` 下发，宿主 `repo-node.ts` 与客户端 `shared/types.ts` 同形。

恢复本身在 `git-actions.ts` 的 `restoreFullHistory`，按远程逐个执行三步：

1. `git remote set-branches <remote> '*'` 把 refspec 还原成全部分支；已经跟踪全部分支的远程不动，避免改写用户自己的 refspec。
2. `git config --unset-all remote.<remote>.tagopt` 清掉 `--no-tags`；未配置该项的远程本就跟随标签，不动它。
3. `git fetch --unshallow --tags <remote>`。所有远程共用同一份历史，因此只有第一个远程需要 `--unshallow`，其余执行普通 `git fetch --tags`。

是否需要 `--unshallow` 按仓库当前状态判定而不是按循环次数：已经完整的仓库再跑它会得到 `fatal: --unshallow on a complete repository does not make sense`，而入口在恢复成功前一直可见，重复点按必须走普通抓取那条路径。

没有远程时如实报错而不是静默成功：`git fetch --unshallow --all` 在无远程的仓库上以退出码 0 结束却不改动任何东西，界面因此会把「什么都没发生」当成完成。

## Alternatives considered

**只跑 `git fetch --unshallow`。** 否决：截断的历史补回来了，分支与标签仍然看不到，而后者正是浅克隆最刺眼的表现；用户会以为功能没生效。

**在克隆处改用 `--no-single-branch`、去掉 `--no-tags`。** 否决：这两项本来就是为了「只取需要的那一点」而加的，去掉即让浅克隆退化为按分支名的完整抓取，与浅克隆的目的相反。

**针对每个远程都跑一次 `--unshallow`。** 否决：第二次起必定失败（历史已完整），多远程仓库因此永远报错。

**恢复后自动抓取一次完整引用。** 否决：`--unshallow` 本身已经取回引用，多一轮抓取只增加一次远端往返。

**在设置面板里给出恢复入口。** 否决：恢复只作用于某一个仓库，而设置面板是全局与当前仓库混合的面；仓库行的右键菜单已经是「作用于这一行仓库」的既有归属。

## Consequences

**收益**：浅克隆在仓库树上可见（行内「浅」标记），并且可以就地恢复成完整仓库；恢复后分支、标签与完整历史一并回来，不需要用户手写 git 命令。

**代价**：

- 恢复会改写该仓库的远程配置（refspec 与 `tagopt`）。用户若曾把 refspec 手工改成别的范围，恢复会把它覆盖成全部分支；这个代价换的是「恢复到接近完整克隆」这一明确语义。
- 历史补齐与分支抓取的耗时随仓库规模增长，期间没有进度反馈，只有网络影响面的忙碌状态。
- `shallow` 文件是浅克隆状态的唯一判据：手工删除该文件会让入口消失，而仓库的实际状态未必随之改变。

## Testing

- `test/shallow-clone.test.mjs`：仓库树标出浅克隆、完整克隆不标；链接工作树沿用所属仓库的状态；`unshallow` 命令补全历史并把 refspec 与 `tagopt` 还原；在完整仓库上重复调用不报错；没有远程时回投可读失败且保持浅克隆；非仓库路径直接回未变化，不起 git 子进程。
