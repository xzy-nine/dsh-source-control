# AGENTS.md

本文件是本仓库对 agent 的常驻指令：只放每个会话都需要在上下文里的规则，每条一到三行，并链接它的正家。

## 分层

指令分三层，越具体越靠近代码。

| 层 | 位置 | 放什么 |
|---|---|---|
| 常驻指令 | 本文件与各子树 `AGENTS.md` | 每条会话都必须遵守的规则，一句话一条，链接理由 |
| 技能 | [.agents/skills/](.agents/skills/) | 按场景加载的工作流与判断标准，不常驻上下文 |
| 文档 | [docs/](docs/README.md) | 当前状态的可检索事实，按读者与层级拆分 |

一个事实只有一个家。别处只准链接，不准复述。

## 命令

```sh
pnpm install        # 安装依赖并构建（prepare 阶段同时安装 git 钩子）
pnpm run verify-all # 全部门禁
pnpm run test:docs  # 快速文档门禁
pnpm test           # pretest 跑 build 与重复门禁，再跑单元测试
```

## 正家

以下各处拥有各自的规则，本文件不重复，只链接：

| 主题 | 正家 |
|---|---|
| 文档层级、写作规则、预算、赘余清单 | [文档标准](docs/AGENTS.md) |
| 注释与散文的编辑判断 | [散文标准](.agents/skills/source-control-prose-standard/SKILL.md) |
| 文档分层、测试边界、工程约束、语言 | [工作约定](docs/实现/工作约定.md) |
| 源码目录职责、数据层与数据形状 | [代码结构](docs/实现/代码结构.md) |
| 构建、静态检查、提交钩子与测试 | [构建与测试](docs/实现/构建与测试.md) |

## 代码检索

本仓库有 CodeGraph 索引（`.codegraph/`，父目录 `E:\GitHubCode\02DSH` 亦有）。改动前先加载 `codegraph-usage` 技能，再用 `codegraph_explore` MCP 检索，不要用 `grep` / `rg` / 逐个 `Read` 重建结构。符号行号与调用关系来自索引，改完代码后查关系需先 `codegraph sync`。

## 校验

提交前按改动面选择最小充分证据，不要反射性地跑全量。

| 改动 | 最小证据 |
|---|---|
| 文档与目录页 | `pnpm run test:docs` |
| 门禁脚本 | 该脚本的单元测试，加一次故意违规的负向验证 |
| 源码 | `pnpm lint` 与 `pnpm test`；改公共契约再加 `pnpm typecheck` |

**新增门禁必须自证**：写一个非法用例，看它变红，再回退。
