# Agent Note: 测试执行拓扑与断言口径

Status: implemented

## Problem

测试规模到 677 个用例后，全量墙钟由两三个起真实 git 子进程的文件决定；文件内并行默认关闭，而哪些文件能并发、哪些不能，只散落在注释与用例写法里。同时，界面文案被直接写进断言：改一句提示就要改测试，测试保护的是措辞而不是行为。两类问题都让测试的维护成本随规模上升。

## Decision

执行拓扑由测试自己声明，不依赖运行器默认值。

`test/harness.mjs` 提供四个入口：`parallel(name, body)` 把不共享进程级可变状态的文件登记成一个并发组；`serial(name, fn)` 标注必须串行的单个用例；`tempPath(prefix)` 建进程唯一临时目录；`snapshotGlobals(names)` 记录并还原全局。文件级并行由运行器默认开启，文件内并行只在 `parallel` 组内发生。

依赖进程级单例（`globalThis` 桩、`process.env`、真实 `fs.watch` 句柄）或起真实 git 子进程的文件保持串行，并在文件头写明理由。`repo-discovery` 与 `api-commands` 按主题拆成两个文件，让文件级并行消化关键路径。`--test-timeout=120000` 让挂起的用例失败并指出用例名，而不是等 CI 的 job 超时。

断言口径：文案归各模块导出的常量表（`REFRESH_TEXT`、`ROW_TEXT`、`DIFF_TITLE_TEXT`、`DISCARD_TEXT`、`SSH_TEXT`、`FEEDBACK_TEXT`、`REDACT_TEXT`、`REF_FILTER_TEXT`、`OVERWRITE_PATTERNS`），测试按引用取用而不是复制文本。跨进程的拒绝原因用稳定 `code` 字段（`not-tip`、`no-branch`、`same-branch`、`unknown-command`），调用方按码分支、按文本展示。

## Alternatives considered

**把并发级别写进 package.json 的 `--test-concurrency`。** 那是全局旋钮：它无法表达「这个文件能并发、那个不能」，只能整体调大或调小。文件间共享状态的差异必须逐个文件声明。

**给所有文件一律开启并发。** 共享 `globalThis` 与 `process.env` 的文件会互相覆盖桩，表现为间歇性失败——比串行慢更糟，因为它不可复现。

**继续按文案断言，靠评审记住「不要改文案」。** 规则不可执行：改文案的人不会知道测试在钉它，直到测试变红。常量表让改文案成为一次改动，测试只在行为变化时变红。

**为 `code` 字段改造整个错误响应。** 只新增字段、保留 `error` 文本，旧调用方不受影响；按码分支是新增能力，不是替换。

## Consequences

并发组内的用例不得依赖执行顺序，也不得共用临时目录、固定端口或未还原的桩；违反时表现为偶发失败，因此新文件加入 `parallel` 前要先确认它没有进程级状态。

文案常量表增加了一层间接：改文案要改常量表而不是就地改字符串，但测试因此只在行为变化时变红。`code` 字段让宿主与客户端多一条契约要维护，代价是调用方不再依赖错误文本。

## Testing

`parallel` 组的并发行为由 `test/diff-stats.test.mjs` 等 35 个文件的执行序验证；`serial` 标注由 `test/repo-watcher-live.test.mjs` 的 7 个用例验证。全局还原由各文件的 `test.after` 兜底，跑完一次全量后 `tmpdir()` 不留本插件的隔离目录。文案口径由各模块的常量表与对应测试的同引用断言锁定：把任一文案改一个字，测试保持绿。
