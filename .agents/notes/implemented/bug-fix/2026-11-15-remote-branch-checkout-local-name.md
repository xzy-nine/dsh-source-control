# Agent Note: 远程分支检出按远程命名本地分支

Status: implemented

## Problem

两个远程仓库有同名分支时，插件到不了另一个远程的分支。典型形态是 `origin` 指向自己的 fork、另一个远程指向别人的 fork、两边都有 `main`：提交行「签出到」把 `other/main` 折成短名 `main` 后跑 `git checkout main`，本地已有 `main`（跟踪 `origin/main`）时 git 检出的正是这个本地分支，用户静默落在自己的 fork 上；本地没有 `main` 时同一条命令在多个远程都有 `main` 的仓库里以 `fatal: 'main' matched multiple (2) remote tracking branches` 失败。

引用标记的「检出远程分支…」跑 `git checkout -b main other/main`，本地已有 `main` 时以 `fatal: a branch named 'main' already exists` 失败，同样到不了另一个远程的 `main`。

## Decision

检出远程分支一律显式给出远程引用：`git checkout -b <本地名> <远程名>/<分支名>`。本地名按远程决定（`src/client/panel/github.ts` 的 `localNameForRemoteBranch`）：`origin` 用去掉远程名的短名，其余远程用 `远程名/分支名`，同名的多个远程分支因此各有本地分支。提交行「签出到」的远程分支项与引用标记的「检出远程分支…」都按这一条规则取名，「检出远程分支…」的输入框预填该名并可改，「从远程分支创建本地分支…」的预填名同源。

本地已有该名字的分支时 git 拒绝 `-b`，检出回落到该分支，仅当它的上游正是这个远程分支（`src/source-control/git-actions.ts` 的 `branchUpstream` 比对 `%(upstream:short)`）；上游是别的远程或没有上游时原样返回冲突，界面按既有的 `already exists` 文案说明，不换分支。

本地分支名与远程跟踪引用同名后，git 把该短名判为歧义并按 `refs/heads` 优先解析，同时把上游报成多一层前缀的 `remotes/other/main`。插件在两处统一处理：宿主解析层（`src/source-control/git-parse.ts` 的 `upstreamShortName`，`parseBranchSync` 与 `status-parse.ts` 共用）把上游收敛成 `远程名/分支名`；交给 git 的引用写成完整引用——取数起点（`src/client/panel/refs.ts` 的 `filterBranchesOf`）用 `refs/heads/…` 与 `refs/remotes/…`，同步与整体覆盖（`src/client/panel/use-remote-sync.ts` 的 `remoteTrackingRef`）用 `refs/remotes/…`，远程标记的合并与变基（`src/client/panel/menu/shared.ts` 的 `remoteRefOf`）在存在同名本地分支时才用 `refs/remotes/…`。

## Alternatives considered

**本地已有同名分支时弹窗问「改名新建」还是「重置本地分支到远程」。** 否决：破坏性的那一支会覆盖用户自己的分支；按远程命名后同名冲突只在用户手工造出这类名字时出现，报冲突足够。

**只把提交行的远程分支项改成传完整远程引用，本地名仍用短名。** 否决：这只能把静默切错换成 `already exists` 失败，用户仍然到不了另一个远程的分支。

**本地名统一加连字符前缀（如 `other-main`）。** 否决：改了 `origin` 之外每一个远程分支的本地名，与 git 的 `远程名/分支名` 记法不一致。

**用 `checkout.defaultRemote=origin` 让 git 自己挑。** 否决：它只决定挑哪个远程，多个远程下的短名仍然歧义，而且改的是用户仓库的配置。

**本地名与远程跟踪名同名时，所有远程标记操作一律用完整引用。** 否决：没有同名本地分支时也会改变 git 生成的合并提交信息（`Merge remote-tracking branch 'refs/remotes/origin/main'`），因此只在同名本地分支确实存在时才用完整引用。

## Consequences

用户点 `other/main` 得到本地分支 `other/main`，两个 fork 的 `main` 在本地并存且可分辨；`origin` 之外的分支首次检出时多出一个前缀段，习惯短名的人要在输入框里改。

取数起点与同步用的引用带上了 `refs/heads/` 或 `refs/remotes/` 前缀，宿主按原样交给 `git log`。上游一律记作 `远程名/分支名`，仓库树与图形区的上游提示因此仍按短名显示。
