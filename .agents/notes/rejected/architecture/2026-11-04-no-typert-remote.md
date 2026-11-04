# Agent Note: 不把命令通道迁到 Typert Remote

Status: rejected — 需要改变仓库为 packages/ 多包结构并让构建期依赖 DSH 检出，而第三方插件生态零先例

## Problem

插件与面板之间走自建通道：`/dsh-source-control/gg/api` 上一条命令分派（103 条 `case` 分支）、手写 JSON 请求体、`/gg/events` 的 SSE 广播，以及客户端自写的 fetch 传输与并发合并。宿主的 Typert Remote 提供生成式类型契约、协作式取消、`RemoteError` 码表、logical stream 与 generation 重连，看似是这些内容的正主。

## Proposal

把 103 条命令逐条改为 `@Remote` 方法，事件流改为 `TypertRemoteEvent`，客户端改调 `ctx.remote.<namespace>.<method>`，然后删除自建的路径分派、SSE 与 HTTP 适配层。预计 10–15 个工作日，分六阶段：生成管线验证、仓库结构改造、单命令试点、按域批量迁移、事件流迁移、清理。

## Alternatives considered

**已评估并否决：迁到 Typert Remote。** 先用探针实测了官方生成管线，确认技术可行但代价超出收益。

生成器的硬性前置条件（逐条实测确认）：

- 仓库根须同时有 `tsconfig.host.json` 与 `packages/`（`findWorkspaceRoot`）。
- 包必须物理位于 `<root>/packages/` 下——`analyzer.ts` 用 `isWithin(packageRoot, join(root, 'packages'))` 过滤，独立 aggregate 指向别处时注册为空。
- 根 `tsconfig.host.json` 的 `references` 必须列出该包；生成器不扫描目录，只读 references。
- 包内源码必须在 `<packageRoot>/src/` 下（`index.ts` 放在包根不进分析）。
- 服务要在 `declare module '@deepseek-ai/cordis' { interface Context { … } }` 里声明，否则包表面为空、生成返回空数组。
- `TypertRemoteService` 的符号解析要求 `@deepseek-ai/dsh-typert-protocol` 是**已注册的 workspace 包**（`isTypeMetaSymbol` 检查声明文件所属包名）。这一条决定构建期必须能解析到 protocol 的源码，即插件无法脱离 DSH 检出独立构建。

另有一处运行障碍：在 DSH 工作区里跑 `generate()` 会分析全部 138 个包，其中 `@deepseek-ai/dsh-client-ui-theme` 的导出指向一个缺失的 CSS 文件，直接让生成失败；`WorkspaceAnalyzer` 的 `packages` 收窄可规避，但 `WorkspaceTypertGenerator.generate()` 没有暴露该收窄。

生态上的反向证据更强：父目录 9 个成熟第三方插件**全部**没有 `./typert` 或 `./remote` 导出，零使用 Typert。`DSH-better-sidebar` 的记录显示它曾自建 `remoteView` / `remoteCreateTask` / `remoteUpdateTask` 三件套，后来放弃，把读路径改成消费宿主已有的 `agentTeam` projection。第三方插件的通行做法是自开 HTTP / WebSocket 路由（`DSH-better-sidebar` 46 处 `new WebSocket`、`dsh-im-connect` 17 处、`dsh-superagent-prototype` 用 `webServer.register` 的 prefix 路由），与本插件现状一致。

`ctx.remote` 的定位也是消费宿主已有 namespace（如 `ctx.remote.session`）的只读接口，不是插件自建端点的注册面；官方 `@deepseek-ai/dsh-api-remotes` 的 `client/index.ts` 硬编码了三十余个包的 `/remote` 导入，第三方无法注册自己的贡献，只能自调 `ctx.remote.$mount()`，而 `descriptors` 仍须由官方生成器产出。

**保留自建通道并继续维护。** 采纳。自建通道当前工作正常（103 条命令、780 个测试全绿），且与第三方插件的通行做法一致。

**只迁移一小部分命令作为试点。** 否决：生成管线的六项前置条件是为整个仓库服务的，试点无法绕开仓库结构改造成本；试点通过后仍要承担剩余工作量，前置成本不变。

## Consequences

命令通道维持自建：`routes.ts` 的路径分派、`api/http.ts` 的请求体与合并键、`api/events.ts` 的 SSE，以及客户端的 `api/http.ts` / `api/stream.ts`。

放弃的能力：生成式类型契约（现为手写 JSON 形状）、`RemoteError` 码表（现为 `{ error: string }` 约定）、Gateway 的 generation 重连（现为自写重连）、以及 Remote 层的访问控制。

若将来重新考虑，前置条件是：仓库已改为 `packages/` 多包结构、构建期可依赖 DSH 检出、且官方 `api-remotes` 开放第三方贡献注册。
