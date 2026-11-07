# Agent Note: 取数路径按仓库根判定，不向上查找

Status: implemented

## Problem

仓库树里的子模块行会显示出父仓库的分支与检出提交；选中一个尚未检出的子模块时，图形区显示的是父仓库的提交图，而父仓库那一行的内容反而落到别处。

根因是「从某个路径定位它的仓库」这件事有两个语义不同的答案，代码里只有前者：

- **向上查找**（`resolveGitDir`）：从该目录起逐级找 `.git`，语义是「这个路径属于哪个仓库」。git 自身即以这种语义工作。
- **该目录自身是不是仓库根**（`gitDirAt`）：只看该目录下有没有 `.git`，语义是「这个路径本身是不是一个仓库」。

未检出的子模块目录在工作区里不存在或为空，向上查找必然命中外层仓库。于是 `loadRepoSync`、`repoHead`、`loadWorkingTreeSnapshot` 的仓库判定与 `repo-watcher` 的登记全部落在父仓库上：子模块行拿到父仓库的分支，选中子模块时的取数目标拿到父仓库的 `HEAD` 与提交。仓库树里的节点路径一律是仓库根，向上查找对它们没有额外好处，只带来串数据的可能。

## Decision

两处判据都改为「该路径自身是不是仓库根」。

`worktree-branches.ts` 新增 `isRepoRoot(dir)`：`gitDirAt(dir) !== null`，或该目录自身是裸仓库的 git 目录。命令层的 `isRepoPath` 与 `repo-sync.ts` 的 `loadRepoSync` 用它，因此未检出的子模块得不到父仓库的分支、`HEAD` 与提交。

`repo-facts.ts` 的 `readLayout` 改用 `gitDirAt` 而非 `resolveGitDir`，因此 `repoLayout` / `repoHead` / `repoHeadHash` 对这类路径给出 `null`。

`repo-watcher.ts` 的 `arm` 先判 `gitDirAt(repo) !== null` 再解析公共目录：未检出的子模块不挂句柄，也不登记为已知仓库。

客户端的取数目标在选中节点不可用时为 `null`，不回退到工作区根。仓库树的行只在「该节点就是已加载的仓库」时使用快照的分支与检出提交，分离头指针的短哈希也取节点自己的 `head`。

未检出 → 检出是可用性翻转而非节点变化：`repo-preload.ts` 的 `syncAll` 记下上一轮每个节点的可用性，翻转成可用时把该节点移出「已取过领先/落后」集合，检出后重新取它自己的分支。

工作区里没有任何仓库、或选中的子模块尚未检出时，更改区与图形区换成空态：提交框、变更列表与提交图都不渲染，只给一句说明与一个按钮（`git init` 或初始化子模块），见 `panel/workspace-empty.ts`。

## Alternatives considered

**在调用处逐个特判子模块。** 否决：串数据的路径不止一条（同步、HEAD、快照、监视、客户端取数目标），逐处特判会漏；判据本身错在语义选择上，改一处比补五处可靠。

**给每条 git 命令加 `--show-toplevel` 比对。** 否决：判定要多起一个子进程，而这些路径判定本来只读文件系统；且它回答的仍是「属于哪个仓库」，需要再比一次结果才等价于「自身是不是仓库根」。

**保留向上查找，只在结果等于父仓库时判空。** 否决：判空条件是「解析结果来自祖先」，需要知道祖先是谁，等于把边界判定挪到调用方；同一个路径在不同调用方会得到不同答案。

**子模块未检出时不列该节点。** 否决：用户需要看到它才能初始化；隐藏后「初始化子模块」入口无处可达。

## Consequences

**收益**：子模块行与图形区只显示自己的数据；未检出的子模块显示空态并就地给出初始化入口；父仓库与其子模块的缓存、监视与订阅互不串台。

**代价**：

- 仓库的子目录不再是「可查的仓库路径」：以子目录为目标的命令回空。仓库树里的目标路径都是仓库根，因此这一变化只在手工构造的调用上可见。
- `repoLayout` 不再接受子目录，依赖它的 `getStashes`、`mergeInProgress` 与 `mergeHeadHashes` 同样只对仓库根有效。
- 判据散在两处（`isRepoRoot` 与 `readLayout`），新增取数入口时必须选对其中之一，选错会重新引入串数据。

## Testing

- `test/submodule-isolation.test.mjs`：`isRepoRoot` 对父仓库、未检出的子模块与其父目录的三档判定；`loadRepoSync` 与 `loadReposSync` 对未检出子模块回空、检出后读自己的分支；`repoHead`/`repoLayout` 回 `null`；经真实路由的 `loadWorkingTreeSnapshot` 与 `loadCommits` 回空而不回投父仓库数据；`.gitmodules` 声明移除后子模块节点消失。
- `test/repo-preload.test.mjs`「子模块从「未检出」变成「已检出」时重新取领先/落后」：可用性翻转触发重取，仓库本身沿用旧值。
- `test/workspace-empty.test.mjs`：空态判据的七种输入。
- `test/repo-facts.test.mjs`「失效按祖先与后代前缀生效」：后代条目改用自身是仓库根的目录，判据变化后仍然成立。
