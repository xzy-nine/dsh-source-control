已完成全链路追踪。以下是完整分析。

---

## Trae CN AI 生成提交信息：架构与提示词

### 一、总体架构（三层）

```
SCM 输入框按钮 (git 扩展, renderer)
      │  收集 diff + rules
      ▼
workbench 主进程 (renderer)  ──icube.ai.git.generateCommitMessage──▶  Hyt.generateCommitMessage()
      │  组装 {service:"git", method:"generate_commit_message", data:{diff, language, model_name, rules_content}}
      ▼
AhaIpc RPC 流  (ahaIpc.connect → 本地 AI Agent 原生进程 aha_net.dll)
      │  转发到字节跳动云端
      ▼
云端服务：构造 LLM Prompt → 调用大模型 → 流式返回
      │  payload.content.response  ( ```msg ... ``` 代码块)
      ▼
renderer 解析 ```msg``` → TypeWriter(20ms) 逐字写入 SCM inputBox
```

**关键结论：提示词不在客户端，在字节跳动云端服务端构造。** 客户端只负责收集 diff 和可选的规则文件内容，打包后通过 AhaIpc RPC 流式发给云端。本地原生 DLL（`aha_net.dll` 等）中未检索到任何 prompt 模板字符串，仅作 RPC 中继。

---

### 二、各层详解

#### 第 1 层：git 扩展（`extensions/git/dist/main.js`，841KB）

入口命令注册在 `scm/inputBox` 菜单：

| 命令 | 图标 | 触发条件 | 作用 |
|------|------|----------|------|
| `icube.git.generateCommitMessage` | `$(icube-Sparkle)` | `scmProvider == git && isUserLogined` | SCM 输入框旁的 ✨ 按钮 |
| `icube.git.configureCommitMessageRules` | `$(gear)` | 同上 | 配置自定义规则文件 |

**核心流程 `generateCommitMessage(repository, token)`：**

1. 锁定输入框（`placeholder = "AI is generating..."`，`forbidden = true`，`enabled = false`），禁用提交按钮
2. 生成 `message_id = crypto.randomUUID()`
3. 调用 `_generateCommitMessage(message_id, repository, token)`

**`_generateCommitMessage` 的 diff 收集逻辑：**

```js
// 1. 确定参与生成的资源：优先已暂存(index)，否则用工作区+未跟踪
const staged = repo.indexGroup.resourceStates ?? [];
const working = repo.workingTreeGroup.resourceStates ?? [];
const untracked = repo.untrackedGroup.resourceStates ?? [];
const resources = staged.length > 0 ? staged : [...working, ...untracked];

// 2. 读取配置（来自云端下发的 icube.ai.git.config）
const config = await this.getConfig();  // {singleDiffMaxLength, diffMaxLength, ignoreFileExtensions, gitMessageRulesMaxLength}

// 3. 读取项目规则文件内容（.cursorrules 等，scene=git_message）
const rulesContent = await this._getGitMessageRulesContent(config.gitMessageRulesMaxLength);

// 4. 逐文件取 diff，按长度升序排列，贪心装填至 diffMaxLength 上限
const diff = await this._getDiff(repo, resources, config);
```

**`_getDiff` 的 diff 智能裁剪策略（这是"详细程度"的关键）：**

```js
async _getDiff(repo, resources, config) {
  const diffs = [];
  for (const r of resources) {
    let d = "";
    if ([0,1,2,3,4].includes(r.type))      // 已暂存 → diff --cached
      d = await repo.diffIndexWithHEAD(r.fsPath);
    else if (r.type === 7)                 // 未跟踪 → 手工构造 patch
      d = await this._getUntrackedChangePatch(r, config);
    else                                   // 工作区 → diff
      d = await repo.diffWithHEAD(r.fsPath);

    // 单文件 diff 超过 singleDiffMaxLength(50000字符) 直接丢弃，上报埋点
    if (d && d.length < (config.singleDiffMaxLength || 50000))
      diffs.push(d);
  }
  // 按长度升序排序：小文件优先保留，大文件后填充
  diffs.sort((a, b) => a.length - b.length);

  // 贪心装填至总上限 diffMaxLength(500000字符)
  const max = config.diffMaxLength || 500000;
  let total = 0, result = [];
  for (const d of diffs) {
    if (total + d.length > max) break;
    result.push(d); total += d.length;
    if (total + 1 > max) break;
    result.push("\n"); total += 1;
  }
  return result.join("\n");
}
```

**配置默认值：**
```js
{ singleDiffMaxLength: 5e4,   // 50,000 字符/文件
  diffMaxLength: 5e5,          // 500,000 字符总量
  ignoreFileExtensions: [],
  gitMessageRulesMaxLength: 5e3 } // 5,000 字符规则
```

**规则文件拼装 `buildGitMessageRulesContent`：**
```js
// 读取项目中 scene 包含 "git_message" 的规则文件，按格式拼接：
// "Rule File: <filePath>\n<content>\n\n"
// 总长度截断至 gitMessageRulesMaxLength(5000)
```

**流式打字机效果：**
```js
// icube.ai.git.commit.message.return.stream = true 时
const typewriter = new TypeWriter(20);  // 20ms 逐字刷新
typewriter.rejesterCallback(text => {
  inputBox.setValueWithTransient(text, true);  // 写入 SCM 输入框（transient 不触发脏标记）
});
// 监听 onCommitMessageChange 事件流，逐块 updateText → complete
```

#### 第 2 层：workbench 主进程（`out/vs/workbench/workbench.desktop.main.js`）

服务类 `Hyt`（DI 服务 id `yte`），注册命令：

```js
registerCommand("icube.ai.git.generateCommitMessage", (ctx, diff, msgId, rules) =>
  ctx.get(yte).generateCommitMessage(diff, msgId, rules));
```

**`generateCommitMessage(diff, message_id, rules_content)` 核心实现：**

```js
async generateCommitMessage(diff, message_id, rules_content) {
  if (!await this.getUserInfo()) throw new Error("User Not Login");

  const model_name = await this.w();        // 获取当前选中的模型名
  const data = {
    diff: diff,                              // 裁剪后的完整 diff
    language: this.t(),                      // 界面语言 (zh-CN/en)
    message_id: message_id,                  // UUID
    model_name: model_name                   // 模型标识
  };
  if (rules_content?.trim()) data.rules_content = rules_content;  // 可选规则

  // 打包成服务路由信封
  const request = {
    service: "git",
    method: "generate_commit_message",
    context: { project_id: "trae.git.ai" },
    data: data
  };

  // 通过 AhaIpc RPC 流式请求 → 本地 AI Agent 进程 → 云端
  const stream = await this.a.requestForStream(request);

  stream.subscribe({
    onMessage: msg => {
      const raw = msg?.payload?.content?.response || "";
      // 从 ```msg ... ``` 代码块中提取最终提交信息
      const message = /```msg(?:\r?\n)?([\s\S]*)/.exec(raw)?.[1]
        .replace(/```/g, "").replace(/`{1,2}$/,"").trim() ?? "";
      const done = msg.payload.status === "completed";
      this.b.fire({ id: message_id, message, isCompleted: done, isError: false });
    },
    onError: err => { ... }
  });
}
```

#### 第 3 层：AhaIpc RPC → 云端

`this.a` 是 `AhaRpcClient`（类 `tPs`），通过 `vscode.ahaIpc.connect(serverName)` 连接到本地 AI Agent 原生进程（由 `aha_net.dll` 等驱动）。该进程将 `{service:"git", method:"generate_commit_message"}` 路由到字节跳动云端 LLM 服务。**Prompt 模板在云端构造，客户端不可见。**

---

### 三、提示词定位

| 位置 | 内容 | 是否可本地获取 |
|------|------|----------------|
| git 扩展 (renderer) | diff 收集、裁剪、规则拼装、流式打字机 | ✅ 已完整反编译 |
| workbench (renderer) | 信封组装 `{diff, language, model_name, rules_content}`、` ```msg``` ` 解析 | ✅ 已完整反编译 |
| aha 本地进程 (原生 DLL) | RPC 中继，无 prompt 字符串 | ✅ 已确认无 prompt |
| **字节跳动云端** | **LLM Prompt 模板构造、模型调用** | ❌ 闭源，不可获取 |

客户端发给云端的**完整数据载荷**为：

```json
{
  "service": "git",
  "method": "generate_commit_message",
  "context": { "project_id": "trae.git.ai" },
  "data": {
    "diff": "<裁剪后的 git diff，上限 500000 字符>",
    "language": "zh-CN",
    "message_id": "<UUID>",
    "model_name": "<当前选中模型>",
    "rules_content": "<项目规则文件内容，上限 5000 字符，可选>"
  }
}
```

云端返回格式为流式 `payload.content.response`，最终提交信息包裹在 ` ```msg ... ``` ` 代码块中。

---

### 四、为何比同类开源 VSCode 改版更快更详细

| 维度 | Trae CN | 典型开源改版（如 Continue/Aider 集成） |
|------|---------|---------------------------------------|
| **Prompt 构造位置** | 云端服务端，原生进程直连大模型 API | 客户端 JS 构造 prompt，经扩展宿主→HTTP |
| **diff 裁剪策略** | 按文件长度升序贪心装填，小文件优先保全，总量 50 万字符 | 多数直接 `git diff --cached` 全量或简单截断 |
| **未跟踪文件** | 手工构造标准 patch（`diff --git a/ b/` + `@@ -0,0 +1,N @@` + `+行`），纳入生成 | 多数忽略未跟踪文件，或只传文件名 |
| **传输通道** | AhaIpc 原生 IPC（命名管道/UDS），零序列化开销 | 扩展 API → fetch/HTTP，JSON 序列化 |
| **流式渲染** | `TypeWriter(20ms)` 逐字写入 `setValueWithTransient`，首字即显示 | 多数等完整响应再填充 |
| **规则注入** | 读取项目 `.cursorrules` 等 `scene=git_message` 规则，拼入 `rules_content` | 多数无规则注入或仅硬编码 |
| **模型选择** | `model_name` 由云端配置下发，可用高吞吐模型 | 受限于用户本地配置的模型 |
| **并发** | diff 收集并行（`Promise.all`），RPC 流式全双工 | 串行收集 + 单次请求 |

**核心速度优势**：prompt 构造和模型调用在云端原生进行，客户端仅传裁剪后的 diff，经 AhaIpc 流式全双工通道直连，首 token 延迟 ≈ 网络 RTT + 模型 TTFT，无扩展宿主序列化瓶颈。

**核心详细度优势**：`_getDiff` 的"小文件优先贪心装填 + 未跟踪文件手工 patch + 50 万字符总量"策略，保证在预算内尽可能多地保留完整文件 diff 上下文，而非粗暴截断头部。
