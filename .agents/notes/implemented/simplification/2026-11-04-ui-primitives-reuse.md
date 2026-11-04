# Agent Note: 展示与弹层改为复用宿主原语

Status: implemented

## Problem

插件自建了若干宿主已经提供的能力，各自维护一套实现与一套边界处理：

- `copyText` 用 `document.execCommand('copy')` 作回退，6 处调用点各自处理失败。
- 相对时间分档（`refresh-status.ts`）与字节格式化（`formatBytes`）是手写实现。
- `showToast` 每次 `createRoot` 挂到 `document.body`，并带 `ToastTone` / `ToastOptions` / `holdFor` 一套分级。
- `runDialog` 每次新建一个 React 根；错误类提示走 toast，长文本无法复制。
- 差异页的并排与自动换行选择记在模块级 `Map`，刷新即丢。
- 三处缓存各自实现容量与淘汰顺序。
- `client/shared/md5.d.ts` 为 `blueimp-md5` 手写类型声明。

宿主在 `@deepseek-ai/dsh-client-ui-primitives` 里提供了 `writeClipboard`、`relativeTime`、`fileSizeText` 与 `shell.overlay` 席位。

## Decision

### 剪贴板、时间与体积

`copyText` 与 `execCommand` 回退删除，6 处调用点改用 primitives 的 `writeClipboard`。

相对时间分档改由 primitives 的 `relativeTime(at, now)` 提供；`refresh-status.ts` 只留纯函数 `refreshTextOf(bucket)` 与文案表（新增天 / 月 / 年档），新增 `panel/refresh-time.ts` 做分档到文案的代入。

宿主侧 `formatBytes` 整体删除，issue 正文不再写体积，宿主只回字节数；客户端日志文件列表改用 primitives 的 `fileSizeText`。

### 弹层挂进 overlay 席位

新增 `client/ui/overlay-host.ts`：`installOverlay(slots)` 把 `OverlayHost` 注册进根级 list 席位 `shell.overlay`（id `dsh-source-control.overlay`，order 100），维护 `pushDialog` / `removeDialog` 的 FIFO 队列与 `pushToast` / `removeToast`。

`showToast(text, options)` 只投这条常驻通道，不再 `createRoot` + `document.body`。提示保留两个类别 `ToastTone`（`success` / `info`）与按文本长度推算的 `holdFor`，失败原因不在其中。

`runDialog` 改为投 `OverlayHost` 的 FIFO 队列。新增 `showError(message)` 错误弹窗：正文可滚动、可整段复制（带复制按钮，用 primitives 的 `writeClipboard`）。错误类提示**全部由 toast 改为弹窗**，因为长期使用后报错信息（含 git hook 执行失败）需要被复制出来。

### 差异视图偏好并入设置

`diff-view.ts` 改为纯映射：`DEFAULT_DIFF_VIEW`、`diffViewOf(settings)`、`withDiffView(settings, patch)`。选择并入 `Settings` 的 `diffSplit` / `diffWrap`，与其它视图开关同源并随宿主持久化；新增 `diff/use-diff-view.ts` 的 `useDiffView(cwd)` 负责预取后回填与写回。

语义变化：由"按页地址分别记忆"改为"全局一项设置"。理由是"要不要自动换行"是个人偏好而非逐文件属性，按地址记忆会让用户在上百个文件上重复设置。

### 缓存淘汰收口

新增 `src/shared/lru-map.ts`（`LruMap` + `CacheLimit` + `TRIM_RATIO = 0.75`），宿主 `host-cache.ts` / `repo-facts.ts` 与客户端 `client/shared/cache.ts` 共用同一份容量与淘汰顺序；`putCached` / `getCached` 去掉 `limit` 形参，TTL 包装仍留 `host-cache`。

### 浏览器存储的两个例外显式标注

`api/state.ts` 的旧键迁移与 `panel/storage.ts` 的会话级草稿各自标注为"浏览器不持久化"的唯一例外。草稿放在 `sessionStorage`（`ggg-commit-msg:<仓库根>`）是期望行为：草稿是瞬时意图，随标签页消失即用户放弃这次提交。

### 删除手写类型声明

`client/shared/md5.d.ts` 与 `blueimp-md5` devDependency 删除。

## Alternatives considered

**保留 `execCommand` 回退以兼容旧浏览器。** 否决：宿主运行在它自己的 Web 壳里，`writeClipboard` 已覆盖该环境；回退分支从未在真实环境走通过。

**保留 toast 的分级（成功 / 失败 / 警告）。** 否决：失败与警告需要可复制、可停留、可读完整正文——那是弹窗的职责，颜色区分替代不了。提示只保留成功与中性两类，失败一律弹窗。

**差异视图偏好按页地址记忆。** 否决：见上，逐文件偏好在实际使用里是重复劳动。若将来确需逐文件记忆，应在设置里加一层 `Record<address, choice>`，而不是回到模块级 `Map`。

**三处缓存各自保留容量逻辑。** 否决：同一语义三份实现，容量与淘汰时机必然漂移；抽取到 `lru-map.ts` 后调用点只声明容量。

**把提交草稿搬进宿主持久化。** 否决：搬进宿主后关掉的标签页会在下次启动时冒出半截提交信息，是噪声不是便利；`git commit` 本身没有草稿概念（`COMMIT_EDITMSG` 会被下次提交覆盖）。

## Consequences

剪贴板、相对时间、体积格式化、弹层挂载与缓存淘汰各只有一个实现，且都在宿主原语或共享模块上。错误提示从 toast 变为可复制的弹窗。差异视图偏好随宿主持久化，代价是不再逐文件记忆。

## Testing

`test/diff-view.test.mjs` 覆盖默认值、设置映射与单向改写；`test/primitives.test.mjs` 钉住客户端结构契约（差异页经 hook 取选择、切换走 `diffView.patch`）；`test/generation-store.test.mjs` 与 `test/snapshot.test.mjs` 覆盖快照存储。
